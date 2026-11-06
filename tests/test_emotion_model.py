from types import SimpleNamespace

import numpy as np
import pytest

from voice_companion import models


PIECES = ["<blank>", "<|zh|>", "<|Speech|>", "<|withitn|>", "开心", "<|EMO_UNKNOWN|>",
          "<|NEUTRAL|>", "<|HAPPY|>", "<|SAD|>", "<|ANGRY|>", "<|FEARFUL|>", "<|DISGUSTED|>", "<|SURPRISED|>"]


class Tokenizer:
    def __init__(self):
        self.sp = self

    def piece_to_id(self, piece):
        return PIECES.index(piece)

    def id_to_piece(self, token):
        return PIECES[token]

    def decode(self, ids):
        return "".join(PIECES[i] for i in ids)


class Model:
    blank_id = 0
    lid_dict = {"auto": 0}
    textnorm_dict = {"withitn": 14, "woitn": 15}

    def __init__(self):
        self.tokenizer = Tokenizer()
        self.frontend = SimpleNamespace(opts=SimpleNamespace(frame_opts=SimpleNamespace(dither=1)))
        self.calls = 0
        self.inputs = []
        self.logits = np.full((1, 7, len(PIECES)), -30, dtype=np.float32)
        for row, token in enumerate((1, 5, 2, 3, 4, 0, 0)):
            self.logits[0, row, token] = 20
        # Native unknown remains the winner; known alternatives are evidence.
        self.logits[0, 1, PIECES.index("<|ANGRY|>")] = 18
        self.logits[0, 1, PIECES.index("<|SAD|>")] = 17
        self.logits[0, 1, PIECES.index("<|HAPPY|>")] = 16

    def __call__(self, *args, **kwargs):
        raise AssertionError("Do not run an additional wrapper forward")

    def extract_feat(self, waveforms):
        self.inputs.append(waveforms[0].copy())
        return np.ones((1, 1, 80), dtype=np.float32), np.array([1], dtype=np.int32)

    def infer(self, features, lengths, language, textnorm):
        self.calls += 1
        self.language, self.textnorm = language, textnorm
        return self.logits, np.array([7], dtype=np.int32)


@pytest.fixture
def recognizer(monkeypatch, tmp_path):
    model = Model()
    monkeypatch.setattr(models, "_model_dir", lambda *args: tmp_path)
    monkeypatch.setattr(models, "build_cpu_model", lambda *args, **kwargs: model)
    return models.EmotionRecognizer(tmp_path, threads=1)


def pcm(value=1000, samples=16000):
    return np.full(samples, value, dtype="<i2").tobytes()


def test_raw_unknown_survives_happy_transcript_and_candidates(recognizer):
    result = recognizer.analyze(pcm())
    assert result["label"] == "unknown"  # transcript says 开心; it is irrelevant
    assert result["event"] == "speech"
    assert "<|EMO_UNKNOWN|>" in result["raw_tags"]
    assert result["candidates"] == [{"label": "angry", "score": 18}, {"label": "sad", "score": 17}, {"label": "happy", "score": 16}]
    assert "confidence" not in result
    assert recognizer.model.calls == 1
    assert recognizer.model.language.tolist() == [0]
    assert recognizer.model.textnorm.tolist() == [14]


@pytest.mark.parametrize("tag,label", [("NEUTRAL", "neutral"), ("HAPPY", "happy"), ("SAD", "sad"),
    ("ANGRY", "angry"), ("FEARFUL", "fearful"), ("DISGUSTED", "disgusted"), ("SURPRISED", "surprised")])
def test_all_official_emotion_tags_are_preserved(recognizer, tag, label):
    recognizer.model.logits[0, 1, PIECES.index(f"<|{tag}|>")] = 25
    result = recognizer.analyze(pcm())
    assert result["label"] == label
    assert f"<|{tag}|>" in result["raw_tags"]
    assert result["candidates"][0] == {"label": label, "score": 25}


def test_pcm_scale_and_quality_measurements_are_physical_not_confidence(recognizer):
    raw = np.array([32767, -32768, 16384, -16384] * 4000, dtype="<i2").tobytes()
    result = recognizer.analyze(raw)
    np.testing.assert_array_equal(recognizer.model.inputs[0][:4], np.array([32767 / 32768, -1, .5, -.5], dtype=np.float32))
    quality = result["audio_quality"]
    assert quality["duration_ms"] == quality["analyzed_ms"] == 1000
    assert quality["peak"] == 1
    assert quality["clipping_ratio"] == .5
    assert quality["rms_dbfs"] == pytest.approx(10 * np.log10(np.mean(np.array([32767 / 32768, -1, .5, -.5]) ** 2)))
    assert result["label"] == "unknown"  # clipping metadata never guesses a label


@pytest.mark.parametrize("data,reason", [(b"", "no_audio"), (pcm(samples=399), "below_feature_window"), (pcm(0), "no_signal")], ids=["empty", "sub_frame", "digital_silence"])
def test_missing_signal_does_not_run_model(recognizer, data, reason):
    result = recognizer.analyze(data)
    assert result["label"] == result["event"] == "unknown"
    assert result["raw_tags"] == result["candidates"] == []
    assert result["audio_quality"]["reason"] == reason
    assert recognizer.model.calls == 0


def test_short_context_is_flagged_without_changing_model_tag(recognizer):
    recognizer.model.logits[0, 1, PIECES.index("<|SAD|>")] = 25
    result = recognizer.analyze(pcm(samples=9600))
    assert result["label"] == "sad"
    assert result["audio_quality"]["reason"] == "short_context"
    assert result["audio_quality"]["duration_ms"] == 600


def test_very_quiet_nonzero_signal_is_not_suppressed(recognizer):
    result = recognizer.analyze(pcm(value=1))
    assert recognizer.model.calls == 1
    assert result["audio_quality"]["peak"] == 1 / 32768
    assert result["audio_quality"]["rms_dbfs"] == pytest.approx(-90.3089987)


def test_cap_is_explicit_and_quality_describes_analyzed_prefix(recognizer):
    recognizer.max_samples = 16000
    raw = pcm(1000) + pcm(32767)
    result = recognizer.analyze(raw)
    assert len(recognizer.model.inputs[0]) == 16000
    assert result["audio_quality"]["duration_ms"] == 2000
    assert result["audio_quality"]["analyzed_ms"] == 1000
    assert result["audio_quality"]["peak"] == 1000 / 32768
    assert result["audio_quality"]["clipping_ratio"] == 0
    assert result["audio_quality"]["reason"] == "truncated"


def test_nonfinite_candidate_scores_are_not_published(recognizer):
    recognizer.model.logits[0, 1, PIECES.index("<|ANGRY|>")] = np.inf
    result = recognizer.analyze(pcm())
    assert all(np.isfinite(item["score"]) for item in result["candidates"])
    assert result["label"] == "angry"  # native CTC tag is not silently rewritten


def test_empty_model_output_has_no_invented_candidates(recognizer):
    recognizer.model.infer = lambda *args: (np.empty((1, 0, len(PIECES)), dtype=np.float32), np.array([0], dtype=np.int32))
    result = recognizer.analyze(pcm())
    assert result["label"] == result["event"] == "unknown"
    assert result["raw_tags"] == result["candidates"] == []


def test_odd_pcm_rejected_before_model(recognizer):
    with pytest.raises(ValueError, match="even"):
        recognizer.analyze(b"x")
    assert recognizer.model.calls == 0
