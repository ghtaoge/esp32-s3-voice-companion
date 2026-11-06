"""Audit tracked/staged source before a public push; never print matched secrets."""
from __future__ import annotations

import argparse
from pathlib import Path
import re
import subprocess


ROOT = Path(__file__).resolve().parents[1]
PATTERNS = {
    "GitHub credential": re.compile(r"(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})"),
    "private key": re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    "real-looking WeChat AppID": re.compile(r"\bwx[a-fA-F0-9]{16}\b"),
    "personal absolute path": re.compile(r"[A-Za-z]:[/\\]Users[/\\](?!Public\b)[^/\\\s\"']+"),
}
FORBIDDEN = ("models/", ".local/", ".venv/", ".downloads/", "firmware/include/config.local.h", "firmware/include/config.h")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--staged", action="store_true")
    args = parser.parse_args()
    command = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"] if args.staged else ["git", "ls-files", "-z"]
    paths = subprocess.check_output(command, cwd=ROOT).decode("utf-8").split("\0")
    issues = []
    checked = 0
    for relative in filter(None, paths):
        path = ROOT / relative
        if relative.startswith(FORBIDDEN) or relative.endswith((".onnx", ".wav", ".pcm", ".sqlite3", ".bin")):
            issues.append((relative, "private configuration or binary asset"))
            continue
        content = subprocess.check_output(["git", "show", f":{relative}"], cwd=ROOT) if args.staged else path.read_bytes()
        if len(content) > 1024*1024:
            issues.append((relative, "unexpected source file larger than 1MiB"))
            continue
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            issues.append((relative, "unreviewed binary file"))
            continue
        checked += 1
        # This scanner's regex definitions are not credentials.
        if relative == "tools/check_public.py":
            continue
        for label, pattern in PATTERNS.items():
            if pattern.search(text):
                issues.append((relative, label))
        for name, value in re.findall(r'^\s*#define\s+(WIFI_SSID|WIFI_PASSWORD|PAIRING_TOKEN)\s+"([^"]+)"', text, re.MULTILINE):
            if not value.startswith(("YOUR_", "CHANGE_ME", "EXAMPLE_")):
                issues.append((relative, f"non-placeholder {name}"))
    for relative, reason in issues:
        print(f"BLOCKED {relative}: {reason}")
    print(f"Public source audit: {checked} files, {len(issues)} issue(s). Matched values are never printed.")
    return bool(issues)


if __name__ == "__main__":
    raise SystemExit(main())
