"""Local-only, CPU INT8 FunASR adapters. Instances are single-stream objects.

No constructor accepts a hub model ID and no inference path downloads/exports.
Install funasr-onnx>=0.4.8, then run tools/download_models.py explicitly.
"""
from __future__ import annotations

from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import re
from typing import Any

import numpy as np

from .ort_session import build_cpu_model

SAMPLE_RATE = 16000
REQUIRED_FILES = {
    "online": ("model_quant.onnx", "decoder_quant.onnx", "config.yaml", "am.mvn", "tokens.json"),
    "vad": ("model_quant.onnx", "config.yaml", "am.mvn"),
    "punc": ("model_quant.onnx", "config.yaml", "tokens.json"),
    "emotion": ("model_quant.onnx", "config.yaml", "am.mvn", "chn_jpn_yue_eng_ko_spectok.bpe.model"),
}


class ModelUnavailableError(RuntimeError):
    """Missing local assets or incompatible inference dependency."""


def _model_dir(root: Path, component: str) -> Path:
    directory = Path(root).expanduser().resolve() / component
    missing = []
    for filename in REQUIRED_FILES[component]:
        path = directory / filename
        if not path.is_file() or path.stat().st_size == 0:
            missing.append(filename)
            continue
        if path.suffix == ".onnx":
            with path.open("rb") as stream:
                if stream.read(64).startswith(b"version https://git-lfs.github.com"):
                    missing.append(f"{filename} (Git LFS pointer, not model weights)")
    if missing:
        raise ModelUnavailableError(
            f"Local {component} model is incomplete in {directory}: {', '.join(missing)}. "
            f"Run: python tools/download_models.py --root \"{directory.parent}\" --model {component}"
        )
    try:
        installed = version("funasr-onnx")
    except PackageNotFoundError as exc:
        raise ModelUnavailableError("Install funasr-onnx>=0.4.8 in this Python environment first") from exc
    numbers = tuple(int(n) for n in re.findall(r"\d+", installed)[:3])
    if numbers < (0, 4, 8):
        raise ModelUnavailableError(f"funasr-onnx {installed} is too old; install >=0.4.8 for streaming cache/final-packet fixes")
    return directory


def _waveform(pcm: bytes) -> np.ndarray:
    if len(pcm) % 2:
        raise ValueError("PCM16 little-endian data must contain an even number of bytes")
    return np.frombuffer(pcm, dtype="<i2").astype(np.float32) / 32768.0


