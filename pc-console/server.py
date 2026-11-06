"""Independent, loopback-only PC console. Never loads or starts an ASR model."""
from __future__ import annotations

import argparse
import io
import ipaddress
import json
import re
from functools import lru_cache
from pathlib import Path
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, Response


ROOT = Path(__file__).resolve().parents[1]
ASSETS = Path(__file__).resolve().parent
DEVICE_ID = re.compile(r"[A-Za-z0-9_-]{1,40}\Z")


def local_addresses() -> list[str]:
    import psutil
    import socket

    stats = psutil.net_if_stats()
    addresses = set()
    for name, values in psutil.net_if_addrs().items():
        if name in stats and not stats[name].isup:
            continue
        for value in values:
            if value.family == socket.AF_INET:
                address = ipaddress.IPv4Address(value.address)
                if address.is_private and not address.is_loopback and not address.is_link_local:
                    addresses.add(str(address))
    return sorted(addresses, key=lambda value: (not value.startswith("192.168."), value))


def asr_address(value: str) -> str:
    if value == "localhost":
        return value
    address = ipaddress.IPv4Address(value)
    if not address.is_private or address.is_unspecified or address.is_link_local:
        raise ValueError("ASR地址应为本机或局域网IPv4")
    return str(address)


def fetch_health(url: str) -> dict:
    # Ignore system HTTP proxy for this local service; bound both wait and body.
    with build_opener(ProxyHandler({})).open(url, timeout=1.5) as response:
        content = response.read(16385)
    if len(content) > 16384:
        raise ValueError("health response too large")
    data = json.loads(content)
    if not isinstance(data, dict):
        raise ValueError("invalid health response")
    return {key: data[key] for key in ("ready", "asr", "segmentation", "punctuation", "emotion", "sample_rate", "error") if key in data}


