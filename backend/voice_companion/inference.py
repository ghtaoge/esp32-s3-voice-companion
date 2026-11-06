from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass

from .config import Config
from .protocol import PCM_BYTES_PER_MS, SAMPLE_RATE, VAD_FRAME_BYTES


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
    independently after this stream yields the CPU. VAD notifications may be
    delayed and a single call may return several boundaries. Absolute sample
    cursors keep their backtracked audio and prevent replay within a segment.
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
        self.processed_samples = 0
        self.fed_samples = 0
        self.buffered_until_samples = 0
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
            "start_ms": self.speech_start_ms if self.speech_start_ms is not None else self.segment_floor_ms,
            "end_ms": max(0, end_ms),
        }

    def _recognize(self, data: bytes, final: bool) -> str:
        started = time.perf_counter()
        delta = self.online.accept(data, final=final)
        self.inference_ms += (time.perf_counter() - started) * 1000
        if delta:
            self.text += delta
        return delta

    def _start_segment(self, start_ms: int) -> None:
        if self.speech_seen:
            # An already-open utterance must not lose its original prefix if a
            # backend repeats a start notification.
            return
        start_ms = max(self.segment_floor_ms, min(start_ms, self.cursor_ms))
        self.speech_start_ms = start_ms
        self.speech_seen = True
        # Context is confined to this PTT and cannot cross the preceding true
        # endpoint. Caption/SER timestamps remain the actual VAD speech start.
        preroll = max(0, min(480, self.engine.config.asr_preroll_ms))
        decode_start_ms = max(0, self.segment_floor_ms, start_ms - preroll)
        self.fed_samples = decode_start_ms * SAMPLE_RATE // 1000
        self.buffered_until_samples = self.fed_samples

    def _buffer_until(self, boundary_samples: int, *, decode_chunks: bool) -> bool:
        """Append only new audio, or discard an unconsumed backdated VAD tail.

        fed_samples is the absolute end already passed to OnlineRecognizer;
        buffered_until_samples includes its not-yet-passed pending PCM. A late
        VAD end cannot undo a submitted 480 ms chunk (usually trailing silence),
        but must never replay that chunk when flushing or recovering a prefix.
        """
        boundary_samples = min(max(0, boundary_samples), self.processed_samples)
        if boundary_samples < self.buffered_until_samples:
            keep = max(0, boundary_samples - self.fed_samples) * 2
            del self.asr_buffer[keep:]
            self.buffered_until_samples = max(self.fed_samples, boundary_samples)
        elif boundary_samples > self.buffered_until_samples:
            begin = self.buffered_until_samples * 2
            self.asr_buffer.extend(memoryview(self.audio)[begin:boundary_samples * 2])
            self.buffered_until_samples = boundary_samples
        changed = False
        step = self.online.chunk_samples * 2
        if decode_chunks:
            while len(self.asr_buffer) >= step:
                changed = bool(self._recognize(bytes(memoryview(self.asr_buffer)[:step]), final=False)) or changed
                del self.asr_buffer[:step]
                self.fed_samples += step // 2
        return changed

    def _finish_segment(self, end_ms: int, events: list[dict], jobs: list[tuple[int, bytes]], *, eof: bool = False) -> None:
        if not self.speech_seen:
            self.segment_floor_ms = max(self.segment_floor_ms, min(end_ms, self.cursor_ms))
            return
        start_ms = self.speech_start_ms if self.speech_start_ms is not None else self.segment_floor_ms
        end_ms = max(start_ms, min(end_ms, self.cursor_ms))
        end_samples = self.processed_samples if eof else end_ms * SAMPLE_RATE // 1000
        self._buffer_until(end_samples, decode_chunks=False)
        self._recognize(bytes(self.asr_buffer), final=True)
        self.fed_samples += len(self.asr_buffer) // 2
        self.asr_buffer.clear()
        if self.text.strip():
            self.text = self.punc.apply(self.text[:768]).strip() or self.text[:768]
            events.append(self._caption(True, end_ms))
            # Emotion consumes actual speech only, with a hard memory/time ceiling.
            cap = self.engine.config.emotion_max_seconds * 1000
            clip_end = min(end_ms, start_ms + cap, self.audio_ms)
            if clip_end - start_ms >= 300:
                jobs.append((self.segment_id, bytes(memoryview(self.audio)[start_ms * PCM_BYTES_PER_MS:clip_end * PCM_BYTES_PER_MS])))
            self.segment_id += 1
        self.online.reset()
        self.text = ""
        self.revision = 0
        self.speech_start_ms = None
        self.speech_seen = False
        # A later start can be earlier than this callback's current cursor.
        # Keep the true endpoint as the floor so its sentence head can be read
        # back from bounded recording history after the previous model reset.
        self.segment_floor_ms = max(self.segment_floor_ms, end_ms)
        self.fed_samples = end_samples
        self.buffered_until_samples = end_samples

    def _process(self, data: bytes, final: bool, events: list[dict], jobs: list[tuple[int, bytes]]) -> None:
        self.processed_samples += len(data) // 2
        self.cursor_ms = self.processed_samples * 1000 // SAMPLE_RATE
        endpoints = self.vad.accept(data, final=final)
        for start_ms, end_ms in endpoints:
            if start_ms >= 0:
                self._start_segment(start_ms)
            if end_ms >= 0:
                self._finish_segment(end_ms, events, jobs, eof=final and end_ms >= self.cursor_ms)
        if not self.speech_seen:
            return
        if final:
            self._finish_segment(self.cursor_ms, events, jobs, eof=True)
            return
        changed = self._buffer_until(self.processed_samples, decode_chunks=True)
        if changed and self.text.strip():
            if self.first_partial_ms is None:
                self.first_partial_ms = (time.perf_counter() - self.started) * 1000
            events.append(self._caption(False, self.cursor_ms))

    def feed(self, pcm: bytes, final: bool = False) -> Batch:
        if self.closed:
            raise RuntimeError("录音已收尾")
        if len(pcm) % 2:
            raise ValueError("PCM16必须偶数字节")
        if len(self.audio) + len(pcm) > self.engine.config.max_recording_seconds * SAMPLE_RATE * 2:
            raise ValueError("录音超过时长上限")
        self.audio.extend(pcm)
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
