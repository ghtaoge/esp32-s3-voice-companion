from __future__ import annotations

import json
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]


@dataclass(slots=True)
class Config:
    root: Path = PROJECT_ROOT
    host: str = "0.0.0.0"
    port: int = 8765
    token: str = ""
    asr_threads: int = 3
    emotion_enabled: bool = True
    emotion_max_seconds: int = 12
    max_recording_seconds: int = 60
    max_devices: int = 4
    max_clients: int = 8
    audio_queue_frames: int = 64
    peer_queue_messages: int = 48
    history_limit: int = 50
    settings_timeout_seconds: float = 8.0
    idle_audio_timeout_seconds: float = 10.0
    allowed_devices: set[str] = field(default_factory=lambda: {"esp32-s3"})

    @property
    def model_root(self) -> Path:
        return self.root / "models"

    @property
    def local_dir(self) -> Path:
        return self.root / ".local"

    def ensure_token(self) -> None:
        if self.token:
            if len(self.token) < 16:
                raise ValueError("配对口令至少16字符")
            return
        self.local_dir.mkdir(parents=True, exist_ok=True)
        path = self.local_dir / "pairing-token.txt"
        try:
            with path.open("x", encoding="utf-8") as file:
                self.token = secrets.token_urlsafe(24)
                file.write(self.token + "\n")
            if os.name != "nt":
                path.chmod(0o600)
        except FileExistsError:
            self.token = path.read_text(encoding="utf-8").strip()
        if len(self.token) < 16:
            raise ValueError(f"无效配对口令文件：{path.name}")

    def public_health(self, ready: bool, emotion: str, error: str | None) -> dict:
        return {
            "ready": ready,
            "asr": "funasr-onnx/paraformer-streaming-int8",
            "segmentation": "fsmn-vad",
            "punctuation": "ct-transformer",
            "emotion": emotion,
            "sample_rate": 16000,
            "error": error,
        }


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))