def create_app(*, root: Path = ROOT, asr_host: str | None = None, asr_port: int = 8765,
               port: int = 8766, device_id: str = "esp32-s3", advertise: str | None = None) -> FastAPI:
    root = root.resolve()
    if not DEVICE_ID.fullmatch(device_id) or not (1 <= asr_port <= 65535 and 1 <= port <= 65535):
        raise ValueError("设备标识或端口无效")
    token_path = root / ".local" / "pairing-token.txt"
    try:
        token = token_path.read_text(encoding="utf-8").strip()
    except FileNotFoundError as exc:
        raise ValueError("请先启动ASR服务或运行pair命令以生成本地配对口令") from exc
    if not 16 <= len(token) <= 128:
        raise ValueError("本地配对口令文件无效")
    addresses = local_addresses()
    try:
        pairing = json.loads((root / ".local" / "pairing.json").read_text(encoding="utf-8"))
        previous = urlsplit(pairing.get("url", "")).hostname
    except (OSError, ValueError, AttributeError):
        previous = None
    # Reuse the board's existing local address. On Windows, a different
    # loopback-only server can otherwise shadow an ASR bound to 0.0.0.0.
    asr_host = asr_address(asr_host or (previous if previous in addresses else "127.0.0.1"))
    if port == asr_port and asr_host in ("localhost", "127.0.0.1"):
        raise ValueError("PC页面与ASR服务须使用不同端口")
    if advertise:
        advertise = str(ipaddress.IPv4Address(advertise))
        if advertise not in addresses and advertise != "127.0.0.1":
            raise ValueError("配对地址不是当前电脑的局域网地址")
    else:
        # Preserve the address already flashed into the board when still valid.
        advertise = previous if previous in addresses else (addresses[0] if addresses else "127.0.0.1")
    ws_url = f"ws://{asr_host}:{asr_port}"
    health_url = f"http://{asr_host}:{asr_port}/api/health"
    app = FastAPI(title="Voice Companion PC Console", docs_url=None, redoc_url=None, openapi_url=None)
    app.state.asr_url = ws_url

    @app.middleware("http")
    async def local_only(request: Request, call_next):
        # A remote page must not retrieve the pairing token via DNS rebinding.
        try:
            peer_is_local = bool(request.client and ipaddress.ip_address(request.client.host).is_loopback)
            hostname = request.url.hostname
            host_is_local = hostname in ("localhost", "127.0.0.1", "::1")
            host_port = request.url.port or 80
            origin = request.headers.get("origin")
            same_origin = not origin or origin == str(request.base_url).rstrip("/")
            fetch_site = request.headers.get("sec-fetch-site", "none")
        except ValueError:
            peer_is_local = host_is_local = same_origin = False
            host_port, fetch_site = 0, "cross-site"
        if not peer_is_local or not host_is_local or host_port != port or not same_origin or fetch_site == "cross-site":
            return JSONResponse({"error": "请从本机PC控制台访问"}, status_code=403)
        response = await call_next(request)
        response.headers.update({
            "Cache-Control": "no-store",
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Content-Security-Policy": f"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self' {ws_url}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        })
        return response

    @app.get("/")
    def index():
        return FileResponse(ASSETS / "index.html", media_type="text/html")

    @app.get("/favicon.ico")
    def favicon():
        return Response(status_code=204)

    @app.get("/assets/{filename}")
    def asset(filename: str):
        paths = {
            "app.js": ASSETS / "app.js", "core.js": ASSETS / "core.js",
            "styles.css": ASSETS / "styles.css",
            "protocol.js": root / "miniprogram" / "utils" / "protocol.js",
            "emotion-cues.js": root / "miniprogram" / "utils" / "emotion-cues.js",
        }
        path = paths.get(filename)
        if path is None or not path.is_file():
            raise HTTPException(404)
        return FileResponse(path, media_type="text/css" if filename.endswith(".css") else "text/javascript")

    @app.get("/api/console")
    def bootstrap():
        return {"url": ws_url, "device_id": device_id, "token": token,
                "addresses": addresses, "advertise": advertise, "port": asr_port}

    @app.get("/api/health")
    def health():
        try:
            return fetch_health(health_url)
        except (OSError, ValueError, TypeError):
            return JSONResponse({"ready": False, "emotion": "unavailable", "error": "ASR服务未连接，请单独启动ASR服务"}, status_code=503)

    @lru_cache(maxsize=8)
    def qr_png(address: str) -> bytes:
        import qrcode
        from qrcode.image.pure import PyPNGImage

        data = {"url": f"ws://{address}:{asr_port}", "device_id": device_id, "token": token}
        image = qrcode.make(json.dumps(data, ensure_ascii=False), image_factory=PyPNGImage, box_size=6, border=4)
        stream = io.BytesIO()
        image.save(stream)
        return stream.getvalue()

    @app.get("/api/pairing/qr")
    def pairing_qr(address: str | None = None, device_id: str = device_id):
        address = address or advertise
        if device_id != bootstrap()["device_id"] or address not in set(addresses) | {"127.0.0.1"}:
            raise HTTPException(400, "请使用当前电脑的地址与设备标识")
        return Response(qr_png(address), media_type="image/png")

    return app


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--port", type=int, default=8766, help="PC控制台端口")
    parser.add_argument("--asr-host", help="默认沿用已有配对文件中的本机局域网地址；无配对文件时用127.0.0.1")
    parser.add_argument("--asr-port", type=int, default=8765)
    parser.add_argument("--device-id", default="esp32-s3")
    parser.add_argument("--advertise", help="二维码里的电脑局域网IPv4")
    args = parser.parse_args()
    try:
        app = create_app(root=args.root, asr_host=args.asr_host, asr_port=args.asr_port,
                         port=args.port, device_id=args.device_id, advertise=args.advertise)
    except (OSError, ValueError) as exc:
        parser.error(str(exc))
    import uvicorn

    print(f"PC控制台：http://127.0.0.1:{args.port} （独立进程，不加载识别模型）", flush=True)
    print(f"连接ASR：{app.state.asr_url}；关闭此页面服务不会停止ASR。", flush=True)
    uvicorn.run(app, host="127.0.0.1", port=args.port, access_log=False, log_level="warning")


if __name__ == "__main__":
    main()
