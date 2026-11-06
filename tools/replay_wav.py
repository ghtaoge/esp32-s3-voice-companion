"""Replay an actual WAV as a PTT device; measures local end-to-end caption timings."""
from __future__ import annotations

import argparse
import asyncio
import json
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import numpy as np
import soundfile as sf
from websockets.asyncio.client import connect


async def run(args):
    root = Path(__file__).resolve().parents[1]
    token = (root / ".local/pairing-token.txt").read_text(encoding="utf-8").strip()
    audio, rate = sf.read(args.wav, dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if rate != 16000:
        from math import gcd
        from scipy.signal import resample_poly
        divisor = gcd(rate, 16000)
        audio = resample_poly(audio, 16000 // divisor, rate // divisor)
    pcm = np.clip(audio * 32767, -32768, 32767).astype("<i2").tobytes()
    if not pcm or len(pcm) > 60 * 32000:
        raise ValueError("样例应为0..60秒非空音频")
    recording_id = "replay-" + uuid.uuid4().hex
    url = f"ws://{args.host}:{args.port}/ws/device/{quote(args.device_id)}?token={quote(token)}"
    async with connect(url, compression=None, max_size=128*1024) as websocket:
        await websocket.send(json.dumps({"type": "hello", "protocol": 1}))
        await websocket.send(json.dumps({"type": "record_start", "recording_id": recording_id}))
        async with asyncio.timeout(30):
            while True:
                event = json.loads(await websocket.recv())
                if event["type"] == "error":
                    raise RuntimeError(event["message"])
                if event["type"] == "record_ready":
                    break
        started = time.perf_counter()
        async def send_audio():
            for index in range(0, len(pcm), 3200):
                await websocket.send(pcm[index:index+3200])
                if not args.burst:
                    await asyncio.sleep(max(0, started + min(index+3200, len(pcm))/32000 - time.perf_counter()))
            await websocket.send(json.dumps({"type": "record_stop", "recording_id": recording_id}))
        sender = asyncio.create_task(send_audio())
        finals, first_partial, emotions = {}, None, set()
        async with asyncio.timeout(90):
            while True:
                event = json.loads(await websocket.recv())
                if event["type"] == "error":
                    sender.cancel()
                    raise RuntimeError(event["message"])
                if event["type"] == "transcript":
                    if first_partial is None:
                        first_partial = round((time.perf_counter()-started)*1000, 1)
                    if event["final"]:
                        finals[event["segment_id"]] = event["text"]
                        print("分句：", event["text"])
                if event["type"] == "emotion" and event.get("recording_id") == recording_id:
                    emotions.add(event["segment_id"])
                    print("情绪：", json.dumps(event, ensure_ascii=False))
                if event["type"] == "recording_done":
                    await sender
                    print(json.dumps({"audio_ms": event["audio_ms"], "first_caption_ms": first_partial,
                        "release_to_final_ms": event["final_latency_ms"], "asr_inference_ms": event.get("asr_inference_ms"),
                        "segments": event["segments"], "text": "".join(finals[key] for key in sorted(finals))}, ensure_ascii=False, indent=2))
                    break
        if args.wait_emotion:
            try:
                async with asyncio.timeout(30):
                    remaining = set(finals) - emotions
                    while remaining:
                        event = json.loads(await websocket.recv())
                        if event["type"] == "emotion" and event.get("recording_id") == recording_id:
                            remaining.discard(event["segment_id"])
                            print("情绪：", json.dumps(event, ensure_ascii=False))
            except TimeoutError:
                print("情绪未在30秒内补齐；字幕已完成。")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("wav", type=Path)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--device-id", default="esp32-s3")
    parser.add_argument("--burst", action="store_true", help="吞吐测试；可能触发明确的音频过载保护，不代表实时延迟")
    parser.add_argument("--wait-emotion", action="store_true")
    asyncio.run(run(parser.parse_args()))
