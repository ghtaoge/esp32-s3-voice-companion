#include "voice_core.h"
#include <assert.h>
#include <iostream>
#include <limits.h>

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
  std::cout << "PTT edges/debounce, UTF-8, PCM saturation, sample clipping, delayed-loop capture generations: passed\n";
}
