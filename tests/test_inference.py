from types import SimpleNamespace

from voice_companion.config import Config
from voice_companion.inference import StreamingSession


class Online:
    chunk_samples = 7680
    def __init__(self):
        self.calls = []
    def reset(self):
        pass
    def accept(self, pcm, final=False):
        self.calls.append((pcm, final))
        return "文字" if pcm else ""


class Vad:
    def __init__(self, speech=True):
        self.first = True
        self.speech = speech
    def reset(self):
        self.first = True
    def accept(self, pcm, final=False):
        if self.first and pcm and self.speech:
            self.first = False
            return [(0, -1)]
        return []


class Punc:
    def apply(self, text):
        return text + "。"


def session(speech=True):
    engine = SimpleNamespace(online=Online(), vad=Vad(speech), punc=Punc(), config=Config())
    return StreamingSession(engine)


def test_short_tail_reaches_final_model_call():
    current = session()
    # 20ms tail, including samples with values other than zero.
    tail = bytes(range(256)) * 2 + bytes(range(128))
    current.feed(tail)
    result = current.feed(b"", final=True)
    assert current.online.calls == [(tail, True)]
    assert result.events[0]["final"] is True
    assert result.events[0]["text"] == "文字。"
    assert current.audio_ms == 20


def test_silence_cannot_create_a_caption_or_emotion_job():
    current = session(speech=False)
    current.feed(bytes(32000))
    result = current.feed(b"", final=True)
    assert result.events == []
    assert result.emotions == []
    assert current.segment_id == 0


def test_long_continuous_speech_carries_vad_state_after_bounded_split():
    current = session()
    events = []
    for _ in range(250):
        events.extend(current.feed(bytes(3200)).events)
    events.extend(current.feed(b"", final=True).events)
    finals = [event for event in events if event["final"]]
    assert len(finals) == 3
    assert [event["segment_id"] for event in finals] == [0, 1, 2]
    assert finals[-1]["end_ms"] == 25000


def test_odd_pcm_rejected_before_touching_model():
    import pytest
    current = session()
    with pytest.raises(ValueError, match="偶数"):
        current.feed(b"1")
    assert not current.online.calls
