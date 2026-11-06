from types import SimpleNamespace

import pytest

from voice_companion.config import Config
from voice_companion.inference import StreamingSession


class Online:
    """Capture exact PCM submitted to each model stream, without model CPU."""
    chunk_samples = 7680

    def __init__(self):
        self.calls = []
        self.finalized = []
        self.resets = 0

    def reset(self):
        self.resets += 1
        self.current = bytearray()

    def accept(self, pcm, final=False):
        self.calls.append((bytes(pcm), final))
        self.current.extend(pcm)
        if final:
            self.finalized.append(bytes(self.current))
        return "文字" if pcm else ""


class Vad:
    def __init__(self, speech=True, boundaries=None):
        self.speech = speech
        self.boundaries = boundaries
        self.calls = []

    def reset(self):
        self.calls.clear()

    def accept(self, pcm, final=False):
        self.calls.append((bytes(pcm), final))
        if self.boundaries is not None:
            return self.boundaries.get(len(self.calls), [])
        if len(self.calls) == 1 and pcm and self.speech:
            return [(0, -1)]
        return []


class Punc:
    def apply(self, text):
        return text + "。"


def session(speech=True, boundaries=None):
    engine = SimpleNamespace(online=Online(), vad=Vad(speech, boundaries), punc=Punc(), config=Config())
    return StreamingSession(engine)


def pcm_for_ms(milliseconds):
    # Each millisecond differs, so checks reveal a missing/replayed interval.
    return b"".join((ms % 32768).to_bytes(2, "little") * 16 for ms in range(milliseconds))


def replay(current, pcm, packet_bytes=3200):
    events, emotions = [], []
    for offset in range(0, len(pcm), packet_bytes):
        batch = current.feed(pcm[offset:offset + packet_bytes])
        events.extend(batch.events)
        emotions.extend(batch.emotions)
    batch = current.feed(b"", final=True)
    events.extend(batch.events)
    emotions.extend(batch.emotions)
    return events, emotions


def finals(events):
    return [event for event in events if event["final"]]


def test_short_tail_reaches_final_model_call():
    current = session()
    tail = bytes(range(256)) * 2 + bytes(range(128))  # exactly 20 ms
    current.feed(tail)
    result = current.feed(b"", final=True)
    assert current.online.calls == [(tail, True)]
    assert result.events[0]["final"] is True
    assert result.events[0]["text"] == "文字。"
    assert current.audio_ms == 20


def test_sub_millisecond_eof_samples_are_not_rounded_away():
    current = session(boundaries={1: [(0, 20)]})
    tail = pcm_for_ms(20) + b"\x12\x34"  # 20 ms plus one complete PCM sample
    current.feed(tail)
    current.feed(b"", final=True)
    assert current.online.finalized == [tail]
    assert current.processed_samples == 321


def test_silence_never_calls_online_or_creates_emotion_jobs():
    current = session(speech=False)
    events, emotions = replay(current, bytes(32000))
    assert events == []
    assert emotions == []
    assert current.online.calls == []
    assert current.segment_id == 0


def test_25_seconds_of_continuous_speech_does_not_reset_mid_word():
    current = session()
    pcm = pcm_for_ms(25000)
    events, emotions = replay(current, pcm)
    completed = finals(events)
    assert len(completed) == 1
    assert completed[0]["segment_id"] == 0
    assert completed[0]["start_ms"] == 0
    assert completed[0]["end_ms"] == 25000
    assert current.online.finalized == [pcm]
    assert current.online.resets == 2  # initial stream, then the actual EOF
    assert len(emotions) == 1
    assert emotions[0][1] == pcm[:12000 * 32]  # SER cap does not split ASR


def test_delayed_start_backfills_sentence_head_and_skips_leading_silence():
    current = session(boundaries={3: [(50, -1)]})
    pcm = pcm_for_ms(400)
    current.feed(pcm[:6400])
    assert current.online.calls == []
    events, _ = replay(current, pcm[6400:])
    assert current.online.finalized == [pcm[50 * 32:]]
    assert finals(events)[0]["start_ms"] == 50


