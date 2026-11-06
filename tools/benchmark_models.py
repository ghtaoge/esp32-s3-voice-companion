#!/usr/bin/env python3
"""Run real local models on a 16 kHz mono WAV; report cold/warm CPU latency.

Example: python tools/benchmark_models.py models/_samples/asr_example.wav
No network request, model export, fake recognizer, or wall-clock replay sleeps.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import platform
import sys
from time import perf_counter

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np
import soundfile as sf

from voice_companion.models import EmotionRecognizer, OnlineRecognizer, Punctuator, VadSegmenter


def timed(factory):
    start = perf_counter()
    instance = factory()
    return instance, (perf_counter() - start) * 1000


def transcribe(model, pcm, packet_bytes=640):
    model.reset()
    parts = []
    inference_ms = []
    begin = perf_counter()
    for offset in range(0, len(pcm), packet_bytes):
        call = perf_counter()
        parts.append(model.accept(pcm[offset:offset + packet_bytes]))
        elapsed = (perf_counter() - call) * 1000
        if elapsed >= 1:
            inference_ms.append(elapsed)
    call = perf_counter()
    parts.append(model.accept(b"", final=True))
    inference_ms.append((perf_counter() - call) * 1000)
    return "".join(parts), (perf_counter() - begin) * 1000, inference_ms


def segment(model, pcm, packet_bytes):
    model.reset()
    events = []
    start = perf_counter()
    for offset in range(0, len(pcm), packet_bytes):
        events.extend(model.accept(pcm[offset:offset + packet_bytes]))
    events.extend(model.accept(b"", final=True))
    return events, (perf_counter() - start) * 1000


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--root", type=Path, default=ROOT / "models")
    parser.add_argument("--threads", type=int, default=3)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    audio, sample_rate = sf.read(args.wav, dtype="int16")
    if sample_rate != 16000 or audio.ndim != 1 or not audio.size:
        raise ValueError("Input WAV must be nonempty 16000 Hz mono audio")
    pcm = audio.astype("<i2").tobytes()
    asr, asr_load = timed(lambda: OnlineRecognizer(args.root, args.threads))
    vad, vad_load = timed(lambda: VadSegmenter(args.root))
    punc, punc_load = timed(lambda: Punctuator(args.root))
    emotion, emotion_load = timed(lambda: EmotionRecognizer(args.root))
    cold_text, cold_ms, _ = transcribe(asr, pcm)
    text, warm_ms, calls = transcribe(asr, pcm)
    if not text.strip() or cold_text != text:
        raise AssertionError("Nonempty recognition and deterministic reset replay are required")
    events_20, vad_ms = segment(vad, pcm, 640)
    events_100, _ = segment(vad, pcm, 3200)
    if events_20 != events_100:
        raise AssertionError(f"VAD packetization/reset changed results: {events_20} != {events_100}")
    start = perf_counter()
    punctuated = punc.apply(text)
    punc_ms = (perf_counter() - start) * 1000
    start = perf_counter()
    tags = emotion.analyze(pcm)
    emotion_ms = (perf_counter() - start) * 1000
    # 480 ms chunks plus a real 20 ms residual exercise upstream's <60 ms
    # final-packet path, which otherwise discards new final samples.
    tail_samples = min(len(audio), 5 * asr.chunk_samples + 320)
    tail_pcm = pcm[:tail_samples * 2]
    tail_text, _, _ = transcribe(asr, tail_pcm)
    again, _, _ = transcribe(asr, tail_pcm, 3200)
    if tail_text != again:
        raise AssertionError("Short-tail packetization/reset changed ASR output")
    result = {
        "sample": str(args.wav.resolve()), "sample_sha256": hashlib.sha256(args.wav.read_bytes()).hexdigest(),
        "audio_ms": len(audio) / 16,
        "platform": platform.platform(), "python": platform.python_version(),
        "asr_threads": args.threads, "chunk_samples": asr.chunk_samples,
        "chunk_size": list(asr.chunk_size),
        "load_ms": {"online": asr_load, "vad": vad_load, "punc": punc_load, "emotion": emotion_load},
        "asr_cold_ms": cold_ms, "asr_warm_ms": warm_ms,
        "asr_warm_rtf": warm_ms / (len(audio) / 16),
        "asr_decode_p95_ms": float(np.percentile(calls, 95)),
        "vad_ms": vad_ms, "punctuation_ms": punc_ms, "emotion_ms": emotion_ms,
        "text": text, "punctuated": punctuated, "vad_events": events_20,
        "emotion": tags, "short_tail_text": tail_text,
        "checks": {"asr_reset_replay": True, "vad_reset_and_packetization": True, "short_final_packet": True},
        "note": "One official sample, not an accuracy benchmark. Timings exclude real-time sleeps; emotion is a separate background task.",
    }
    payload = json.dumps(result, ensure_ascii=False, indent=2)
    print(payload)
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(payload + "\n", encoding="utf-8")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