class OnlineRecognizer:
    """Incremental Paraformer; accept() returns only newly decoded text.

    The model wrapper uses 60 ms LFR frames: 8 * 960 = 7680 input samples.
    [5,8,4] preserves the official Python wrapper's 5-frame left overlap and
    uses the model's supported stride of 8 (480 ms center, 240 ms right).
    Removing left overlap caused repeated words on the official sample;
    retaining it still runs faster than real time on the development machine.
    Feed arbitrary PCM packets; this adapter batches them.
    """

    chunk_samples = 7680
    chunk_size = (5, 8, 4)

    def __init__(self, model_root: Path, threads: int = 3):
        directory = _model_dir(model_root, "online")
        # The top-level funasr_onnx.Paraformer is OFFLINE, not this class.
        self.model = build_cpu_model("funasr_onnx.paraformer_online_bin", "Paraformer",
                                     str(directory), batch_size=1, quantize=True,
                                     chunk_size=list(self.chunk_size), intra_op_num_threads=max(1, threads))
        # The upstream frontend defaults to random one-LSB dither. Disable it
        # for repeatable inference/reset behavior on the same captured PCM.
        self.model.frontend.opts.frame_opts.dither = 0.0
        if not callable(getattr(self.model.frontend, "cache_reset", None)):
            raise ModelUnavailableError("Installed FunASR online frontend lacks cache_reset(); upgrade funasr-onnx")
        self.reset()

    def reset(self) -> None:
        # An empty decoder cache alone does NOT clear the wrapper's frontend.
        self.model.frontend.cache_reset()
        self._params: dict[str, Any] = {"cache": {}, "is_final": False}
        self._pending = bytearray()
        self._samples = 0
        self._finalized = False

    def _decode(self, pcm: bytes, final: bool) -> str:
        audio = _waveform(pcm)
        # Upstream's <60 ms final branch flushes its cached features without
        # consuming the new samples. Pad a nonempty short tail to 60 ms so its
        # actual audio reaches the frontend, instead of dropping the final word.
        if final and 0 < audio.size < 960 and self._params["cache"]:
            audio = np.pad(audio, (0, 960 - audio.size))
        self._params["is_final"] = final
        results = self.model(audio_in=audio, param_dict=self._params)
        pieces = []
        for item in results:
            prediction = item.get("preds")
            if not isinstance(prediction, (list, tuple)) or not prediction or not isinstance(prediction[0], str):
                raise RuntimeError(f"Unexpected online Paraformer output: {item!r}")
            pieces.append(prediction[0])
        return "".join(pieces)

    def accept(self, pcm: bytes, final: bool = False) -> str:
        if len(pcm) % 2:
            raise ValueError("PCM16 data must contain an even number of bytes")
        if self._finalized:
            if final and not pcm:
                return ""
            raise RuntimeError("OnlineRecognizer is finalized; call reset() before the next segment")
        self._pending.extend(pcm)
        self._samples += len(pcm) // 2
        pieces = []
        chunk_bytes = self.chunk_samples * 2
        while len(self._pending) > chunk_bytes or (not final and len(self._pending) >= chunk_bytes):
            packet = bytes(self._pending[:chunk_bytes])
            del self._pending[:chunk_bytes]
            pieces.append(self._decode(packet, False))
        if final:
            try:
                if self._samples:
                    pieces.append(self._decode(bytes(self._pending), True))
            finally:
                self._pending.clear()
                self.model.frontend.cache_reset()
                self._finalized = True
        return "".join(pieces)


def _vad_pairs(value: Any) -> list[tuple[int, int]]:
    """The official wrapper returns nested [batch][segment][start,end]."""
    if isinstance(value, np.ndarray):
        value = value.tolist()
    if not isinstance(value, (tuple, list)):
        return []
    if len(value) == 2 and all(isinstance(n, (int, np.integer)) for n in value):
        return [(int(value[0]), int(value[1]))]
    return [pair for child in value for pair in _vad_pairs(child)]


