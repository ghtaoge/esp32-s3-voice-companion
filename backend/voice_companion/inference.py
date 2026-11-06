from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .config import Config
from .protocol import PCM_BYTES_PER_MS, VAD_FRAME_BYTES


@dataclass(slots=True)
class Batch:
    events: list[dict]
    emotions: list[tuple[int, bytes]]


class ASREngine:
    """One exclusive stream; all ONNX calls run on one dedicated executor.

    The wrappers contain mutable frontend state, so sharing them across concurrent
    recordings is deliberately disallowed by the hub. Other clients only subscribe.
    """

    def __init__(self, config: Config):
        self.config = config
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="asr")
        self.ready = False
        self.error: str | None = None
        self.online = self.vad = self.punc = None

    def load(self) -> None:
        from .models import OnlineRecognizer, Punctuator, VadSegmenter

        try:
            root = self.config.model_root
            self.online = OnlineRecognizer(root, threads=self.config.asr_threads)
            self.vad = VadSegmenter(root, threads=1)
            self.punc = Punctuator(root, threads=1)
            # Warm feature extraction, ORT kernels, and punctuation before ready.
            self.online.reset()
            self.online.accept(bytes(self.online.chunk_samples * 2), final=True)
            self.vad.reset()
            self.vad.accept(bytes(VAD_FRAME_BYTES), final=True)
            self.punc.apply("你好世界")
            self.online.reset()
            self.vad.reset()
            self.ready = True
            self.error = None
        except Exception as exc:
            self.ready = False
            self.error = f"本地模型加载失败（{type(exc).__name__}），请运行模型检查工具；详情见本机日志。"
            raise

    def session(self) -> StreamingSession:
        if not self.ready:
            raise RuntimeError("ASR模型尚未就绪")
        return StreamingSession(self)

    def close(self) -> None:
        self.executor.shutdown(wait=True, cancel_futures=True)


class StreamingSession:
    """100ms VAD frames + 480ms streaming ASR; silence ends segments, not PTT.

    Final transcript uses the streaming cache flush plus punctuation. It does not
    run a second full ASR pass before displaying text. SenseVoice analyses happen
    independently after this stream yields the CPU.
    """

    def __init__(self, engine: ASREngine):
        self.engine = engine
        self.online, self.vad, self.punc = engine.online, engine.vad, engine.punc
        self.online.reset()
        self.vad.reset()
        self.audio = bytearray()
        self.vad_buffer = bytearray()
        self.asr_buffer = bytearray()
        self.text = ""
        self.segment_id = 0
        self.revision = 0
        self.cursor_ms = 0
        self.segment_floor_ms = 0
        self.speech_start_ms: int | None = None
        self.speech_seen = False
        self.first_partial_ms: float | None = None
        self.inference_ms = 0.0
        self.started = time.perf_counter()
        self.closed = False

    @property
    def audio_ms(self) -> int:
        return len(self.audio) // PCM_BYTES_PER_MS

    def _caption(self, final: bool, end_ms: int) -> dict:
        self.revision += 1
        return {
            "type": "transcript", "segment_id": self.segment_id,
            "revision": self.revision, "text": self.text[:768], "final": final,
            "start_ms": max(self.segment_floor_ms, self.speech_start_ms or self.segment_floor_ms),
            "end_ms": max(0, end_ms),
        }

    def _recognize(self, data: bytes, final: bool) -> str:
        started = time.perf_counter()
        delta = self.online.accept(data, final=final)
        self.inference_ms += (time.perf_counter() - started) * 1000
        if delta:
            self.text += delta
        return delta

    def _finish_segment(self, end_ms: int, events: list[dict], jobs: list[tuple[int, bytes]]) -> None:
        self._recognize(bytes(self.asr_buffer), final=True)
        self.asr_buffer.clear()
        if self.speech_seen and self.text.strip():
            self.text = self.punc.apply(self.text[:768]).strip() or self.text[:768]
            events.append(self._caption(True, end_ms))
            start = max(self.segment_floor_ms, self.speech_start_ms or self.segment_floor_ms)
            # Emotion consumes actual speech only, with a hard memory/time ceiling.
            cap = self.engine.config.emotion_max_seconds * 1000
            clip_end = min(end_ms, start + cap, self.audio_ms)
            if clip_end - start >= 300:
                jobs.append((self.segment_id, bytes(self.audio[start * 32:clip_end * 32])))
            self.segment_id += 1
        self.online.reset()
        self.text = ""
        self.revision = 0
        self.speech_start_ms = None
        self.speech_seen = False
        self.segment_floor_ms = self.cursor_ms

    def _process(self, data: bytes, final: bool, events: list[dict], jobs: list[tuple[int, bytes]]) -> None:
        self.cursor_ms += len(data) // PCM_BYTES_PER_MS
        endpoints = self.vad.accept(data, final=final)
        end: int | None = None
        for start_ms, end_ms in endpoints:
            if start_ms >= 0:
                self.speech_start_ms = max(self.segment_floor_ms, start_ms)
                self.speech_seen = True
            if end_ms >= 0:
                end = end_ms
        self.asr_buffer.extend(data)
        step = self.online.chunk_samples * 2
        changed = False
        while len(self.asr_buffer) >= step:
            changed = bool(self._recognize(bytes(self.asr_buffer[:step]), final=False)) or changed
            del self.asr_buffer[:step]
        # Bound uninterrupted speech segments to limit final punctuation and SER cost.
        force = self.speech_seen and self.cursor_ms - (self.speech_start_ms or self.segment_floor_ms) >= 12000
        if end is not None or force or final:
            self._finish_segment(min(end if end is not None else self.cursor_ms, self.audio_ms), events, jobs)
            if force and end is None and not final:
                # VAD is still inside the same continuous speech span; carry this
                # fact over our bounded segment split without inventing a new VAD start.
                self.speech_start_ms = self.cursor_ms
                self.speech_seen = True
        elif changed and self.speech_seen and self.text.strip():
            if self.first_partial_ms is None:
                self.first_partial_ms = (time.perf_counter() - self.started) * 1000
            events.append(self._caption(False, self.cursor_ms))

    def feed(self, pcm: bytes, final: bool = False) -> Batch:
        if self.closed:
            raise RuntimeError("录音已收尾")
        if len(pcm) % 2:
            raise ValueError("PCM16必须偶数字节")
        self.audio.extend(pcm)
        if self.audio_ms > self.engine.config.max_recording_seconds * 1000:
            raise ValueError("录音超过时长上限")
        self.vad_buffer.extend(pcm)
        events: list[dict] = []
        jobs: list[tuple[int, bytes]] = []
        while len(self.vad_buffer) >= VAD_FRAME_BYTES:
            data = bytes(self.vad_buffer[:VAD_FRAME_BYTES])
            del self.vad_buffer[:VAD_FRAME_BYTES]
            self._process(data, False, events, jobs)
        if final:
            self._process(bytes(self.vad_buffer), True, events, jobs)
            self.vad_buffer.clear()
            self.closed = True
        return Batch(events, jobs)
