"""Real local models + gateway + two WebSocket subscribers; no physical hardware.

Requires the dev dependencies. Uses a real WAV, not a fake recognizer. The board
connection is a software protocol client; this does not validate the microphone.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def main():
    import numpy as np
    import soundfile as sf
    from fastapi.testclient import TestClient
    from voice_companion.config import Config
    from voice_companion.service import create_app

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / ".local/gateway-validation.json")
    parser.add_argument("--double", action="store_true", help="Insert a 1-second pause then repeat, checking segmentation while PTT stays held")
    args = parser.parse_args()
    audio, rate = sf.read(args.wav, dtype="int16")
    if rate != 16000 or audio.ndim != 1:
        raise ValueError("Use 16kHz mono WAV")
    if args.double:
        audio = np.concatenate((audio, np.zeros(16000, dtype="int16"), audio))
    pcm = audio.astype("<i2").tobytes()
    config = Config()
    config.ensure_token()
    recording_id = "verify-" + uuid.uuid4().hex
    app = create_app(config)
    def until(ws, kind):
        for _ in range(80):
            event = ws.receive_json()
            if event["type"] == "error":
                raise RuntimeError(event)
            if event["type"] == kind:
                return event
        raise AssertionError(f"Missing {kind}")
    with TestClient(app) as client:
        assert client.get("/api/health").json()["ready"], "ASR failed to warm up"
        path = f"/ws/{{role}}/esp32-s3?token={config.token}"
        with client.websocket_connect(path.format(role="client")) as phone, client.websocket_connect(path.format(role="device")) as board:
            until(phone, "snapshot")
            until(board, "snapshot")
            phone.send_json({"type": "settings_set", "request_id": "verify-settings", "settings": {"font_scale": 2}})
            settings = until(board, "settings_set")
            board.send_json({"type": "settings_ack", "request_id": settings["request_id"], "settings": settings["settings"]})
            assert until(phone, "settings_applied")["settings"]["font_scale"] == 2
            board.send_json({"type": "record_start", "recording_id": recording_id})
            until(board, "record_ready")
            started = time.perf_counter()
            sender_errors = []
            released_at = [None]
            def send():
                try:
                    for position in range(0, len(pcm), 640):
                        board.send_bytes(pcm[position:position+640])
                        target = started + min(position+640, len(pcm))/32000
                        time.sleep(max(0, target-time.perf_counter()))
                    released_at[0] = time.perf_counter()
                    board.send_json({"type": "record_stop", "recording_id": recording_id})
                except Exception as exc:
                    sender_errors.append(type(exc).__name__)
            sender = threading.Thread(target=send, daemon=True)
            sender.start()
            final, emotions, first_ms, event_count = {}, {}, None, 0
            while True:
                event = board.receive_json()
                event_count += 1
                if event["type"] == "error":
                    raise RuntimeError(event)
                if event["type"] == "transcript":
                    if first_ms is None:
                        first_ms = (time.perf_counter()-started)*1000
                    if event["final"]:
                        final[event["segment_id"]] = event
                if event["type"] == "emotion":
                    emotions[event["segment_id"]] = event
                if event["type"] == "recording_done":
                    done = event
                    break
            sender.join(timeout=2)
            assert not sender.is_alive() and not sender_errors
            assert final and (not args.double or len(final) >= 2), "Expected real segmented recognition"
            phone.send_json({"type": "history_get"})
            snapshot = until(phone, "snapshot")
            phone_final = {e["segment_id"]: e for e in snapshot["history"] if e["recording_id"] == recording_id}
            assert {k: e["text"] for k,e in final.items()} == {k:e["text"] for k,e in phone_final.items()}
            assert snapshot["state"] == "idle" and done["segments"] == len(final)
            while len(emotions) < len(final):
                event = board.receive_json()
                if event["type"] == "emotion" and event.get("recording_id") == recording_id:
                    emotions[event["segment_id"]] = event
            report = {
                "source": "real-local-onnx-models/software-board-client", "audio_ms": len(pcm)/32,
                "first_caption_ms": round(first_ms, 1), "release_to_final_ms": done["final_latency_ms"],
                "segments": len(final), "text": [final[key]["text"] for key in sorted(final)],
                "emotions": [{k:v for k,v in emotions[key].items() if k in ("label","event","status","raw_tags")} for key in sorted(emotions)],
                "same_final_on_both_clients": True, "settings_ack_verified": True,
                "event_count": event_count,
            }
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2)+"\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
