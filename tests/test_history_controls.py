from test_service import context, url, until


def record(board, recording_id="edit-history"):
    board.send_json({"type": "record_start", "recording_id": recording_id})
    until(board, "record_ready")
    board.send_bytes(bytes(640))
    board.send_json({"type": "record_stop", "recording_id": recording_id})
    until(board, "recording_done")


def correction(request="edit-1", version=0, text="你好，语音小精灵。"):
    return {"type": "history_correct", "request_id": request, "recording_id": "edit-history",
            "segment_id": 0, "expected_edit_version": version, "text": text}


def display(request="show-1", source="corrected", version=1):
    return {"type": "history_display", "request_id": request, "recording_id": "edit-history",
            "segment_id": 0, "source": source, "expected_edit_version": version}


def test_saved_correction_keeps_original_and_both_versions_need_board_ack(context):
    client, hub, _ = context
    with client.websocket_connect(url("client")) as phone, client.websocket_connect(url()) as board:
        until(phone, "snapshot")
        until(board, "snapshot")
        record(board)
        phone.send_json(correction())
        saved = until(phone, "history_corrected")
        assert saved["edit_version"] == 1 and saved["corrected_text"] == "你好，语音小精灵。"
        phone.send_json(display())
        assert until(phone, "error")["code"] == "display_unsupported"
        board.send_json({"type": "hello", "protocol": 1, "capabilities": ["history_display"]})
        assert until(phone, "snapshot")["capabilities"] == ["history_display"]
        phone.send_json(display())
        assert until(phone, "display_pending")["request_id"] == "show-1"
        command = until(board, "display_set")
        assert command["text"] == saved["corrected_text"] and command["source"] == "corrected"
        board.send_json({"type": "display_ack", "request_id": "unrelated"})
        phone.send_json({"type": "history_get"})
        snapshot = until(phone, "snapshot")
        entry = snapshot["history"][0]
        assert entry["text"] == "你好，世界。" and entry["corrected_text"] == saved["corrected_text"]
        board.send_json({"type": "display_ack", "request_id": command["request_id"]})
        assert until(phone, "history_displayed")["source"] == "corrected"
        phone.send_json(display("show-original", "original"))
        until(phone, "display_pending")
        command = until(board, "display_set")
        assert command["text"] == "你好，世界。" and command["source"] == "original"
        board.send_json({"type": "display_ack", "request_id": command["request_id"]})
        assert until(phone, "history_displayed")["source"] == "original"
        assert hub.store.history("esp32-s3")[0]["corrected_text"] == saved["corrected_text"]


def test_other_client_conflict_and_restore_are_versioned_without_losing_original(context):
    client, _, _ = context
    with client.websocket_connect(url("client")) as first, client.websocket_connect(url("client")) as second, client.websocket_connect(url()) as board:
        until(first, "snapshot")
        until(second, "snapshot")
        until(board, "snapshot")
        record(board)
        first.send_json(correction())
        until(first, "history_corrected")
        assert until(second, "history_corrected")["edit_version"] == 1
        second.send_json(correction("edit-stale", 0, "不应覆盖新校对"))
        assert until(second, "error")["code"] == "history_conflict"
        snapshot = until(second, "snapshot")
        assert snapshot["history"][0]["corrected_text"] == "你好，语音小精灵。"
        first.send_json(correction("restore", 1, None))
        restored = until(first, "history_corrected")
        assert restored["edit_version"] == 2 and restored["corrected_text"] is None
    with client.websocket_connect(url("client")) as again:
        entry = until(again, "snapshot")["history"][0]
        assert entry["text"] == "你好，世界。" and entry["edit_version"] == 2 and entry["corrected_text"] is None


def test_invalid_edits_cannot_corrupt_text_or_unicode(context):
    client, _, _ = context
    with client.websocket_connect(url("client")) as phone, client.websocket_connect(url()) as board:
        until(phone, "snapshot")
        until(board, "snapshot")
        record(board)
        for value in (" ", "x" * 513, "😀" * 400, "bad\0text", "\ud800", 42):
            phone.send_json(correction(text=value))
            assert until(phone, "error")["code"] == "history_invalid"
        phone.send_json(correction(version=True))
        assert until(phone, "error")["code"] == "history_invalid"
        phone.send_json({"type": "history_get"})
        assert until(phone, "snapshot")["history"][0]["text"] == "你好，世界。"


def test_display_is_rejected_during_recording_and_board_errors_are_explicit(context):
    client, _, _ = context
    with client.websocket_connect(url("client")) as phone, client.websocket_connect(url()) as board:
        until(phone, "snapshot")
        until(board, "snapshot")
        record(board)
        board.send_json({"type": "hello", "protocol": 1, "capabilities": ["history_display"]})
        until(phone, "snapshot")
        board.send_json({"type": "record_start", "recording_id": "keep-asr-fast"})
        until(board, "record_ready")
        phone.send_json(display(source="original"))
        assert until(phone, "error")["code"] == "display_busy"
        board.send_json({"type": "record_cancel", "recording_id": "keep-asr-fast"})
        until(board, "error")
        phone.send_json(display(source="original"))
        until(phone, "display_pending")
        command = until(board, "display_set")
        board.send_json({"type": "display_ack", "request_id": command["request_id"], "error": "busy"})
        assert until(phone, "error")["code"] == "display_busy"


def test_save_works_offline_and_display_timeout_is_not_reported_as_success(context):
    client, hub, _ = context
    hub.config.display_timeout_seconds = 0.03
    with client.websocket_connect(url("client")) as phone:
        until(phone, "snapshot")
        with client.websocket_connect(url()) as board:
            until(board, "snapshot")
            record(board)
            board.send_json({"type": "hello", "protocol": 1, "capabilities": ["history_display"]})
            until(phone, "snapshot")
            phone.send_json(display(source="original"))
            until(phone, "display_pending")
            until(board, "display_set")
            assert until(phone, "error")["code"] == "display_timeout"
        phone.send_json(correction())
        assert until(phone, "history_corrected")["edit_version"] == 1
        phone.send_json(display())
        assert until(phone, "error")["code"] == "device_offline"
