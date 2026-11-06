"""Controlled real-time first-caption comparison, with identical local models."""
from __future__ import annotations

import argparse
from pathlib import Path
import json
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"backend"))


def main():
    import psutil
    import soundfile as sf
    from voice_companion.config import Config
    from voice_companion.inference import ASREngine
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repeats",type=int,default=3)
    parser.add_argument("--preroll-ms",default="0,300,480")
    parser.add_argument("--output",type=Path,default=ROOT/".local/preroll-profile.json")
    args = parser.parse_args()
    audio,rate=sf.read(ROOT/"models/_samples/asr_example.wav",dtype="int16")
    assert rate==16000 and audio.ndim==1
    pcm=audio.astype("<i2").tobytes()
    engine=ASREngine(Config(emotion_enabled=False))
    engine.load()
    process=psutil.Process()
    reports=[]
    try:
        # Interleave policies to reduce host-temperature/order bias.
        for _ in range(args.repeats):
            for preroll in map(int,args.preroll_ms.split(",")):
                engine.config.asr_preroll_ms=preroll
                session=engine.session()
                start=time.perf_counter()
                before=process.cpu_times()
                finals=[]
                for offset in range(0,len(pcm),640):
                    batch=session.feed(pcm[offset:offset+640])
                    finals.extend(e for e in batch.events if e["final"])
                    time.sleep(max(0,start+min(offset+640,len(pcm))/32000-time.perf_counter()))
                released=time.perf_counter()
                batch=session.feed(b"",final=True)
                final_ms=(time.perf_counter()-released)*1000
                finals.extend(e for e in batch.events if e["final"])
                after=process.cpu_times()
                assert len(finals)==1 and finals[0]["text"]=="欢迎大家来体验达摩院推出的语音识别模型。",finals
                entry={"preroll_ms":preroll,"first_partial_ms":round(session.first_partial_ms,1),
                    "speech_start_ms":finals[0]["start_ms"],
                    "speech_to_partial_ms":round(session.first_partial_ms-finals[0]["start_ms"],1),
                    "final_ms":round(final_ms,1),"cpu_ms":round(((after.user+after.system)-(before.user+before.system))*1000,1),
                    "same_text":True}
                reports.append(entry)
                print(json.dumps(entry),flush=True)
    finally:
        engine.close()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(reports,ensure_ascii=False,indent=2)+"\n",encoding="utf-8")


if __name__=="__main__":
    main()
