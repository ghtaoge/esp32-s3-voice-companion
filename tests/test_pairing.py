import json

from voice_companion.cli import pair
from voice_companion.config import Config


def test_pairing_creates_real_png_and_private_json(tmp_path, capsys):
    config = Config(root=tmp_path)
    pair(config, "esp32-s3", "192.168.1.100")
    contents = json.loads((tmp_path / ".local/pairing.json").read_text(encoding="utf-8"))
    assert contents == {"url": "ws://192.168.1.100:8765", "device_id": "esp32-s3", "token": config.token}
    assert len(config.token) >= 24
    assert (tmp_path / ".local/pairing.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n")
    assert config.token not in capsys.readouterr().out
