from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import secrets
import time
from collections import OrderedDict
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

from fastapi import FastAPI, WebSocket, WebSocketDisconnect

from .config import Config
from .emotion import EmotionService
from .inference import ASREngine
from .protocol import DEVICE_ID, RECORDING_ID, MAX_FRAME_BYTES, VAD_FRAME_BYTES, DisplaySettings, error_event, valid_level, validated_settings
from .storage import HistoryStore


log = logging.getLogger("voice_companion")


@dataclass(eq=False)
class Peer:
    websocket: WebSocket
    device_id: str
    role: str
    queue: asyncio.Queue
    writer: asyncio.Task | None = None
    alive: bool = True

    def send(self, event: dict) -> bool:
        if not self.alive:
            return False
        try:
            self.queue.put_nowait(event)
            return True
        except asyncio.QueueFull:
            self.alive = False
            asyncio.create_task(self.websocket.close(code=1013, reason="slow consumer"))
            return False

    async def write(self) -> None:
        try:
            while self.alive:
                event = await self.queue.get()
                # One slow phone cannot stall ASR or another device.
                await asyncio.wait_for(self.websocket.send_json(event), timeout=3)
        except (Exception, asyncio.CancelledError):
            self.alive = False
            with contextlib.suppress(Exception):
                await self.websocket.close(code=1011)

    async def close(self) -> None:
        self.alive = False
        if self.writer:
            self.writer.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self.writer
        with contextlib.suppress(Exception):
            await self.websocket.close()


@dataclass
class Device:
    device_id: str
    peer: Peer | None = None
    state: str = "offline"
    recording_id: str | None = None
    settings: dict = field(default_factory=lambda: DisplaySettings().model_dump())
    history: OrderedDict = field(default_factory=OrderedDict)
    pending_settings: tuple[str, Peer] | None = None
    settings_timer: asyncio.Task | None = None


@dataclass
class Recording:
    device_id: str
    recording_id: str
    peer: Peer
    queue: asyncio.Queue
    task: asyncio.Task | None = None
    stopping: bool = False
    stopped_at: float | None = None
    audio_bytes: int = 0
    queued_bytes: int = 0
    peak_queued_bytes: int = 0
    worker_calls: int = 0
    started: float = field(default_factory=time.monotonic)


