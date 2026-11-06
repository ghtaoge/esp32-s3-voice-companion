"""Persistence/concurrency boundaries; no ASR or emotion model is loaded."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from threading import Barrier, Event
from types import SimpleNamespace

import pytest

from voice_companion.config import Config
from voice_companion.service import Device, Hub
from voice_companion.storage import HistoryConflict, HistoryStore


def caption(recording="recording", **extra):
    return {"type": "transcript", "device_id": "esp32-s3", "recording_id": recording,
            "segment_id": 0, "revision": 2, "final": True, "text": "原始识别文字。", **extra}


def test_correction_restore_and_late_writes_keep_original_and_edit_version(tmp_path):
    path = tmp_path / "history.sqlite3"
    store = HistoryStore(path)
    original = caption()
    store.upsert(original)
    edited = store.correct(original, 0, "人工校对。")
    store.upsert(caption(emotion={"label": "sad", "status": "ready"}))
    assert store.history("esp32-s3")[0]["corrected_text"] == "人工校对。"
    restored = store.correct(original, 1, None)
    assert restored["edit_version"] == 2
    # A previously captured IO payload must not resurrect the edited version.
    store.upsert({**edited, "emotion": {"label": "neutral", "status": "ready"}})
    store.close()
    reopened = HistoryStore(path)
    saved = reopened.history("esp32-s3")[0]
    assert saved["text"] == original["text"]
    assert saved["corrected_text"] is None
    assert saved["edit_version"] == 2
    assert saved["emotion"]["label"] == "neutral"
    with pytest.raises(HistoryConflict):
        reopened.correct(original, 1, "不应覆盖。")
    assert reopened.history("esp32-s3")[0] == saved
    reopened.close()


def test_optimistic_version_is_atomic_across_database_connections(tmp_path):
    path = tmp_path / "history.sqlite3"
    left, right = HistoryStore(path), HistoryStore(path)
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            for iteration in range(8):
                original = caption(f"concurrent-{iteration}")
                left.upsert(original)
                barrier = Barrier(2)
                def edit(store, text):
                    barrier.wait(timeout=2)
                    try:
                        return store.correct(original, 0, text)
                    except HistoryConflict:
                        return None
                futures = [executor.submit(edit, left, "甲方校对"), executor.submit(edit, right, "乙方校对")]
                answers = [future.result(timeout=5) for future in futures]
                winners = [answer for answer in answers if answer is not None]
                assert len(winners) == 1, "One edit_version=0 must produce exactly one committed winner"
                saved = next(e for e in left.history("esp32-s3") if e["recording_id"] == original["recording_id"])
                assert saved["edit_version"] == 1
                assert saved["corrected_text"] == winners[0]["corrected_text"]
    finally:
        left.close()
        right.close()


def test_late_upsert_cannot_erase_a_correction_committed_on_another_connection(tmp_path):
    path = tmp_path / "history.sqlite3"
    late, editor = HistoryStore(path), HistoryStore(path)
    original = caption()
    editor.upsert(original)
    read, proceed = Event(), Event()
    native_db = late.db

    class ReadGate:
        """Pause a late ASR/emotion write immediately after its history read."""
        armed = True

        def __getattr__(self, name):
            return getattr(native_db, name)

        def __enter__(self):
            return native_db.__enter__()

        def __exit__(self, *args):
            return native_db.__exit__(*args)

        def execute(self, statement, *args):
            cursor = native_db.execute(statement, *args)
            if self.armed and statement.startswith("SELECT payload FROM captions"):
                self.armed = False
                previous = cursor.fetchone()

                class Snapshot:
                    def fetchone(self):
                        read.set()
                        assert proceed.wait(timeout=3)
                        return previous

                return Snapshot()
            return cursor

    late.db = ReadGate()
    try:
        with ThreadPoolExecutor(max_workers=2) as executor:
            delayed = executor.submit(late.upsert, caption(emotion={"label": "sad", "status": "ready"}))
            try:
                assert read.wait(timeout=2)
                edited = executor.submit(editor.correct, original, 0, "已持久化的校对")
                # With an unprotected read, make the conflicting edit commit
                # first deterministically. A protected read already owns the
                # write transaction, so it must finish before the edit can.
                if not native_db.in_transaction:
                    edited.result(timeout=2)
            finally:
                proceed.set()
            delayed.result(timeout=3)
            edited.result(timeout=3)
        saved = editor.history("esp32-s3")[0]
        assert saved["text"] == original["text"]
        assert saved["corrected_text"] == "已持久化的校对"
        assert saved["edit_version"] == 1
        assert saved["emotion"]["label"] == "sad"
    finally:
        proceed.set()
        late.close()
        editor.close()


class Sink:
    def __init__(self, role="client"):
        self.role, self.device_id, self.alive = role, "esp32-s3", True
        self.events = []

    def send(self, event):
        self.events.append(deepcopy(event))
        return True

    async def close(self):
        self.alive = False


def setup_hub(tmp_path):
    hub = Hub(Config(root=tmp_path, token="test-history-token-000000", emotion_enabled=False),
              engine=SimpleNamespace(), emotion=SimpleNamespace())
    owner, board = Sink(), Sink("device")
    device = Device("esp32-s3", peer=board, state="idle", capabilities={"history_display"})
    entry = caption()
    device.history[(entry["recording_id"], 0)] = entry
    hub.devices[device.device_id] = device
    hub.peers.update((owner, board))
    hub.store.upsert(entry)
    return hub, device, owner, board


async def cleanup(hub, device):
    for timer in (device.display_timer, device.settings_timer):
        if timer:
            timer.cancel()
            await asyncio.gather(timer, return_exceptions=True)
    if hub.io_tasks:
        await asyncio.gather(*hub.io_tasks)
    hub.store.close()


def correction(**extra):
    return {"request_id": "edit-1", "recording_id": "recording", "segment_id": 0,
            "expected_edit_version": 0, "text": "校对结果。", **extra}


def test_ack_waits_for_commit_and_correction_does_not_change_active_recording(tmp_path):
    async def run():
        hub, device, owner, _ = setup_hub(tmp_path)
        sentinel = object()
        hub.active = sentinel
        entered, release = Event(), Event()
        native = hub.store.correct
        def delayed(*args):
            entered.set()
            assert release.wait(timeout=3)
            return native(*args)
        hub.store.correct = delayed
        try:
            task = asyncio.create_task(hub.history_correct(owner, device, correction()))
            assert await asyncio.to_thread(entered.wait, 2)
            assert not any(e["type"] == "history_corrected" for e in owner.events)
            assert hub.active is sentinel
            release.set()
            await task
            assert owner.events[-1]["type"] == "history_corrected"
            assert hub.active is sentinel
            second = HistoryStore(hub.config.local_dir / "history.sqlite3")
            try:
                saved = second.history("esp32-s3")[0]
                assert saved["corrected_text"] == "校对结果。"
                assert saved["text"] == "原始识别文字。"
            finally:
                second.close()
        finally:
            release.set()
            await cleanup(hub, device)
    asyncio.run(run())


def test_failed_database_write_does_not_ack_or_mutate_memory(tmp_path):
    async def run():
        hub, device, owner, _ = setup_hub(tmp_path)
        with hub.store.db:
            hub.store.db.execute("CREATE TRIGGER test_fail BEFORE UPDATE ON captions BEGIN SELECT RAISE(ABORT,'test write failure'); END")
        try:
            await hub.history_correct(owner, device, correction())
            assert owner.events[-1]["code"] == "history_save_failed"
            assert not any(e["type"] == "history_corrected" for e in owner.events)
            assert "corrected_text" not in device.history[("recording", 0)]
            assert "corrected_text" not in hub.store.history("esp32-s3")[0]
        finally:
            await cleanup(hub, device)
    asyncio.run(run())


def test_stale_display_ack_cannot_confirm_a_new_push_using_same_client_id(tmp_path):
    async def run():
        hub, device, owner, board = setup_hub(tmp_path)
        device.history[("recording", 0)].update(edit_version=1, corrected_text="人工版本。")
        request = {"request_id": "client-retry", "recording_id": "recording", "segment_id": 0, "source": "original"}
        try:
            await hub.history_display(owner, device, request)
            old_wire_request = board.events[-1]["request_id"]
            device.display_timer.cancel()
            await asyncio.gather(device.display_timer, return_exceptions=True)
            device.pending_display = None  # emulate expiry before a delayed ACK
            await hub.history_display(owner, device, {**request, "source": "corrected", "expected_edit_version": 1})
            owner.events.clear()
            await hub.display_ack(device, {"request_id": old_wire_request})
            assert not any(e["type"] == "history_displayed" for e in owner.events)
            # A rejected reused client ID is also safe; an accepted retry must
            # still be pending because the previous command has not ACKed it.
            if board.events[-1]["request_id"] != old_wire_request:
                assert device.pending_display is not None
        finally:
            await cleanup(hub, device)
    asyncio.run(run())
