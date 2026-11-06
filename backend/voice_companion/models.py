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
    """SenseVoiceSmall's utterance tags and uncalibrated acoustic candidates.

    Use on the background emotion executor, never on the streaming ASR thread.
    Analysis is bounded to the first 15 seconds of the supplied segment. A
    candidate score is a raw model output at emotion-prefix frame 1, not a
    probability/confidence and never a replacement for native EMO_UNKNOWN.
    """

    max_samples = 15 * SAMPLE_RATE

    def __init__(self, model_root: Path, threads: int = 1):
        directory = _model_dir(model_root, "emotion")
        self.model = build_cpu_model("funasr_onnx.sensevoice_bin", "SenseVoiceSmall",
                                     str(directory), quantize=True, batch_size=1,
                                     intra_op_num_threads=max(1, threads))
        self.model.frontend.opts.frame_opts.dither = 0.0
        # The official SenseVoice input prefixes are language/emotion/event/ITN.
        # Resolve the seven known emotion IDs from the shipped tokenizer; do
        # not assume that another checkpoint preserves numerical token IDs.
        self._emotion_ids = []
        for tag, label in EMOTIONS.items():
            if label == "unknown":
                continue
            piece = f"<|{tag}|>"
            token = self.model.tokenizer.sp.piece_to_id(piece)
            if self.model.tokenizer.sp.id_to_piece(token) != piece:
                raise ModelUnavailableError(f"SenseVoice tokenizer is missing {piece}")
            self._emotion_ids.append((label, token))

    def _quality(self, audio: np.ndarray, analyzed_samples: int) -> dict:
        """Measurements of analyzed PCM, calculated only in the SER process.

        duration_ms describes the input; the other measurements describe its
        analyzed prefix (analyzed_ms), so truncation remains explicit.
        clipping_ratio counts exact PCM16 digital-rail samples. It signals risk;
        it cannot prove analog clipping or determine a person's emotion.
        short_context is an informational duration flag, never a label gate.
        """
        count = audio.size
        analyzed = audio[:analyzed_samples]
        peak = float(np.max(np.abs(analyzed))) if analyzed_samples else 0.0
        power = float(np.mean(analyzed.astype(np.float64) ** 2)) if analyzed_samples else 0.0
        clipping = float(np.mean((analyzed >= 32767 / 32768) | (analyzed <= -1))) if analyzed_samples else 0.0
        if not count:
            reason = "no_audio"
        elif analyzed_samples < 400:
            reason = "below_feature_window"
        elif not peak:
            reason = "no_signal"
        elif count > self.max_samples:
            reason = "truncated"
        elif analyzed_samples < SAMPLE_RATE:
            reason = "short_context"
        else:
            reason = None
        return {"duration_ms": count * 1000 / SAMPLE_RATE,
                "analyzed_ms": analyzed_samples * 1000 / SAMPLE_RATE,
                "peak": peak, "rms_dbfs": float(10 * np.log10(power)) if power > 0 else None,
                "clipping_ratio": clipping, "reason": reason}

    def analyze(self, pcm: bytes) -> dict:
        supplied = _waveform(pcm)
        audio = supplied[:self.max_samples]
        quality = self._quality(supplied, audio.size)
        if audio.size < 400 or not quality["peak"]:
            return {"label": "unknown", "event": "unknown", "raw_tags": [],
                    "candidates": [], "audio_quality": quality}
        # Match the official ONNX greedy CTC decoder, but retain only seven
        # scalar scores from this SAME forward. No second model call and no
        # copy of the large [time,vocabulary] tensor is needed.
        model = self.model
        features, lengths = model.extract_feat([audio])
        logits, output_lengths = model.infer(features, lengths,
            np.array([model.lid_dict["auto"]], dtype=np.int32),
            np.array([model.textnorm_dict["withitn"]], dtype=np.int32))
        if logits.ndim != 3 or logits.shape[0] != 1:
            raise RuntimeError("Unexpected SenseVoice logits shape")
        valid_frames = min(max(int(output_lengths[0]), 0), logits.shape[1])
        scores = logits[0, :valid_frames, :]  # view, not a full-logits copy
        if valid_frames:
            ids = np.argmax(scores, axis=-1)
            ids = ids[np.concatenate(([True], np.diff(ids) != 0))]
            raw = model.tokenizer.decode(ids[ids != model.blank_id].tolist())
        else:
            raw = ""
        raw_tags = re.findall(r"<\|[^|>]+\|>", raw)
        names = [token[2:-2].upper() for token in raw_tags]
        label = next((EMOTIONS[name] for name in names if name in EMOTIONS), "unknown")
        event = next((EVENTS[name] for name in names if name in EVENTS), "unknown")
        candidates = []
        if valid_frames > 1:
            for candidate, token in self._emotion_ids:
                value = float(scores[1, token])
                if np.isfinite(value):
                    candidates.append({"label": candidate, "score": value})
            candidates.sort(key=lambda item: item["score"], reverse=True)
        return {"label": label, "event": event, "raw_tags": raw_tags,
                "candidates": candidates[:3], "audio_quality": quality}
