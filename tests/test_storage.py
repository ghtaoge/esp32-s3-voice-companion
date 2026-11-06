from voice_companion.storage import HistoryStore


def event(revision=2, **extra):
    return dict(type="transcript", device_id="esp32-s3", recording_id="recording", segment_id=0,
                revision=revision, final=True, text="测试。", **extra)


def test_late_io_cannot_erase_emotion_or_newer_revision(tmp_path):
    store = HistoryStore(tmp_path / "history.sqlite3")
    store.upsert(event(emotion={"label": "happy", "status": "ready"}))
    store.upsert(event())
    store.upsert(event(1))
    result = store.history("esp32-s3")[0]
    assert result["emotion"]["label"] == "happy"
    assert result["revision"] == 2
    store.close()


def test_retention_is_bounded_per_device(tmp_path):
    store = HistoryStore(tmp_path / "history.sqlite3", limit=2)
    for number in range(4):
        value = event()
        value["recording_id"] = str(number)
        store.upsert(value)
    assert [item["recording_id"] for item in store.history("esp32-s3")] == ["2", "3"]
    store.close()
