"""Compare actual CPU ORT policies without changing installed packages.

This profiling process temporarily intercepts only session construction. Each
policy loads the same local INT8 weights and verifies the same decoded text.
"""
from __future__ import annotations

import argparse
import gc
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))


def cpu_seconds(process):
    times = process.cpu_times()
    return times.user + times.system


def recognize(model, pcm, paced=False):
    model.reset()
    pieces, calls = [], []
    begin = time.perf_counter()
    for index in range(0, len(pcm), 640):
        call = time.perf_counter()
        pieces.append(model.accept(pcm[index:index+640]))
        duration = (time.perf_counter()-call)*1000
        if duration > 1:
            calls.append(duration)
        if paced:
            target = begin + min(index+640,len(pcm))/32000
            time.sleep(max(0,target-time.perf_counter()))
    call = time.perf_counter()
    pieces.append(model.accept(b"", final=True))
    calls.append((time.perf_counter()-call)*1000)
    return "".join(pieces), (time.perf_counter()-begin)*1000, calls


def main():
    import numpy as np
    import psutil
    import soundfile as sf
    from voice_companion.models import OnlineRecognizer
    from voice_companion.ort_session import session_policy
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--wav", type=Path, default=ROOT / "models/_samples/asr_example.wav")
    parser.add_argument("--threads", default="3")
    parser.add_argument("--repeats", type=int, default=5)
    parser.add_argument("--policies", default="baseline,no_spin,no_spin_arena")
    parser.add_argument("--output", type=Path, default=ROOT / ".local/runtime-profile.json")
    args = parser.parse_args()
    audio, rate = sf.read(args.wav, dtype="int16")
    assert rate == 16000 and audio.ndim == 1
    pcm = audio.astype("<i2").tobytes()
    process = psutil.Process()
    reports, expected = [], None
    for threads in map(int,args.threads.split(",")):
        for name, spin, arena in (("baseline",True,False),("no_spin",False,False),("no_spin_arena",False,True)):
            if name not in args.policies.split(","):
                continue
            with session_policy(spin,arena):
                model = OnlineRecognizer(ROOT / "models", threads=threads)
            recognize(model,pcm)
            cpu_begin, idle_begin = cpu_seconds(process), time.perf_counter()
            time.sleep(1)
            idle_pct = (cpu_seconds(process)-cpu_begin)/(time.perf_counter()-idle_begin)*100
            durations, all_calls, memory = [], [], []
            for _ in range(args.repeats):
                text, elapsed, calls = recognize(model,pcm)
                if expected is None:
                    expected = text
                if text != expected:
                    raise AssertionError(f"Policy changed transcription: {name}/{threads}: {text!r}")
                durations.append(elapsed)
                all_calls.extend(calls)
                memory.append(process.memory_info().rss/1024/1024)
            cpu_begin = cpu_seconds(process)
            _, wall_ms, _ = recognize(model,pcm,paced=True)
            paced_pct = (cpu_seconds(process)-cpu_begin)/(wall_ms/1000)*100
            report = {"policy":name,"threads":threads,"audio_ms":len(pcm)/32,
                "bulk_median_ms":round(float(np.median(durations)),1),"bulk_max_ms":round(max(durations),1),
                "decode_p95_ms":round(float(np.percentile(all_calls,95)),1),
                "paced_cpu_one_core_pct":round(paced_pct,1),"post_inference_idle_cpu_pct":round(idle_pct,1),
                "rss_mib":round(memory[-1],1),"repeat_rss_growth_mib":round(max(memory)-min(memory),1),"same_text":True}
            reports.append(report)
            print(json.dumps(report,ensure_ascii=False),flush=True)
            del model
            gc.collect()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps({"sample_sha256":__import__('hashlib').sha256(args.wav.read_bytes()).hexdigest(),"text":expected,"reports":reports},ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


if __name__ == "__main__":
    if hasattr(sys.stdout,"reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
