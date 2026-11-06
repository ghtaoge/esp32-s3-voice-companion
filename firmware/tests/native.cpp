#include "voice_core.h"
#include <assert.h>
#include <iostream>
#include <limits.h>
#include <string>

int main() {
  // Holding BOOT during application startup must never start a recording.
  voice::Button button;
  assert(button.update(true, 1000) == 0);
  assert(button.update(true, 3000) == 0);
  assert(button.update(false, 3001) == 0);
  assert(button.update(false, 3026) == -1);
  assert(button.update(true, 3050) == 0);
  assert(button.update(false, 3060) == 0); // contact bounce
  assert(button.update(true, 3070) == 0);
  assert(button.update(true, 3094) == 0);
  assert(button.update(true, 3095) == 1);
  assert(button.update(true, 4000) == 0); // one event per press
  assert(button.update(false, 4010) == 0);
  assert(button.update(false, 4035) == -1);

  char text[8];
  assert(voice::copyUtf8(text, sizeof(text), "你好呀") == 6);
  assert(!strcmp(text, "你好"));
  assert(voice::copyUtf8(text, 3, "你") == 0);
  assert(text[0] == 0);
  assert(voice::copyUtf8(text, sizeof(text), "a\xf0\x9f\x98\x80z") == 6);
  assert(voice::copyUtf8(text, sizeof(text), "a\xe4\xbd") == 1);
  assert(voice::copyUtf8(text, sizeof(text), "ok\xc0\x80") == 2);
  assert(voice::copyUtf8(text, sizeof(text), "ok\xed\xa0\x80") == 2);
  // Display is exact and byte-bounded, including ASCII originals longer than
  // the editor's separate 512-code-point correction limit.
  const std::string english(768, 'a'), maximum(voice::MaxText, 'a'), tooLong(voice::MaxText + 1, 'a');
  assert(voice::validDisplayText(english.data(), english.size()));
  assert(voice::validDisplayText(maximum.data(), maximum.size()));
  assert(!voice::validDisplayText(tooLong.data(), tooLong.size()));
  assert(!voice::validDisplayText("", 0));
  assert(!voice::validDisplayText("bad\xf0\x9f", 5));
  assert(!voice::validDisplayText("a\0b", 3));
  assert(voice::validDisplayText("你好\nworld", strlen("你好\nworld")));

  assert(voice::pcm16(INT32_MAX, 14) == 32767);
  assert(voice::pcm16(INT32_MIN, 14) == -32768);
  assert(voice::pcm16(16384, 14) == 1);
  assert(voice::pcm16(-65536, 16) == -1);
  auto span = voice::clipFrame(20000, 320, 5000, 0);
  assert(span.first == 80 && span.last == 320);
  span = voice::clipFrame(20000, 320, 5000, 15000);
  assert(span.first == 80 && span.last == 240);
  span = voice::clipFrame(40000, 320, 5000, 15000);
  assert(span.first == span.last); // no samples after release
  span = voice::clipFrame(20000, 320, 25000, 0);
  assert(span.first == span.last); // no samples before press
  span = voice::clipFrame(10000, 320, UINT32_MAX - 4999, 5000);
  assert(span.first == 80 && span.last == 240); // microsecond timer wrapped

  // Regression: the loop is stalled while a complete press/release happens.
  // Capture starts from the button task, before network event consumption.
  voice::CaptureControl capture;
  assert(capture.arm(0));
  const uint32_t firstGeneration = capture.press(1000);
  assert(firstGeneration != 0 && capture.startUs == 1000);
  span = voice::clipFrame(10000, 160, capture.startUs, capture.stopUs);
  assert(span.last - span.first == 144); // speech head retained while loop waits
  assert(capture.stop(firstGeneration, 15000));
  // The network loop now consumes the delayed press event and starts its WS
  // handshake. Checking/attaching a generation cannot clear its release.
  assert(capture.accepts(firstGeneration));
  assert(capture.stopUs == 15000);
  span = voice::clipFrame(40000, 320, capture.startUs, capture.stopUs);
  assert(span.first == span.last); // no post-release audio while sendTXT stalls
  assert(capture.stop(firstGeneration, 40000));
  assert(capture.stopUs == 15000); // delayed release/cancel never extends cutoff
  assert(capture.press(50000) == 0); // busy press cannot create another capture
  capture.retire(firstGeneration, 50000);
  assert(!capture.arm(0)); // no queue reset/rearm until producer acknowledges
  assert(capture.arm(firstGeneration));
  const uint32_t secondGeneration = capture.press(60000);
  assert(secondGeneration != firstGeneration);
  assert(!capture.stop(firstGeneration, 70000)); // stale release cannot stop next recording
  assert(capture.stopUs == 0);
  assert(capture.stop(secondGeneration, 75000));
  assert(capture.stopUs == 75000);

  // Regression: display checked idle before a button task published a new
  // reservation. Its UI commit rechecks the live gate/generation, and must
  // reject rather than ACK an update overwritten before beginRecording().
  voice::CaptureControl display;
  assert(display.arm(0));
  const auto idleGeneration = display.generation;
  assert(voice::historyDisplayAllowed(display, false, idleGeneration));
  assert(!voice::historyDisplayAllowed(display, true, idleGeneration)); // ASR processing
  const auto pressedGeneration = display.press(1000);
  assert(!voice::historyDisplayAllowed(display, false, idleGeneration));
  assert(!voice::historyDisplayAllowed(display, false, pressedGeneration)); // Reserved before loop attaches
  display.retire(pressedGeneration, 2000);
  assert(!voice::historyDisplayAllowed(display, false, idleGeneration)); // stale idle snapshot remains stale
  assert(!voice::historyDisplayAllowed(display, true, pressedGeneration)); // final ASR is still pending
  assert(voice::historyDisplayAllowed(display, false, pressedGeneration));
  assert(display.arm(pressedGeneration));
  assert(voice::historyDisplayAllowed(display, false, pressedGeneration)); // applying display never disarms PTT
  assert(display.press(3000) != 0); // next BOOT still takes priority

  // A late task wakeup must not date the oldest queued DMA block at "now".
  voice::DmaReadClock clock;
  voice::DmaStamp queued{960, 0, 60000}; // 60 ms produced, reader only now wakes
  assert(clock.readEnd(320, queued) == 20000);
  assert(clock.readEnd(320, queued) == 40000);
  assert(clock.readEnd(320, queued) == 60000);
  voice::DmaReadClock skipped;
  queued = {960, 160, 60000}; // driver overwrote the first 10 ms DMA buffer
  assert(skipped.readEnd(320, queued) == 30000);
  assert(skipped.readEnd(320, queued) == 50000);
  voice::CaptureControl integrity;
  assert(integrity.arm(0));
  const auto integrityEpoch = integrity.press(50000, 160);
  assert(!integrity.hasDmaLoss(160)); // idle loss before this press is irrelevant
  assert(integrity.hasDmaLoss(320)); // any new in-recording DMA loss invalidates it
  integrity.retire(integrityEpoch, 60000);
  assert(integrity.arm(integrityEpoch));
  integrity.press(70000, 320);
  assert(!integrity.hasDmaLoss(320)); // previous failed recording cannot poison the next
  assert(voice::sendBudgetAvailable(UINT32_MAX - 1999, 1000));
  assert(!voice::sendBudgetAvailable(1000, 5000));
  voice::BodyFrameKey cached{1, 0, 0, 1, SIZE_MAX};
  assert((cached == voice::BodyFrameKey{1, 0, 0, 1, SIZE_MAX}));
  assert(!(cached == voice::BodyFrameKey{2, 0, 0, 1, SIZE_MAX}));
  assert(!(cached == voice::BodyFrameKey{1, 1, 0, 1, SIZE_MAX}));
  assert(!(cached == voice::BodyFrameKey{1, 0, 1, 1, SIZE_MAX}));
  assert(!(cached == voice::BodyFrameKey{1, 0, 0, 2, SIZE_MAX}));
  assert(!(cached == voice::BodyFrameKey{1, 0, 0, 1, 3}));
  assert(voice::textBaseline(4, 12) == 11); // history badge + full 4x font box
  assert(voice::textBaseline(4, 0) == 13); // regular large text is unchanged
  assert(voice::textBaseline(3, 12) == 13);
  assert((voice::textBaseline(4, 12) + 2) * 4 <= 64 - 12);
  assert(voice::textBaseline(4, 12) >= 11); // no glyph top is clipped either
  std::cout << "PTT/UTF8/PCM, history display byte bounds/generation race, delayed-loop generations, DMA backlog/loss clock, send pacing, OLED cache invalidation: passed\n";
}
