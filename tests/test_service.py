"""Contract tests use explicit test doubles; production has no fake ASR mode."""
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from voice_companion.config import Config
from voice_companion.inference import Batch
from voice_companion.protocol import DisplaySettings
from voice_companion.service import create_app


TOKEN = "test-only-pairing-token-00000000"


class TestSession:
    __test__ = False
    def __init__(self):
        self.audio_ms = 0
        self.segment_id = 0
        self.first_partial_ms = None
        self.inference_ms = 1.0
        self.calls = []

    def feed(self, pcm, final=False):
        self.calls.append((pcm, final))
        self.audio_ms += len(pcm) // 32
        events = []
        if pcm and self.first_partial_ms is None:
            self.first_partial_ms = 1.0
            events = [{"type": "transcript", "segment_id": 0, "revision": 1, "text": "你好", "final": False, "start_ms": 0, "end_ms": self.audio_ms}]
        if final and self.audio_ms:
            self.segment_id = 1
            events = [{"type": "transcript", "segment_id": 0, "revision": 2, "text": "你好，世界。", "final": True, "start_ms": 0, "end_ms": self.audio_ms}]
        return Batch(events, [])


class TestEngine:
    __test__ = False
    def __init__(self):
        self.executor = ThreadPoolExecutor(max_workers=1)
        self.ready = False
        self.error = None
        self.sessions = []
    def load(self):
        self.ready = True
    def session(self):
        session = TestSession()
        self.sessions.append(session)
        return session
    def close(self):
        self.executor.shutdown()


class TestEmotion:
    __test__ = False
    state = "disabled"
    def __init__(self):
        self.busy = False
    def start(self, callback):
        self.callback = callback
    def set_asr_busy(self, busy):
        self.busy = busy
    def enqueue(self, key, pcm):
        return False
    async def close(self):
        pass


@pytest.fixture
def context(tmp_path):
    config = Config(root=tmp_path, token=TOKEN, emotion_enabled=False, max_devices=1)
    engine = TestEngine()
    app = create_app(config, engine=engine, emotion=TestEmotion())
    with TestClient(app) as client:
        yield client, app.state.hub, engine


def url(role="device", device="esp32-s3", token=TOKEN):
    return f"/ws/{role}/{device}?token={token}"


def until(websocket, kind):
    for _ in range(30):
        event = websocket.receive_json()
        if event["type"] == kind:
            return event
    raise AssertionError(f"No {kind} event within 30 messages")


def test_token_and_device_allowlist(context):
    client, _, _ = context
    for path in (url(token="wrong"), url(token="未替换口令"), url(device="other-device")):
        with pytest.raises(WebSocketDisconnect) as error:
            with client.websocket_connect(path):
                pass
        assert error.value.code == 1008
    health = client.get("/api/health").json()
    assert health["ready"] is True
    assert TOKEN not in str(health)


def test_release_flushes_tail_and_broadcasts_same_final(context):
    client, _, engine = context
    with client.websocket_connect(url("client")) as phone, client.websocket_connect(url()) as board:
        until(phone, "snapshot")
        until(board, "snapshot")
        board.send_json({"type": "record_start", "recording_id": "ptt-1"})
        assert until(board, "record_ready")["recording_id"] == "ptt-1"
        tail = bytes(range(64))
        board.send_bytes(bytes(640))
        board.send_bytes(tail)
        board.send_json({"type": "record_stop", "recording_id": "ptt-1"})
        board_final = until(board, "transcript")
        if not board_final["final"]:
            board_final = until(board, "transcript")
        done = until(board, "recording_done")
        assert done["audio_ms"] == 22
        phone.send_json({"type": "history_get"})
        snapshot = until(phone, "snapshot")
        assert len(snapshot["history"]) == 1
        assert snapshot["history"][0] == board_final
        assert engine.sessions[0].calls == [(bytes(640), False), (tail, False), (b"", True)]