class VadSegmenter:
    """Streaming FSMN VAD, returning absolute millisecond boundary events.

    Events are (start,-1), (-1,end), or (start,end). A fresh reset starts the
    clock at zero. Process complete 100 ms blocks immediately; flush the short
    remainder (including an empty final packet) through the fixed >=0.4.8
    frontend so the boundary detector never lags behind the ASR input.
    """

    chunk_samples = 1600

    def __init__(self, model_root: Path, threads: int = 1):
        directory = _model_dir(model_root, "vad")
        self.model = build_cpu_model("funasr_onnx.vad_bin", "Fsmn_vad_online",
                                     str(directory), quantize=True,
                                     intra_op_num_threads=max(1, threads), max_end_sil=600)
        self.model.config["frontend_conf"]["dither"] = 0.0
        self.reset()

    def reset(self) -> None:
        # Frontend, VAD scorer and FSMN caches are all held in this dictionary.
        self._params: dict[str, Any] = {"in_cache": [], "is_final": False}
        self._pending = bytearray()
        self._samples = 0
        self._open = False
        self._finalized = False

    def _detect(self, pcm: bytes, final: bool) -> list[tuple[int, int]]:
        self._params["is_final"] = final
        pairs = _vad_pairs(self.model(audio_in=_waveform(pcm), param_dict=self._params))
        for start, end in pairs:
            if start >= 0:
                self._open = True
            if end >= 0:
                self._open = False
        return pairs

    def accept(self, pcm: bytes, final: bool = False) -> list[tuple[int, int]]:
        if len(pcm) % 2:
            raise ValueError("PCM16 data must contain an even number of bytes")
        if self._finalized:
            if final and not pcm:
                return []
            raise RuntimeError("VadSegmenter is finalized; call reset() before the next recording")
        self._pending.extend(pcm)
        self._samples += len(pcm) // 2
        events = []
        chunk_bytes = self.chunk_samples * 2
        while len(self._pending) > chunk_bytes or (not final and len(self._pending) >= chunk_bytes):
            packet = bytes(self._pending[:chunk_bytes])
            del self._pending[:chunk_bytes]
            events.extend(self._detect(packet, False))
        if final:
            if self._samples:
                events.extend(self._detect(bytes(self._pending), True))
                # EOF closes an already-detected utterance even if the final
                # sub-frame cannot produce another feature. It never creates
                # a speech start for silence.
                if self._open:
                    events.append((-1, self._samples * 1000 // SAMPLE_RATE))
                    self._open = False
            self._pending.clear()
            self._finalized = True
        return events


class Punctuator:
    def __init__(self, model_root: Path, threads: int = 1):
        directory = _model_dir(model_root, "punc")
        self.model = build_cpu_model("funasr_onnx.punc_bin", "CT_Transformer",
                                     str(directory), quantize=True, intra_op_num_threads=max(1, threads))

    def apply(self, text: str) -> str:
        if not text.strip():
            return ""
        output = self.model(text)
        if not output or not isinstance(output[0], str):
            raise RuntimeError("Unexpected punctuation model output")
        return output[0]


EMOTIONS = {
    "NEUTRAL": "neutral", "HAPPY": "happy", "SAD": "sad", "ANGRY": "angry",
    "FEARFUL": "fearful", "DISGUSTED": "disgusted", "SURPRISED": "surprised",
    "EMO_UNKNOWN": "unknown", "UNKNOWN": "unknown",
}
EVENTS = {
    "SPEECH": "speech", "BGM": "music", "MUSIC": "music", "APPLAUSE": "applause",
    "LAUGHTER": "laughter", "CRY": "cry", "COUGH": "cough", "SNEEZE": "sneeze",
    "BREATH": "breath", "SING": "sing", "NOSPEECH": "nospeech", "EVENT_UNK": "unknown",
}


class EmotionRecognizer:
    """SenseVoiceSmall's acoustic tags, without keyword guesses/confidence.

    Use on the background emotion executor, never on the streaming ASR thread.
    Analysis is bounded to the first 15 seconds of the supplied segment.
    """

    max_samples = 15 * SAMPLE_RATE

    def __init__(self, model_root: Path, threads: int = 1):
        directory = _model_dir(model_root, "emotion")
        self.model = build_cpu_model("funasr_onnx.sensevoice_bin", "SenseVoiceSmall",
                                     str(directory), quantize=True, batch_size=1,
                                     intra_op_num_threads=max(1, threads))
        self.model.frontend.opts.frame_opts.dither = 0.0

    def analyze(self, pcm: bytes) -> dict:
        audio = _waveform(pcm)[:self.max_samples]
        # No 25 ms fbank frame can be formed. Unknown is the absence of a
        # model label here, not a guessed neutral emotion for a short click.
        if audio.size < 400:
            return {"label": "unknown", "event": "unknown", "raw_tags": []}
        output = self.model(audio, language="auto", textnorm="woitn")
        if not output or not isinstance(output[0], str):
            raise RuntimeError("Unexpected SenseVoice output")
        raw_tags = re.findall(r"<\|[^|>]+\|>", output[0])
        names = [token[2:-2].upper() for token in raw_tags]
        label = next((EMOTIONS[name] for name in names if name in EMOTIONS), "unknown")
        event = next((EVENTS[name] for name in names if name in EVENTS), "unknown")
        return {"label": label, "event": event, "raw_tags": raw_tags}
