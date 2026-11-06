#!/usr/bin/env python3
"""Fetch only official, pre-exported INT8 ONNX assets from ModelScope.

Run once while connected to the Internet; inference never downloads or exports.
The manifest records the upstream revision, SHA-256, size and model license.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

API = "https://modelscope.cn/api/v1/models"
SPECS = {
    "online": (
        "iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-online-onnx",
        ("model_quant.onnx", "decoder_quant.onnx", "config.yaml", "am.mvn", "tokens.json"),
    ),
    "vad": (
        "iic/speech_fsmn_vad_zh-cn-16k-common-onnx",
        ("model_quant.onnx", "config.yaml", "am.mvn"),
    ),
    "punc": (
        "iic/punc_ct-transformer_zh-cn-common-vocab272727-onnx",
        ("model_quant.onnx", "config.yaml", "tokens.json"),
    ),
    "emotion": (
        "iic/SenseVoiceSmall-onnx",
        ("model_quant.onnx", "config.yaml", "am.mvn", "chn_jpn_yue_eng_ko_spectok.bpe.model"),
    ),
}
# The official ONNX repository omits this tokenizer. Fetch that file alone from
# the official source checkpoint, never its PyTorch weights.
TOKENIZER_SOURCE = "iic/SenseVoiceSmall"
TOKENIZER_FILE = "chn_jpn_yue_eng_ko_spectok.bpe.model"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def request(url: str):
    return urlopen(Request(url, headers={"User-Agent": "voice-companion-model-setup/1.0"}), timeout=90)


def api_json(url: str) -> dict:
    with request(url) as response:
        data = json.load(response)
    if data.get("Code") != 200 or not data.get("Success", True):
        raise RuntimeError(f"ModelScope API failed: {data.get('Message', data)}")
    return data["Data"]


def file_list(model_id: str, revision: str) -> dict:
    query = urlencode({"Revision": revision, "Recursive": "true"})
    return {f["Path"]: f for f in api_json(f"{API}/{quote(model_id, safe='/')}/repo/files?{query}")["Files"] if f["Type"] == "blob"}


def valid_file(path: Path, metadata: dict) -> bool:
    return path.is_file() and path.stat().st_size == metadata["size"] and sha256_file(path) == metadata["sha256"]


def fetch_file(model_id: str, upstream: dict, output: Path) -> dict:
    revision = upstream["Revision"]
    metadata = {
        "source_model_id": model_id,
        "source_path": upstream["Path"],
        "revision": revision,
        "size": int(upstream["Size"]),
        "sha256": upstream["Sha256"].lower(),
    }
    if not metadata["sha256"] or metadata["size"] <= 0:
        raise RuntimeError(f"Upstream lacks a checksum/size for {model_id}/{upstream['Path']}")
    if valid_file(output, metadata):
        print(f"  cached {output.parent.name}/{output.name}", flush=True)
        return metadata
    query = urlencode({"Revision": revision, "FilePath": upstream["Path"]})
    url = f"{API}/{quote(model_id, safe='/')}/repo?{query}"
    output.parent.mkdir(parents=True, exist_ok=True)
    partial = output.with_name(output.name + ".download")
    for attempt in range(3):
        try:
            digest = hashlib.sha256()
            received = 0
            with request(url) as response, partial.open("wb") as stream:
                while block := response.read(4 * 1024 * 1024):
                    stream.write(block)
                    digest.update(block)
                    received += len(block)
            if received != metadata["size"] or digest.hexdigest() != metadata["sha256"]:
                raise RuntimeError(f"Checksum/size mismatch for {model_id}/{upstream['Path']}")
            partial.replace(output)
            print(f"  downloaded {output.parent.name}/{output.name} ({received / 1_000_000:.1f} MB)", flush=True)
            return metadata
        except Exception:
            if attempt == 2:
                raise
            time.sleep(attempt + 1)
    raise AssertionError("unreachable")


def download_component(name: str, root: Path, revision: str) -> dict:
    model_id, required = SPECS[name]
    print(f"[{name}] {model_id}", flush=True)
    files = file_list(model_id, revision)
    info = api_json(f"{API}/{quote(model_id, safe='/')}")
    license_name = info.get("License")
    if not license_name:
        raise RuntimeError(f"Missing model license metadata: {model_id}")
    record = {
        "model_id": model_id,
        "requested_revision": revision,
        "license": license_name,
        "license_source": f"https://modelscope.cn/models/{model_id}",
        "files": {},
    }
    # Retain the upstream model card alongside the model for attribution.
    selected = list(required) + [n for n in ("README.md", "configuration.json") if n in files]
    for filename in selected:
        source_id = model_id
        source_files = files
        if name == "emotion" and filename == TOKENIZER_FILE and filename not in files:
            source_id = TOKENIZER_SOURCE
            source_files = file_list(source_id, revision)
        if filename not in source_files:
            raise RuntimeError(f"Required file {filename} missing from {source_id}@{revision}; no runtime export fallback")
        record["files"][filename] = fetch_file(source_id, source_files[filename], root / name / filename)
    return record


def check_component(name: str, root: Path, manifest: dict) -> None:
    record = manifest.get("models", {}).get(name)
    if not record:
        raise RuntimeError(f"[{name}] missing manifest entry; run this tool without --check first")
    for filename in SPECS[name][1]:
        metadata = record.get("files", {}).get(filename)
        if not metadata or not valid_file(root / name / filename, metadata):
            raise RuntimeError(f"[{name}] missing/corrupt file: {root / name / filename}; rerun download")
    print(f"[{name}] OK — SHA-256 verified, {record['license']}", flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[1] / "models")
    parser.add_argument("--model", nargs="+", choices=["all", *SPECS], default=["all"], help="Components to download/check (default: all)")
    parser.add_argument("--revision", default="master", help="Requested ModelScope revision; resolved file commits go into manifest")
    parser.add_argument("--check", action="store_true", help="Offline SHA-256 check; never accesses the network")
    args = parser.parse_args()
    names = list(SPECS) if "all" in args.model else list(dict.fromkeys(args.model))
    root = args.root.expanduser().resolve()
    manifest_path = root / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {"schema": 1, "models": {}}
    errors = []
    if args.check:
        for name in names:
            try:
                check_component(name, root, manifest)
            except Exception as exc:
                errors.append(str(exc))
    else:
        root.mkdir(parents=True, exist_ok=True)
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = {pool.submit(download_component, n, root, args.revision): n for n in names}
            for future in as_completed(futures):
                name = futures[future]
                try:
                    manifest["models"][name] = future.result()
                except Exception as exc:
                    errors.append(f"[{name}] {exc}")
        manifest["updated_utc"] = datetime.now(timezone.utc).isoformat()
        partial_manifest = manifest_path.with_suffix(".json.tmp")
        partial_manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        partial_manifest.replace(manifest_path)
    for message in errors:
        print(message, file=sys.stderr)
    if errors:
        return 1
    print(f"Ready: {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
