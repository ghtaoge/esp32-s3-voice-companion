from __future__ import annotations

import argparse
import ipaddress
import json
import logging
import multiprocessing
import os
import socket
from pathlib import Path

from .config import Config, PROJECT_ROOT
from .protocol import DEVICE_ID


def local_addresses() -> list[str]:
    import psutil
    addresses = []
    for values in psutil.net_if_addrs().values():
        for item in values:
            if item.family == socket.AF_INET:
                address = ipaddress.ip_address(item.address)
                if address.is_private and not address.is_loopback and not address.is_link_local:
                    addresses.append(item.address)
    return sorted(set(addresses), key=lambda value: (not value.startswith("192.168."), value))


def pair(config: Config, device_id: str, advertise: str | None) -> None:
    import qrcode
    from qrcode.image.pure import PyPNGImage

    if not DEVICE_ID.fullmatch(device_id):
        raise ValueError("device-id只允许1..40个字母、数字、下划线或短横线")
    addresses = local_addresses()
    address = advertise or (addresses[0] if addresses else "127.0.0.1")
    ipaddress.IPv4Address(address)
    config.ensure_token()
    config.local_dir.mkdir(parents=True, exist_ok=True)
    content = {"url": f"ws://{address}:{config.port}", "device_id": device_id, "token": config.token}
    path = config.local_dir / "pairing.json"
    path.write_text(json.dumps(content, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    image_path = config.local_dir / "pairing.png"
    with image_path.open("wb") as stream:
        qrcode.make(json.dumps(content, ensure_ascii=False), image_factory=PyPNGImage, box_size=8, border=4).save(stream)
    print(f"本机地址候选：{', '.join(addresses) or '未检测到局域网地址'}")
    print(f"连接地址：{content['url']}，设备：{device_id}")
    print(f"配对文件：{path}\n配对二维码：{image_path}")
    print("请在电脑打开二维码供小程序扫描；口令位于本地配对文件，不会提交到Git。")


def main() -> None:
    multiprocessing.freeze_support()
    parser = argparse.ArgumentParser(description="ESP32-S3 本地语音字幕服务")
    parser.add_argument("command", choices=("serve", "pair"), nargs="?", default="serve")
    parser.add_argument("--root", type=Path, default=PROJECT_ROOT)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--device-id", default="esp32-s3")
    parser.add_argument("--asr-threads", type=int, choices=range(1, 9), default=3)
    parser.add_argument("--no-emotion", action="store_true", help="仅运行字幕，关闭独立情绪进程")
    parser.add_argument("--advertise", help="配对二维码中电脑的局域网IPv4地址")
    args = parser.parse_args()
    if not DEVICE_ID.fullmatch(args.device_id) or not 1 <= args.port <= 65535:
        parser.error("device-id或端口无效")
    config = Config(root=args.root.resolve(), host=args.host, port=args.port, asr_threads=args.asr_threads,
                    emotion_enabled=not args.no_emotion, allowed_devices={args.device_id})
    config.ensure_token()
    if args.command == "pair":
        pair(config, args.device_id, args.advertise)
        return
    cache_dir = config.local_dir / "numba-cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("NUMBA_CACHE_DIR", str(cache_dir))
    import uvicorn
    from .service import create_app
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    print("模型首次加载和预热完成后 health.ready 才会为 true。Ctrl+C停止服务。")
    print("配对二维码请另运行：voice-companion pair --advertise 电脑局域网IP")
    uvicorn.run(create_app(config), host=config.host, port=config.port, access_log=False,
                ws="websockets", ws_max_size=8192, ws_max_queue=8,
                ws_per_message_deflate=False, ws_ping_interval=15, ws_ping_timeout=15,
                log_level="warning")


if __name__ == "__main__":
    main()