def test_end_and_next_start_in_same_vad_call_keep_both_sentences():
    current = session(boundaries={1: [(0, -1)], 2: [(-1, 100), (150, -1)], 4: [(-1, 300)]})
    pcm = pcm_for_ms(300)
    events, _ = replay(current, pcm)
    assert current.online.finalized == [pcm[:100 * 32], pcm[150 * 32:]]
    assert [(e["segment_id"], e["start_ms"], e["end_ms"]) for e in finals(events)] == [(0, 0, 100), (1, 150, 300)]
    assert current.segment_id == 2


def test_multiple_complete_segments_in_one_vad_call_are_ordered():
    current = session(boundaries={1: [(0, 30), (50, 80)]})
    pcm = pcm_for_ms(100)
    events, _ = replay(current, pcm)
    assert current.online.finalized == [pcm[:30 * 32], pcm[50 * 32:80 * 32]]
    assert [(e["start_ms"], e["end_ms"]) for e in finals(events)] == [(0, 30), (50, 80)]


def test_backdated_end_trims_pending_silence_and_true_floor_preserves_next_head():
    current = session(boundaries={1: [(0, -1)], 4: [(-1, 250)], 6: [(350, -1)]})
    pcm = pcm_for_ms(700)
    events, _ = replay(current, pcm)
    assert current.online.finalized == [pcm[:250 * 32], pcm[350 * 32:]]
    assert [(e["start_ms"], e["end_ms"]) for e in finals(events)] == [(0, 250), (350, 700)]


def test_end_after_submitted_chunk_never_replays_already_consumed_pcm():
    current = session(boundaries={1: [(0, -1)], 8: [(-1, 520)]})
    pcm = pcm_for_ms(800)
    events, _ = replay(current, pcm)
    assert current.online.finalized == [pcm[:520 * 32]]
    assert current.online.calls[-1] == (pcm[480 * 32:520 * 32], True)
    assert finals(events)[0]["end_ms"] == 520


def test_end_before_submitted_tail_drops_pending_pcm_without_replaying_prefix():
    current = session(boundaries={1: [(0, -1)], 7: [(-1, 250)], 9: [(750, -1)]})
    pcm = pcm_for_ms(1000)
    events, _ = replay(current, pcm)
    # One 480 ms block was already in the first model before VAD reported the
    # 250 ms endpoint. Its trailing silence cannot be undone or sent again.
    assert current.online.finalized == [pcm[:480 * 32], pcm[750 * 32:]]
    assert [(e["start_ms"], e["end_ms"]) for e in finals(events)] == [(0, 250), (750, 1000)]


@pytest.mark.parametrize("packet_bytes", [640, 3200, 6400])
def test_transport_packet_size_does_not_change_sample_ranges(packet_bytes):
    current = session(boundaries={2: [(30, -1)], 6: [(-1, 350), (480, -1)]})
    pcm = pcm_for_ms(900)
    events, _ = replay(current, pcm, packet_bytes)
    assert current.online.finalized == [pcm[30 * 32:350 * 32], pcm[480 * 32:]]
    assert [(e["start_ms"], e["end_ms"]) for e in finals(events)] == [(30, 350), (480, 900)]


def test_decode_preroll_never_crosses_previous_end_or_changes_caption_and_emotion_start():
    current = session(boundaries={4: [(400, -1)], 9: [(-1, 900)], 11: [(1050, -1)], 15: [(-1, 1450)]})
    current.engine.config.asr_preroll_ms = 300
    pcm = pcm_for_ms(1450)
    events, jobs = replay(current, pcm)
    assert current.online.finalized == [pcm[100 * 32:900 * 32], pcm[900 * 32:]]
    assert [(e["start_ms"], e["end_ms"]) for e in finals(events)] == [(400, 900), (1050, 1450)]
    assert jobs == [(0, pcm[400 * 32:900 * 32]), (1, pcm[1050 * 32:1450 * 32])]


def test_odd_pcm_rejected_before_touching_model_or_audio_history():
    current = session()
    with pytest.raises(ValueError, match="偶数"):
        current.feed(b"1")
    assert not current.online.calls
    assert not current.audio


def test_recording_cap_rejected_before_extending_history():
    current = session()
    current.engine.config.max_recording_seconds = 1
    current.feed(bytes(32000))
    with pytest.raises(ValueError, match="时长"):
        current.feed(b"\x00\x00")
    assert len(current.audio) == 32000


def test_no_more_audio_accepted_after_eof():
    current = session(speech=False)
    current.feed(b"", final=True)
    with pytest.raises(RuntimeError, match="收尾"):
        current.feed(bytes(640))