def test_final_and_delayed_emotion_survive_reconnect(context):
    client, hub, _ = context
    with client.websocket_connect(url()) as board:
        until(board, "snapshot")
        board.send_json({"type": "record_start", "recording_id": "ptt-history"})
        until(board, "record_ready")
        board.send_bytes(bytes(640))
        board.send_json({"type": "record_stop", "recording_id": "ptt-history"})
        until(board, "recording_done")
    with client.websocket_connect(url("client")) as phone:
        snapshot = until(phone, "snapshot")
        assert snapshot["state"] == "offline"
        assert snapshot["history"][0]["text"] == "你好，世界。"
        assert snapshot["history"][0]["final"] is True


def test_settings_wait_for_device_ack(context):
    client, _, _ = context
    with client.websocket_connect(url("client")) as phone, client.websocket_connect(url()) as board:
        until(phone, "snapshot")
        until(board, "snapshot")
        phone.send_json({"type": "settings_set", "request_id": "set-1", "settings": {"font_scale": 3}})
        assert until(phone, "settings_pending")["request_id"] == "set-1"
        command = until(board, "settings_set")
        assert command["settings"]["font_scale"] == 3
        board.send_json({"type": "settings_ack", "request_id": "wrong-id", "settings": command["settings"]})
        phone.send_json({"type": "history_get"})
        assert until(phone, "snapshot")["settings"]["font_scale"] == 1
        board.send_json({"type": "settings_ack", "request_id": "set-1", "settings": command["settings"]})
        assert until(phone, "settings_applied")["settings"]["font_scale"] == 3


def test_settings_invalid_or_offline_not_applied(context):
    client, _, _ = context
    with client.websocket_connect(url("client")) as phone:
        until(phone, "snapshot")
        for settings, code in (({"font_scale": True}, "settings_invalid"), ({"font_scale": 5}, "settings_invalid"), ({"font_scale": 2}, "device_offline")):
            phone.send_json({"type": "settings_set", "request_id": "set-test", "settings": settings})
            assert until(phone, "error")["code"] == code


def test_recording_busy_and_odd_pcm_fail_explicitly(context):
    client, _, _ = context
    with client.websocket_connect(url()) as board:
        until(board, "snapshot")
        board.send_json({"type": "record_start", "recording_id": "ptt-a"})
        until(board, "record_ready")
        board.send_json({"type": "record_start", "recording_id": "ptt-b"})
        assert until(board, "error")["code"] == "busy"
        board.send_bytes(b"odd")
        assert until(board, "error")["code"] == "invalid_pcm"
        board.send_json({"type": "record_start", "recording_id": "ptt-c"})
        assert until(board, "record_ready")["recording_id"] == "ptt-c"
        board.send_json({"type": "record_cancel", "recording_id": "ptt-c"})
        assert until(board, "error")["code"] == "cancelled"


def test_bad_json_and_client_audio_do_not_kill_connection(context):
    client, _, _ = context
    with client.websocket_connect(url("client")) as phone:
        until(phone, "snapshot")
        phone.send_text("[]")
        assert until(phone, "error")["code"] == "invalid_json"
        phone.send_bytes(bytes(640))
        assert until(phone, "error")["code"] == "unsupported"
        phone.send_json({"type": "ping"})
        assert until(phone, "pong")["type"] == "pong"


def test_replaced_device_cannot_finish_old_recording(context):
    client, _, _ = context
    with client.websocket_connect(url()) as first:
        until(first, "snapshot")
        first.send_json({"type": "record_start", "recording_id": "old-connection"})
        until(first, "record_ready")
        with client.websocket_connect(url()) as second:
            until(second, "snapshot")
            second.send_json({"type": "record_start", "recording_id": "new-connection"})
            assert until(second, "record_ready")["recording_id"] == "new-connection"
            second.send_json({"type": "record_stop", "recording_id": "new-connection"})
            assert until(second, "recording_done")["segments"] == 0