class Hub:
    def __init__(self, config: Config, engine=None, emotion=None):
        self.config = config
        self.engine = engine or ASREngine(config)
        self.emotion = emotion or EmotionService(config.model_root, config.emotion_enabled)
        self.store = HistoryStore(config.local_dir / "history.sqlite3", config.history_limit)
        self.devices: dict[str, Device] = {}
        self.peers: set[Peer] = set()
        self.active: Recording | None = None
        self.io_tasks: set[asyncio.Task] = set()
        self.closed = False
        self.device_init_lock = asyncio.Lock()
        self.connection_lock = asyncio.Lock()

    async def start(self) -> None:
        try:
            await asyncio.get_running_loop().run_in_executor(self.engine.executor, self.engine.load)
        except Exception:
            log.exception("ASR未就绪；请先下载并检查本地模型")
        self.emotion.start(self.on_emotion)

    async def close(self) -> None:
        self.closed = True
        if self.active:
            await self.abort(self.active, "shutdown", "服务正在关闭")
        for device in self.devices.values():
            if device.settings_timer:
                device.settings_timer.cancel()
        for peer in list(self.peers):
            await peer.close()
        await self.emotion.close()
        if self.io_tasks:
            await asyncio.gather(*self.io_tasks, return_exceptions=True)
        await asyncio.to_thread(self.engine.close)
        self.store.close()

    def background_io(self, function, *args) -> None:
        task = asyncio.create_task(asyncio.to_thread(function, *args))
        self.io_tasks.add(task)
        task.add_done_callback(self.io_tasks.discard)
        def report(done):
            if not done.cancelled() and done.exception():
                log.error("本地历史写入失败：%s", type(done.exception()).__name__)
        task.add_done_callback(report)

    async def device(self, device_id: str) -> Device:
        async with self.device_init_lock:
            if device_id not in self.devices:
                device = Device(device_id)
                device.settings = await asyncio.to_thread(self.store.settings, device_id) or device.settings
                for event in await asyncio.to_thread(self.store.history, device_id):
                    device.history[(event["recording_id"], event["segment_id"])] = event
                self.devices[device_id] = device
            return self.devices[device_id]

    def publish(self, device_id: str, event: dict, *, clients_only: bool = False) -> None:
        event.setdefault("device_id", device_id)
        for peer in list(self.peers):
            if peer.device_id == device_id and (not clients_only or peer.role == "client"):
                peer.send(event)

    def status(self, device: Device, state: str, recording_id: str | None, message: str = "") -> None:
        device.state, device.recording_id = state, recording_id
        self.publish(device.device_id, {"type": "status", "state": state, "recording_id": recording_id, "message": message})

    def snapshot(self, device: Device, role: str) -> dict:
        history = list(device.history.values())
        if role == "device":
            history = history[-1:]
        return {"type": "snapshot", "device_id": device.device_id,
                "state": device.state, "recording_id": device.recording_id,
                "settings": device.settings, "history": history}

    async def connect(self, websocket: WebSocket, device_id: str, role: str) -> Peer | None:
        token = websocket.query_params.get("token", "")
        if not DEVICE_ID.fullmatch(device_id) or device_id not in self.config.allowed_devices or len(token) > 128 or not secrets.compare_digest(token.encode("utf-8"), self.config.token.encode("utf-8")):
            await websocket.close(code=1008)
            return None
        async with self.connection_lock:
            return await self._connect_authenticated(websocket, device_id, role)

    async def _connect_authenticated(self, websocket: WebSocket, device_id: str, role: str) -> Peer | None:
        # A reconnect replacing its own ID does not consume an additional slot.
        count = sum(p.role == role and p.alive and not (role == "device" and p.device_id == device_id) for p in self.peers)
        limit = self.config.max_devices if role == "device" else self.config.max_clients
        if count >= limit:
            await websocket.close(code=1013)
            return None
        await websocket.accept()
        peer = Peer(websocket, device_id, role, asyncio.Queue(self.config.peer_queue_messages))
        peer.writer = asyncio.create_task(peer.write())
        device = await self.device(device_id)
        if role == "device":
            old = device.peer
            if old:
                await self.disconnect(old)
            device.peer = peer
            device.state = "idle"
            device.recording_id = None
        self.peers.add(peer)
        peer.send({"type": "hello", "protocol": 1, "device_id": device_id, "ready": self.engine.ready, "settings": device.settings})
        peer.send(self.snapshot(device, role))
        if role == "device":
            self.status(device, "idle", None)
        return peer

    async def disconnect(self, peer: Peer) -> None:
        self.peers.discard(peer)
        device = self.devices.get(peer.device_id)
        if device and device.peer is peer:
            if self.active and self.active.peer is peer:
                await self.abort(self.active, "disconnected", "开发板连接断开，本次录音已结束")
            device.peer = None
            self.status(device, "offline", None)
            if device.pending_settings:
                request_id, owner = device.pending_settings
                owner.send(error_event("device_offline", "开发板已断开，设置未确认", request_id=request_id))
                device.pending_settings = None
                if device.settings_timer:
                    device.settings_timer.cancel()
        await peer.close()

    async def on_json(self, peer: Peer, data: dict) -> None:
        kind = data.get("type")
        device = self.devices[peer.device_id]
        if peer.role == "client":
            if kind == "ping":
                peer.send({"type": "pong"})
            elif kind == "history_get":
                peer.send(self.snapshot(device, "client"))
            elif kind == "settings_set":
                await self.settings_set(peer, device, data)
            else:
                peer.send(error_event("unsupported", "小程序消息类型不支持"))
            return
        if device.peer is not peer:
            return
        if kind == "hello":
            if data.get("protocol") != 1:
                peer.send(error_event("protocol", "固件协议版本不兼容"))
                return
            if data.get("settings"):
                try:
                    device.settings = validated_settings(data["settings"])
                    self.background_io(self.store.save_settings, device.device_id, device.settings)
                    self.publish(device.device_id, {"type": "settings_applied", "request_id": "device-sync", "settings": device.settings})
                except ValueError:
                    peer.send(error_event("settings_invalid", "开发板报告了无效设置"))
        elif kind == "record_start":
            await self.record_start(peer, data)
        elif kind in ("record_stop", "record_cancel"):
            recording = self.active
            if not recording or recording.peer is not peer or data.get("recording_id") != recording.recording_id:
                peer.send(error_event("recording_mismatch", "录音标识已失效", recording_id=data.get("recording_id")))
                return
            if kind == "record_cancel":
                await self.abort(recording, "cancelled", "录音已取消")
            elif not recording.stopping:
                recording.stopping = True
                recording.stopped_at = time.perf_counter()
                self.status(device, "processing", recording.recording_id)
                try:
                    recording.queue.put_nowait(None)
                except asyncio.QueueFull:
                    await self.abort(recording, "audio_overload", "音频队列过载，请重试")
        elif kind == "level":
            if self.active and self.active.peer is peer and data.get("recording_id") == self.active.recording_id and valid_level(data.get("level")):
                self.publish(device.device_id, {"type": "level", "recording_id": self.active.recording_id, "level": data["level"]}, clients_only=True)
        elif kind == "settings_ack":
            await self.settings_ack(device, data)
        elif kind == "ping":
            peer.send({"type": "pong"})

    async def record_start(self, peer: Peer, data: dict) -> None:
        recording_id = data.get("recording_id")
        if not isinstance(recording_id, str) or not RECORDING_ID.fullmatch(recording_id):
            peer.send(error_event("recording_id", "无效录音标识"))
            return
        if not self.engine.ready:
            peer.send(error_event("not_ready", "本地ASR尚未就绪，请检查电脑服务", recording_id=recording_id))
            return
        if self.active:
            peer.send(error_event("busy", "正在处理录音，请稍后再按", recording_id=recording_id))
            return
        # Refuse reused IDs: delayed callbacks and history keys must stay unambiguous.
        device = self.devices[peer.device_id]
        if any(key[0] == recording_id for key in device.history):
            peer.send(error_event("recording_id_reused", "录音标识重复，请重新生成", recording_id=recording_id))
            return
        recording = Recording(peer.device_id, recording_id, peer, asyncio.Queue(self.config.audio_queue_frames))
        self.active = recording
        self.emotion.set_asr_busy(True)
        self.status(device, "recording", recording_id)
        peer.send({"type": "record_ready", "recording_id": recording_id})
        recording.task = asyncio.create_task(self.run_recording(recording))

    async def on_audio(self, peer: Peer, pcm: bytes) -> None:
        recording = self.active
        if peer.role != "device" or not recording or recording.peer is not peer or recording.stopping:
            peer.send(error_event("unexpected_audio", "当前没有可接收音频的录音"))
            return
        if not pcm or len(pcm) % 2 or len(pcm) > MAX_FRAME_BYTES:
            await self.abort(recording, "invalid_pcm", "音频帧格式错误")
            return
        recording.audio_bytes += len(pcm)
        if recording.audio_bytes > self.config.max_recording_seconds * 32000:
            await self.abort(recording, "recording_limit", "已达到单次录音时长上限")
            return
        if recording.queued_bytes + len(pcm) > self.config.audio_queue_frames * 640:
            await self.abort(recording, "audio_overload", "音频积压超过实时窗口，请降低后台负载后重试")
            return
        try:
            recording.queue.put_nowait(pcm)
            recording.queued_bytes += len(pcm)
            recording.peak_queued_bytes = max(recording.peak_queued_bytes, recording.queued_bytes)
        except asyncio.QueueFull:
            await self.abort(recording, "audio_overload", "电脑处理落后于录音，已停止本次录音，请降低后台负载")

    async def abort(self, recording: Recording, code: str, message: str) -> None:
        if self.active is not recording:
            return
        self.active = None
        if recording.task and recording.task is not asyncio.current_task():
            recording.task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await recording.task
        device = self.devices[recording.device_id]
        self.publish(recording.device_id, error_event(code, message, recording_id=recording.recording_id))
        if device.recording_id == recording.recording_id:
            self.status(device, "error", recording.recording_id, message)
        # Cancelling a task yields. Another allowed device may have acquired the
        # ASR slot in that interval; never resume analysis over its new recording.
        if self.active is None:
            self.emotion.set_asr_busy(False)

    async def run_recording(self, recording: Recording) -> None:
        loop = asyncio.get_running_loop()
        try:
            session = await loop.run_in_executor(self.engine.executor, self.engine.session)
            pending = bytearray()
            while self.active is recording:
                remaining = self.config.max_recording_seconds + 10 - (time.monotonic() - recording.started)
                if remaining <= 0:
                    await self.abort(recording, "recording_limit", "本次录音连接超过时长上限")
                    return
                frame = await asyncio.wait_for(recording.queue.get(), min(remaining, self.config.idle_audio_timeout_seconds))
                if frame is not None:
                    pending.extend(frame)
                    # VAD and online feature extraction already wait for 100ms;
                    # avoid 50 executor submissions/sec for 20ms transport frames.
                    if len(pending) < VAD_FRAME_BYTES:
                        continue
                data = bytes(pending)
                pending.clear()
                recording.queued_bytes -= len(data)
                recording.worker_calls += 1
                batch = await loop.run_in_executor(self.engine.executor, session.feed, data, frame is None)
                if self.active is not recording:
                    return
                for event in batch.events:
                    event.update(device_id=recording.device_id, recording_id=recording.recording_id)
                    self.remember(event)
                    self.publish(recording.device_id, event)
                for segment_id, pcm in batch.emotions:
                    key = (recording.device_id, recording.recording_id, segment_id)
                    if not self.emotion.enqueue(key, pcm):
                        await self.on_emotion(key, {"label": "unknown", "event": "unknown", "status": "skipped"})
                if frame is None:
                    latency = max(0, (time.perf_counter() - (recording.stopped_at or time.perf_counter())) * 1000)
                    self.publish(recording.device_id, {"type": "recording_done", "recording_id": recording.recording_id,
                        "segments": session.segment_id, "audio_ms": session.audio_ms, "final_latency_ms": round(latency, 1),
                        "first_partial_ms": round(session.first_partial_ms, 1) if session.first_partial_ms is not None else None,
                        "asr_inference_ms": round(session.inference_ms, 1),
                        "worker_calls": recording.worker_calls,
                        "audio_queue_peak_ms": round(recording.peak_queued_bytes / 32, 1),
                        "message": "" if session.segment_id else "没有检测到可识别的语音"})
                    self.active = None
                    self.status(self.devices[recording.device_id], "idle", None)
                    self.emotion.set_asr_busy(False)
                    return
        except asyncio.CancelledError:
            raise
        except asyncio.TimeoutError:
            await self.abort(recording, "audio_timeout", "等待音频超时，请松开按钮后重试")
        except Exception:
            log.exception("本地ASR处理失败")
            await self.abort(recording, "asr_failed", "本地识别失败，请查看电脑日志后重试")

    def remember(self, event: dict) -> None:
        device = self.devices[event["device_id"]]
        key = (event["recording_id"], event["segment_id"])
        previous = device.history.get(key)
        if previous and previous.get("revision", 0) > event.get("revision", 0):
            return
        if previous and previous.get("emotion"):
            event = {**event, "emotion": previous["emotion"]}
        device.history[key] = dict(event)
        while len(device.history) > self.config.history_limit:
            device.history.popitem(last=False)
        if event.get("final"):
            self.background_io(self.store.upsert, dict(event))

    async def on_emotion(self, key: tuple[str, str, int], result: dict) -> None:
        device_id, recording_id, segment_id = key
        device = self.devices.get(device_id)
        if not device:
            return
        entry = device.history.get((recording_id, segment_id))
        if not entry:
            return
        result = {name: result[name] for name in ("label", "event", "status", "raw_tags") if name in result}
        entry["emotion"] = result
        self.background_io(self.store.upsert, dict(entry))
        self.publish(device_id, {"type": "emotion", "recording_id": recording_id, "segment_id": segment_id, **result})

    async def settings_set(self, peer: Peer, device: Device, data: dict) -> None:
        request_id = data.get("request_id")
        if not isinstance(request_id, str) or not RECORDING_ID.fullmatch(request_id):
            peer.send(error_event("request_id", "设置请求标识无效"))
            return
        try:
            settings = validated_settings(data.get("settings"), device.settings)
        except ValueError:
            peer.send(error_event("settings_invalid", "显示设置超出允许范围", request_id=request_id))
            return
        if not device.peer or not device.peer.alive:
            peer.send(error_event("device_offline", "开发板未连接，设置尚未应用", request_id=request_id))
            return
        if device.pending_settings:
            peer.send(error_event("settings_busy", "上一项设置还在等待开发板确认", request_id=request_id))
            return
        device.pending_settings = (request_id, peer)
        peer.send({"type": "settings_pending", "request_id": request_id})
        device.peer.send({"type": "settings_set", "request_id": request_id, "settings": settings})
        async def timeout():
            await asyncio.sleep(self.config.settings_timeout_seconds)
            if device.pending_settings and device.pending_settings[0] == request_id:
                device.pending_settings = None
                peer.send(error_event("settings_timeout", "开发板未确认，设置结果未知，请重连读取实际值", request_id=request_id))
        device.settings_timer = asyncio.create_task(timeout())

    async def settings_ack(self, device: Device, data: dict) -> None:
        pending = device.pending_settings
        if not pending or data.get("request_id") != pending[0]:
            return
        request_id, owner = pending
        device.pending_settings = None
        if device.settings_timer:
            device.settings_timer.cancel()
        if data.get("error"):
            owner.send(error_event("settings_rejected", "开发板拒绝了显示设置", request_id=request_id))
            return
        try:
            settings = validated_settings(data.get("settings"))
        except ValueError:
            owner.send(error_event("settings_invalid_ack", "开发板确认的设置无效", request_id=request_id))
            return
        device.settings = settings
        self.background_io(self.store.save_settings, device.device_id, settings)
        self.publish(device.device_id, {"type": "settings_applied", "request_id": request_id, "settings": settings})


