#!/usr/bin/env python3
"""Small reproducible SenseVoice INT8 study using PUBLIC labeled audio only.

Not a population accuracy benchmark. Samples are selected before inference from
CREMA-D voice-only votes, at least 8 raters and 75% agreement, one male/female
sample per emotion. Dataset: ODbL 1.0 / Database Contents License 1.0.
No private recording, pairing token, or recognized transcript is printed/saved.
The one-thread, low-priority model child pauses for live ASR on the local server.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import multiprocessing as mp
import os
from pathlib import Path
import queue
import re
import statistics
import sys
import threading
import time
from urllib.request import Request, urlopen
import wave

ROOT = Path(__file__).resolve().parents[1]
SOURCE = "https://raw.githubusercontent.com/CheyneyComputerScience/CREMA-D/master"
LABELS = {"A": "angry", "D": "disgusted", "F": "fearful", "H": "happy", "N": "neutral", "S": "sad"}
ACTED = {"ANG": "A", "DIS": "D", "FEA": "F", "HAP": "H", "NEU": "N", "SAD": "S"}


def fetch(url):
    for attempt in range(3):
        try:
            with urlopen(Request(url, headers={"User-Agent": "voice-companion-public-ser-study/1"}), timeout=30) as response:
                return response.read()
        except Exception:
            if attempt == 2:
                raise
            time.sleep(1)


def prepare(root: Path, per_label: int) -> list[dict]:
    folder = root / "models" / "_samples" / "emotion"
    folder.mkdir(parents=True, exist_ok=True)
    votes_path, demo_path = folder / "tabulatedVotes.csv", folder / "VideoDemographics.csv"
    for path, relative in ((votes_path, "processedResults/tabulatedVotes.csv"), (demo_path, "VideoDemographics.csv")):
        if not path.exists():
            path.write_bytes(fetch(f"{SOURCE}/{relative}"))
    demographics = {r["ActorID"]: r for r in csv.DictReader(io.StringIO(demo_path.read_text(encoding="utf-8-sig")))}
    votes = list(csv.DictReader(io.StringIO(votes_path.read_text(encoding="utf-8-sig"))))
    selected = []
    for code, canonical in LABELS.items():
        choices = []
        for row in votes:
            # Official tabulateVotesV2.r: ID = 100000*queryType + clipNum;
            # queryType=1 is voice-only, not audiovisual/face ratings.
            if not 100000 <= int(row[""]) < 200000:
                continue
            filename = row["fileName"]
            if row["emoVote"] != code or ACTED.get(filename.split("_")[2]) != code:
                continue
            if float(row["numResponses"]) < 8 or float(row["agreement"]) < .75:
                continue
            actor = filename.split("_")[0]
            choices.append((filename, row, demographics[actor]))
        choices.sort(key=lambda item: item[0])
        actors = set()
        for index in range(per_label):
            desired_sex = "Male" if index % 2 == 0 else "Female"
            candidate = next((c for c in choices if c[2]["Sex"] == desired_sex and c[0][:4] not in actors), None)
            if candidate is None:
                raise RuntimeError(f"No predeclared high-agreement {canonical}/{desired_sex} sample")
            filename, row, actor = candidate
            actors.add(filename[:4])
            path = folder / f"{filename}.wav"
            url = f"https://media.githubusercontent.com/media/CheyneyComputerScience/CREMA-D/master/AudioWAV/{filename}.wav"
            if not path.exists():
                path.write_bytes(fetch(url))
            with wave.open(str(path), "rb") as wav:
                if wav.getframerate() != 16000 or wav.getnchannels() != 1 or wav.getsampwidth() != 2:
                    raise ValueError(f"Unexpected public WAV format: {filename}")
            selected.append({"id": filename, "path": str(path), "reference": canonical,
                             "reference_kind": "CREMA-D high-agreement voice-only vote", "language": "en",
                             "voice_agreement": float(row["agreement"]), "raters": int(float(row["numResponses"])),
                             "sex": actor["Sex"], "source": url,
                             "sha256": hashlib.sha256(path.read_bytes()).hexdigest()})
    mandarin = root / "models" / "_samples" / "asr_example.wav"
    if mandarin.exists():
        selected.append({"id": "official_mandarin_asr_example", "path": str(mandarin), "reference": "neutral",
                         "reference_kind": "ordinary read-speech sanity check, not human SER gold", "language": "zh",
                         "source": "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online/example/asr_example.wav",
                         "sha256": hashlib.sha256(mandarin.read_bytes()).hexdigest()})
    (folder / "manifest.json").write_text(json.dumps({"license": "ODbL 1.0 / DbCL 1.0 (CREMA-D)",
        "source": "https://github.com/CheyneyComputerScience/CREMA-D", "selection": "pre-inference, filename order; voice-only >=8 raters, >=75% agreement; alternating male/female per label",
        "samples": selected}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return selected


def worker(root: str, requests, responses):
    os.environ.update(OMP_NUM_THREADS="1", OPENBLAS_NUM_THREADS="1", MKL_NUM_THREADS="1")
    sys.path.insert(0, str(Path(root) / "backend"))
    import numpy as np
    import psutil
    import sentencepiece as spm
    import soundfile as sf
    from voice_companion.models import EmotionRecognizer, EMOTIONS, EVENTS, VadSegmenter
    process = psutil.Process()
    process.nice(psutil.BELOW_NORMAL_PRIORITY_CLASS if os.name == "nt" else 10)
    try:
        recognizer = EmotionRecognizer(Path(root) / "models", threads=1)
        tokenizer = spm.SentencePieceProcessor(model_file=str(Path(root) / "models/emotion/chn_jpn_yue_eng_ko_spectok.bpe.model"))
        emotion_ids = {tag: tokenizer.piece_to_id(f"<|{tag}|>") for tag in EMOTIONS if tag != "UNKNOWN"}
        vad = None
        cache = {}
        responses.put({"ready": True})
        while True:
            job = requests.get()
            if job is None:
                return
            sample = job["sample"]
            if sample["id"] not in cache:
                audio, sr = sf.read(sample["path"], dtype="float32")
                if sr != 16000 or audio.ndim != 1:
                    raise ValueError("Study requires 16k mono public WAV")
                cache[sample["id"]] = (audio, None)
            original, bounds = cache[sample["id"]]
            audio = original
            start, end = 0, len(audio)
            if job["crop"].startswith("vad"):
                if vad is None:
                    vad = VadSegmenter(Path(root) / "models", threads=1)
                if bounds is None:
                    vad.reset()
                    pcm = np.clip(np.rint(original * 32768), -32768, 32767).astype("<i2").tobytes()
                    pairs = []
                    for offset in range(0, len(pcm), 3200):
                        pairs.extend(vad.accept(pcm[offset:offset + 3200]))
                    pairs.extend(vad.accept(b"", final=True))
                    spans, opening = [], None
                    for a, b in pairs:
                        if a >= 0:
                            opening = a
                        if b >= 0 and opening is not None:
                            spans.append((opening * 16, min(b * 16, len(original))))
                            opening = None
                    bounds = max(spans, key=lambda p: p[1] - p[0]) if spans else (0, len(original))
                    cache[sample["id"]] = (original, bounds)
                start, end = bounds
                if job["crop"] == "vad_context":
                    start, end = max(0, start - 2400), min(len(audio), end + 2400)
            elif job["crop"].startswith("head"):
                end = min(end, int(job["crop"][4:]) * 16)
            audio = np.asarray(audio[start:end] * job["gain"], dtype=np.float32)
            audio = np.clip(audio, -1, 32767 / 32768)
            begin = time.perf_counter()
            cpu_begin = time.process_time()
            if job["variant"] in ("production", "upstream_itn"):
                model = recognizer.model
                native_infer = model.infer
                forwards = [0]
                def counted(*values):
                    forwards[0] += 1
                    return native_infer(*values)
                model.infer = counted
                try:
                    if job["variant"] == "production":
                        pcm = np.clip(np.rint(audio * 32768), -32768, 32767).astype("<i2").tobytes()
                        decoded = recognizer.analyze(pcm)
                    else:
                        native = model(audio, language="auto", textnorm="withitn")[0]
                        tags = re.findall(r"<\|[^|>]+\|>", native)
                        tag_names = [tag[2:-2].upper() for tag in tags]
                        decoded = {"label": next((EMOTIONS[n] for n in tag_names if n in EMOTIONS), "unknown"),
                            "event": next((EVENTS[n] for n in tag_names if n in EVENTS), "unknown"), "raw_tags": tags}
                finally:
                    model.infer = native_infer
                responses.put({"id": sample["id"], "variant": job["variant"], "reference": sample["reference"],
                    "reference_kind": sample["reference_kind"], **decoded, "forward_calls": forwards[0],
                    "inference_ms": (time.perf_counter() - begin) * 1000,
                    "cpu_ms": (time.process_time() - cpu_begin) * 1000})
                continue
            # Same official greedy CTC decoding, with the already-computed
            # prefix-frame scores retained as UNCALIBRATED evidence only.
            model = recognizer.model
            features, lengths = model.extract_feat([audio])
            logits, output_lengths = model.infer(features, lengths,
                np.array([model.lid_dict[job["language"]]], dtype=np.int32),
                np.array([model.textnorm_dict[job["textnorm"]]], dtype=np.int32))
            x = logits[0, :int(output_lengths[0]), :]
            ids = np.argmax(x, axis=-1)
            ids = ids[np.concatenate(([True], np.diff(ids) != 0))]
            raw = model.tokenizer.decode(ids[ids != model.blank_id].tolist())
            raw_tags = re.findall(r"<\|[^|>]+\|>", raw)
            names = [t[2:-2].upper() for t in raw_tags]
            label = next((EMOTIONS[n] for n in names if n in EMOTIONS), "unknown")
            event = next((EVENTS[n] for n in names if n in EVENTS), "unknown")
            score_rows = sorted(({"tag": tag, "score": float(x[1, token])} for tag, token in emotion_ids.items()),
                                key=lambda r: r["score"], reverse=True)
            result = {"id": sample["id"], "variant": job["variant"], "reference": sample["reference"],
                "reference_kind": sample["reference_kind"], "label": label, "event": event, "raw_tags": raw_tags,
                "language": job["language"], "textnorm": job["textnorm"], "crop": job["crop"], "gain": job["gain"],
                "clip_start_ms": start / 16, "duration_ms": len(audio) / 16,
                "peak": float(np.max(np.abs(audio))), "rms_dbfs": float(20 * np.log10(max(float(np.sqrt(np.mean(audio.astype(np.float64) ** 2))), 1e-12))),
                "clipping_ratio": float(np.mean((audio >= 32767 / 32768) | (audio <= -1))),
                "prefix_frame_1_top2": score_rows[:2], "prefix_score_margin": score_rows[0]["score"] - score_rows[1]["score"],
                "inference_ms": (time.perf_counter() - begin) * 1000,
                "cpu_ms": (time.process_time() - cpu_begin) * 1000}
            responses.put(result)
    except Exception as exc:
        responses.put({"error": type(exc).__name__, "detail": str(exc)})


class LiveASRWatch:
    def __init__(self, root, process, port):
        self.root, self.process, self.port = root, process, port
        self.closed = threading.Event()
        self.lock = threading.Lock()
        self.suspended = False

    def pause(self, busy):
        import psutil
        with self.lock:
            if not self.process.is_alive():
                return
            try:
                target = psutil.Process(self.process.pid)
                if busy and not self.suspended:
                    target.suspend()
                    self.suspended = True
                elif not busy and self.suspended:
                    target.resume()
                    self.suspended = False
            except psutil.Error:
                pass

    def run(self):
        from websockets.sync.client import connect
        token_path = self.root / ".local" / "pairing-token.txt"
        if not token_path.exists():
            return
        from urllib.parse import quote
        token = quote(token_path.read_text(encoding="utf-8").strip(), safe="")
        # Credentials are used locally only; never include this URI in reports.
        url = f"ws://127.0.0.1:{self.port}/ws/client/esp32-s3?token={token}"
        while not self.closed.is_set():
            try:
                with connect(url, open_timeout=2) as connection:
                    while not self.closed.is_set():
                        try:
                            event = json.loads(connection.recv(timeout=.2))
                        except TimeoutError:
                            continue
                        if event.get("type") in ("snapshot", "status"):
                            self.pause(event.get("state") in ("recording", "processing"))
            except Exception:
                self.pause(False)
                self.closed.wait(1)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--per-label", type=int, default=2)
    parser.add_argument("--suite", choices=["prompts", "duration", "cuts", "gain", "parity", "all"], default="prompts")
    parser.add_argument("--watch-port", type=int, default=8765, help="0 disables live-ASR preemption")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    samples = prepare(args.root, args.per_label)
    print(f"Prepared {len(samples)} public samples; private audio is never read.", flush=True)
    if args.prepare_only:
        return
    context = mp.get_context("spawn")
    requests, responses = context.Queue(1), context.Queue(4)
    process = context.Process(target=worker, args=(str(args.root), requests, responses), daemon=True)
    process.start()
    watch = LiveASRWatch(args.root, process, args.watch_port)
    watcher = threading.Thread(target=watch.run, daemon=True) if args.watch_port else None
    if watcher:
        watcher.start()
    records = []
    try:
        ready = responses.get(timeout=90)
        if not ready.get("ready"):
            raise RuntimeError(ready)
        for sample in samples:
            variants = [("baseline", "auto", "woitn", "full", 1)]
            if args.suite == "parity":
                variants = [(name, "auto", "withitn", "full", 1) for name in ("upstream_itn", "production")]
            if args.suite in ("prompts", "all"):
                variants.extend([("official_itn", "auto", "withitn", "full", 1),
                    ("known_language", sample["language"], "woitn", "full", 1),
                    ("known_language_itn", sample["language"], "withitn", "full", 1)])
            if args.suite in ("duration", "all"):
                variants.extend([(f"head{ms}", "auto", "woitn", f"head{ms}", 1) for ms in (300, 600, 1000, 2000)])
            if args.suite in ("cuts", "all"):
                variants.extend([(name, "auto", "woitn", name, 1) for name in ("vad", "vad_context")])
            if args.suite in ("gain", "all"):
                variants.extend([("gain_quiet", "auto", "woitn", "full", .25), ("gain_clipped", "auto", "woitn", "full", 4)])
            for variant, language, textnorm, crop, gain in variants:
                requests.put({"sample": sample, "variant": variant, "language": language, "textnorm": textnorm, "crop": crop, "gain": gain})
                while True:
                    try:
                        result = responses.get(timeout=.25)
                        break
                    except queue.Empty:
                        if not process.is_alive():
                            raise RuntimeError("Study worker exited")
                if "error" in result:
                    raise RuntimeError(result)
                records.append(result)
            print(f"Compared {sample['id']} ({len(records)} trials)", flush=True)
    finally:
        watch.closed.set()
        watch.pause(False)
        if process.is_alive():
            process.terminate()
        process.join(3)
        requests.cancel_join_thread()
        responses.cancel_join_thread()
        requests.close()
        responses.close()
    summaries = {}
    for variant in sorted({r["variant"] for r in records}):
        group = [r for r in records if r["variant"] == variant and r["reference_kind"].startswith("CREMA-D")]
        summaries[variant] = {"trials": len(group), "reference_matches": sum(r["label"] == r["reference"] for r in group),
                              "median_ms": statistics.median(r["inference_ms"] for r in group)}
    from importlib.metadata import version
    report = {"scope": "Small public, preselected high-agreement English acted-speech study, not Chinese deployment accuracy or calibrated confidence",
        "timing_note": "Wall inference_ms may include live-ASR preemption; cpu_ms (when present) excludes process suspension. This is an accuracy study, not an isolated latency benchmark.",
        "score_definition": "Raw ONNX output scores at multitask prefix frame 1 over emotion tags; scores/margins are NOT calibrated confidence",
        "model": json.loads((args.root / "models/manifest.json").read_text(encoding="utf-8"))["models"]["emotion"],
        "versions": {name: version(name) for name in ("funasr-onnx", "onnxruntime", "numpy")},
        "suite": args.suite, "samples": samples, "summaries": summaries, "records": records}
    output = args.output or args.root / ".local" / f"emotion-study-{args.suite}.json"
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(summaries, ensure_ascii=False, indent=2))
    print(f"Saved public-only study: {output}")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    main()
