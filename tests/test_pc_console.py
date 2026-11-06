"""Real HTTP boundary checks for the independent, model-free PC process."""
import importlib.util
from pathlib import Path

from fastapi.testclient import TestClient


SOURCE = Path(__file__).resolve().parents[1] / "pc-console" / "server.py"
spec = importlib.util.spec_from_file_location("pc_console_server", SOURCE)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)
TOKEN = "test-only-local-console-token-0000"


def application(tmp_path, monkeypatch):
    (tmp_path / ".local").mkdir()
    (tmp_path / ".local" / "pairing-token.txt").write_text(TOKEN, encoding="utf-8")
    monkeypatch.setattr(server, "local_addresses", lambda: ["192.168.10.2"])
    return server.create_app(root=tmp_path)


def local_client(app):
    return TestClient(app, base_url="http://127.0.0.1:8766", client=("127.0.0.1", 50000))


def test_local_bootstrap_and_qr_do_not_rotate_board_token(tmp_path, monkeypatch):
    with local_client(application(tmp_path, monkeypatch)) as client:
        result = client.get("/api/console")
        assert result.status_code == 200
        assert result.headers["cache-control"] == "no-store"
        assert result.json()["url"] == "ws://127.0.0.1:8765"
        assert result.json()["token"] == TOKEN
        assert result.json()["advertise"] == "192.168.10.2"
        image = client.get("/api/pairing/qr?address=192.168.10.2")
        assert image.headers["content-type"] == "image/png"
        assert image.content.startswith(b"\x89PNG\r\n\x1a\n")
        assert image.content == client.get("/api/pairing/qr?address=192.168.10.2").content
        assert client.get("/api/pairing/qr?address=8.8.8.8").status_code == 400
        assert client.get("/api/pairing/qr?device_id=other").status_code == 400
    assert (tmp_path / ".local" / "pairing-token.txt").read_text() == TOKEN


def test_pairing_not_available_to_remote_peers_or_origins(tmp_path, monkeypatch):
    app = application(tmp_path, monkeypatch)
    with local_client(app) as client:
        for headers in ({"Origin": "https://unrelated.example"}, {"Host": "unrelated.example:8766"}, {"Sec-Fetch-Site": "cross-site"}):
            response = client.get("/api/console", headers=headers)
            assert response.status_code == 403 and TOKEN not in response.text
    with TestClient(app, base_url="http://127.0.0.1:8766", client=("192.168.10.20", 50000)) as client:
        response = client.get("/api/console")
        assert response.status_code == 403 and TOKEN not in response.text


def test_console_remains_available_without_asr(tmp_path, monkeypatch):
    app = application(tmp_path, monkeypatch)
    def unavailable(_):
        raise OSError("test ASR is stopped")
    monkeypatch.setattr(server, "fetch_health", unavailable)
    with local_client(app) as client:
        assert client.get("/api/console").status_code == 200
        response = client.get("/api/health")
        assert response.status_code == 503 and response.json()["ready"] is False
        assert "test ASR" not in response.text
        assert client.get("/assets/server.py").status_code == 404


def test_health_reflects_separate_asr_service(tmp_path, monkeypatch):
    app = application(tmp_path, monkeypatch)
    monkeypatch.setattr(server, "fetch_health", lambda url: {"ready": True, "emotion": "ready"})
    with local_client(app) as client:
        assert client.get("/api/health").json() == {"ready": True, "emotion": "ready"}


def test_default_uses_existing_board_address_and_explicit_host_can_override(tmp_path, monkeypatch):
    import json
    application(tmp_path, monkeypatch)
    (tmp_path / ".local" / "pairing.json").write_text(json.dumps({"url": "ws://192.168.10.2:8765"}), encoding="utf-8")
    with local_client(server.create_app(root=tmp_path)) as client:
        assert client.get("/api/console").json()["url"] == "ws://192.168.10.2:8765"
    with local_client(server.create_app(root=tmp_path, asr_host="127.0.0.1")) as client:
        assert client.get("/api/console").json()["url"] == "ws://127.0.0.1:8765"