def create_app(config: Config | None = None, *, engine=None, emotion=None) -> FastAPI:
    config = config or Config()
    config.ensure_token()
    hub = Hub(config, engine=engine, emotion=emotion)
    @asynccontextmanager
    async def lifespan(app):
        await hub.start()
        yield
        await hub.close()
    app = FastAPI(title="ESP32-S3 Voice Companion", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.state.hub = hub

    @app.get("/api/health")
    async def health():
        return config.public_health(hub.engine.ready, hub.emotion.state, hub.engine.error)

    async def websocket_loop(websocket: WebSocket, device_id: str, role: str):
        peer = await hub.connect(websocket, device_id, role)
        if not peer:
            return
        window_start, messages = time.monotonic(), 0
        try:
            while peer.alive:
                packet = await websocket.receive()
                if packet["type"] == "websocket.disconnect":
                    break
                messages += 1
                if time.monotonic() - window_start >= 1:
                    window_start, messages = time.monotonic(), 1
                if messages > (160 if role == "device" else 30):
                    await websocket.close(code=1008, reason="message rate")
                    break
                if packet.get("bytes") is not None:
                    if role != "device":
                        peer.send(error_event("unsupported", "小程序连接不接收音频"))
                    else:
                        await hub.on_audio(peer, packet["bytes"])
                elif packet.get("text") is not None:
                    text = packet["text"]
                    if len(text) > 8192:
                        await websocket.close(code=1009)
                        break
                    try:
                        data = json.loads(text)
                        if not isinstance(data, dict):
                            raise ValueError("object required")
                    except (ValueError, RecursionError):
                        peer.send(error_event("invalid_json", "消息必须是JSON对象"))
                        continue
                    await hub.on_json(peer, data)
        except (WebSocketDisconnect, RuntimeError):
            pass
        finally:
            await hub.disconnect(peer)

    @app.websocket("/ws/device/{device_id}")
    async def device_ws(websocket: WebSocket, device_id: str):
        await websocket_loop(websocket, device_id, "device")

    @app.websocket("/ws/client/{device_id}")
    async def client_ws(websocket: WebSocket, device_id: str):
        await websocket_loop(websocket, device_id, "client")

    return app
