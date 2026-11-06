from __future__ import annotations

import json
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone


class HistoryConflict(ValueError):
    pass


class HistoryStore:
    """Final text only. Audio stays in bounded RAM and is not saved."""

    def __init__(self, path: Path, limit: int = 50):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.limit = limit
        self.lock = threading.Lock()
        self.db = sqlite3.connect(path, check_same_thread=False)
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript("""
            CREATE TABLE IF NOT EXISTS captions (
              device TEXT NOT NULL, recording TEXT NOT NULL, segment INTEGER NOT NULL,
              payload TEXT NOT NULL, created INTEGER PRIMARY KEY AUTOINCREMENT,
              UNIQUE(device, recording, segment));
            CREATE TABLE IF NOT EXISTS settings (device TEXT PRIMARY KEY, payload TEXT NOT NULL);
        """)

    def upsert(self, event: dict) -> None:
        with self.lock, self.db:
            self.db.execute("BEGIN IMMEDIATE")
            previous = self.db.execute("SELECT payload FROM captions WHERE device=? AND recording=? AND segment=?",
                                       (event["device_id"], event["recording_id"], event["segment_id"])).fetchone()
            if previous:
                previous = json.loads(previous[0])
                if previous.get("revision", 0) > event.get("revision", 0):
                    return
                if previous.get("emotion") and not event.get("emotion"):
                    event = {**event, "emotion": previous["emotion"]}
                # Delayed ASR/emotion writes cannot erase a newer manual edit,
                # including a null correction that restored the original.
                if previous.get("edit_version", 0) >= event.get("edit_version", 0):
                    event = {**event, **{name: previous[name] for name in
                             ("edit_version", "corrected_text", "corrected_at") if name in previous}}
            self.db.execute(
                "INSERT INTO captions(device,recording,segment,payload) VALUES(?,?,?,?) "
                "ON CONFLICT(device,recording,segment) DO UPDATE SET payload=excluded.payload",
                (event["device_id"], event["recording_id"], event["segment_id"], json.dumps(event, ensure_ascii=False)),
            )
            self.db.execute(
                "DELETE FROM captions WHERE device=? AND created NOT IN "
                "(SELECT created FROM captions WHERE device=? ORDER BY created DESC LIMIT ?)",
                (event["device_id"], event["device_id"], self.limit),
            )

    def correct(self, seed: dict, expected_version: int, text: str | None) -> dict:
        """Commit before acknowledging; original ASR text stays immutable."""
        with self.lock, self.db:
            # Serialize the read/version-check/write across SQLite connections,
            # not only threads sharing this HistoryStore instance.
            self.db.execute("BEGIN IMMEDIATE")
            row = self.db.execute("SELECT payload FROM captions WHERE device=? AND recording=? AND segment=?",
                                  (seed["device_id"], seed["recording_id"], seed["segment_id"])).fetchone()
            event = json.loads(row[0]) if row else dict(seed)
            if event.get("edit_version", 0) != expected_version:
                raise HistoryConflict("history version changed")
            event.update(edit_version=expected_version + 1, corrected_text=text,
                         corrected_at=datetime.now(timezone.utc).isoformat(timespec="milliseconds"))
            self.db.execute(
                "INSERT INTO captions(device,recording,segment,payload) VALUES(?,?,?,?) "
                "ON CONFLICT(device,recording,segment) DO UPDATE SET payload=excluded.payload",
                (event["device_id"], event["recording_id"], event["segment_id"], json.dumps(event, ensure_ascii=False)),
            )
            self.db.execute("DELETE FROM captions WHERE device=? AND created NOT IN "
                            "(SELECT created FROM captions WHERE device=? ORDER BY created DESC LIMIT ?)",
                            (event["device_id"], event["device_id"], self.limit))
            return event

    def history(self, device_id: str) -> list[dict]:
        with self.lock:
            rows = self.db.execute("SELECT payload FROM captions WHERE device=? ORDER BY created", (device_id,)).fetchall()
        return [json.loads(row[0]) for row in rows]

    def settings(self, device_id: str) -> dict | None:
        with self.lock:
            row = self.db.execute("SELECT payload FROM settings WHERE device=?", (device_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_settings(self, device_id: str, settings: dict) -> None:
        with self.lock, self.db:
            self.db.execute("INSERT OR REPLACE INTO settings VALUES(?,?)", (device_id, json.dumps(settings)))

    def close(self) -> None:
        with self.lock:
            self.db.close()
