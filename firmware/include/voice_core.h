#pragma once
#include <stddef.h>
#include <stdint.h>
#include <string.h>

namespace voice {
constexpr size_t FrameSamples = 320;
constexpr size_t FrameBytes = FrameSamples * 2;
constexpr size_t MaxText = 1536;
constexpr size_t ScreenBytes = 1024;
enum class HistorySource : uint8_t { None, Original, Corrected };

// A malformed/truncated code point never becomes a partial displayed glyph.
inline bool nextUtf8(const char* text, size_t length, size_t& offset, uint32_t& cp) {
  if (offset >= length) return false;
  const uint8_t first = static_cast<uint8_t>(text[offset++]);
  unsigned count; uint32_t minimum;
  if (first < 0x80) { cp = first; count = 0; minimum = 0; }
  else if (first >= 0xC2 && first <= 0xDF) { cp = first & 31; count = 1; minimum = 0x80; }
  else if (first >= 0xE0 && first <= 0xEF) { cp = first & 15; count = 2; minimum = 0x800; }
  else if (first >= 0xF0 && first <= 0xF4) { cp = first & 7; count = 3; minimum = 0x10000; }
  else return false;
  while (count--) {
    if (offset >= length) return false;
    const uint8_t next = static_cast<uint8_t>(text[offset++]);
    if ((next & 0xC0) != 0x80) return false;
    cp = (cp << 6) | (next & 63);
  }
  return cp >= minimum && cp <= 0x10FFFF && !(cp >= 0xD800 && cp <= 0xDFFF) &&
    (cp == '\n' || (cp >= 32 && !(cp >= 0x7F && cp <= 0x9F)));
}
inline size_t copyUtf8(char* output, size_t capacity, const char* source) {
  if (!capacity) return 0;
  if (!source) { output[0] = 0; return 0; }
  const size_t size = strlen(source);
  size_t offset = 0, accepted = 0; uint32_t cp;
  while (offset < size) {
    if (!nextUtf8(source, size, offset, cp) || offset >= capacity) break;
    accepted = offset;
  }
  memcpy(output, source, accepted); output[accepted] = 0;
  return accepted;
}
// Manual display is an exact operation: reject instead of silently truncating
// an old sentence. Its byte limit also bounds every copy inside the UI lock.
inline bool validDisplayText(const char* text, size_t length) {
  if (!text || !length || length > MaxText) return false;
  size_t offset = 0; uint32_t cp;
  while (offset < length) if (!nextUtf8(text, length, offset, cp)) return false;
  return true;
}
inline int16_t pcm16(int32_t sample, unsigned shift) {
  const int32_t value = sample >> shift;
  return static_cast<int16_t>(value > 32767 ? 32767 : value < -32768 ? -32768 : value);
}
struct SampleSpan { uint32_t first, last; };
struct DmaStamp { uint32_t producedSamples = 0, droppedSamples = 0, endedUs = 0; };
struct DmaReadClock {
  uint32_t consumedSamples = 0, seenDroppedSamples = 0;
  uint32_t readEnd(uint32_t samples, const DmaStamp& stamp) {
    // A dropped DMA buffer is skipped by the driver, not returned by read().
    consumedSamples += samples + (stamp.droppedSamples - seenDroppedSamples);
    seenDroppedSamples = stamp.droppedSamples;
    const uint32_t pendingSamples = stamp.producedSamples - consumedSamples;
    return stamp.endedUs - pendingSamples * 1000000u / 16000u;
  }
};
inline bool sendBudgetAvailable(uint32_t startedUs, uint32_t nowUs) {
  return static_cast<uint32_t>(nowUs - startedUs) < 4000u;
}
struct BodyFrameKey {
  uint32_t textVersion; unsigned page; int shift; uint8_t scale; size_t visible;
  bool operator==(const BodyFrameKey& other) const {
    return textVersion == other.textVersion && page == other.page && shift == other.shift && scale == other.scale && visible == other.visible;
  }
};
inline unsigned textBaseline(unsigned scale, unsigned bodyTop) {
  // The bundled WQY12 font box has max ascent 11 and descent 2. With a
  // history badge, a 4x glyph needs all 13 remaining raw pixel rows.
  const unsigned maximum = (64u - bodyTop) / scale - 2u;
  return maximum < 13u ? maximum : 13u;
}
enum class CaptureGate : uint8_t { Disabled, Armed, Reserved };
// Callers protect this small command with one critical section. The button
// task owns press/release; the network task only reads or retires a generation.
// In particular there is no network-side "start/reset stopUs" operation.
struct CaptureControl {
  CaptureGate gate = CaptureGate::Disabled;
  uint32_t generation = 0, startUs = 0, stopUs = 0, dmaDropBaseline = 0;
  bool arm(uint32_t finishedGeneration) {
    if (gate != CaptureGate::Disabled || (generation && finishedGeneration != generation)) return false;
    gate = CaptureGate::Armed; return true;
  }
  uint32_t press(uint32_t atUs, uint32_t droppedSamples = 0) {
    if (gate != CaptureGate::Armed) return 0;
    if (!++generation) ++generation;
    startUs = atUs; stopUs = 0; dmaDropBaseline = droppedSamples; gate = CaptureGate::Reserved;
    return generation;
  }
  bool accepts(uint32_t expectedGeneration) const {
    return expectedGeneration && generation == expectedGeneration && gate == CaptureGate::Reserved;
  }
  bool hasDmaLoss(uint32_t droppedSamples) const { return droppedSamples != dmaDropBaseline; }
  bool stop(uint32_t expectedGeneration, uint32_t atUs) {
    if (!expectedGeneration || generation != expectedGeneration) return false;
    if (!stopUs) stopUs = atUs ? atUs : 1;
    return true;
  }
  void retire(uint32_t expectedGeneration, uint32_t atUs) {
    if (stop(expectedGeneration, atUs)) gate = CaptureGate::Disabled;
  }
  void disarm() { if (gate == CaptureGate::Armed) gate = CaptureGate::Disabled; }
};
// Recheck this under the same capture lock as press(), immediately at UI
// commit. An earlier network-side idle snapshot cannot authorize a late write.
inline bool historyDisplayAllowed(const CaptureControl& capture, bool active, uint32_t expectedGeneration) {
  return !active && capture.gate != CaptureGate::Reserved && capture.generation == expectedGeneration;
}
// Times are uint32 microseconds; signed differences handle timer wrap as long
// as a recording is shorter than 2^31 us (the configured maximum is 60 s).
inline SampleSpan clipFrame(uint32_t endedUs, uint32_t samples, uint32_t pressedUs, uint32_t releasedUs) {
  const uint32_t beganUs = endedUs - samples * 1000000u / 16000u;
  const int32_t afterStart = static_cast<int32_t>(pressedUs - beganUs);
  uint32_t first = afterStart > 0 ? (static_cast<uint32_t>(afterStart) * 16u + 999u) / 1000u : 0;
  if (first > samples) first = samples;
  uint32_t last = samples;
  if (releasedUs && static_cast<int32_t>(endedUs - releasedUs) >= 0) {
    const int32_t beforeEnd = static_cast<int32_t>(releasedUs - beganUs);
    last = beforeEnd <= 0 ? 0 : static_cast<uint32_t>(beforeEnd) * 16u / 1000u;
    if (last > samples) last = samples;
  }
  return {first, last > first ? last : first};
}
enum class Mode : uint8_t { Page, Scroll, Typewriter, Static };
struct Settings {
  uint8_t scale = 1;
  Mode mode = Mode::Page;
  uint16_t pageMs = 2500;
  uint8_t scrollSpeed = 20;
  uint8_t brightness = 128;
  bool animation = true;
  bool operator==(const Settings& other) const {
    return scale == other.scale && mode == other.mode && pageMs == other.pageMs &&
      scrollSpeed == other.scrollSpeed && brightness == other.brightness && animation == other.animation;
  }
  bool operator!=(const Settings& other) const { return !(*this == other); }
};
inline const char* modeName(Mode mode) {
  switch (mode) {
    case Mode::Scroll: return "scroll";
    case Mode::Typewriter: return "typewriter";
    case Mode::Static: return "static";
    default: return "page";
  }
}
inline bool parseMode(const char* value, Mode& result) {
  if (!value) return false;
  if (!strcmp(value, "page")) result = Mode::Page;
  else if (!strcmp(value, "scroll")) result = Mode::Scroll;
  else if (!strcmp(value, "typewriter")) result = Mode::Typewriter;
  else if (!strcmp(value, "static")) result = Mode::Static;
  else return false;
  return true;
}
struct Button {
  bool raw = true, pressed = true, armed = false;
  uint32_t changedAt = 0;
  // +1 = a new press; -1 = release; 0 = no edge. Boot-held is ignored.
  int update(bool inputPressed, uint32_t now) {
    if (inputPressed != raw) { raw = inputPressed; changedAt = now; }
    if (now - changedAt < 25 || pressed == raw) return 0;
    pressed = raw;
    if (!pressed) { armed = true; return -1; }
    if (!armed) return 0;
    armed = false; return 1;
  }
};
inline bool screenPixel(const uint8_t* data, unsigned x, unsigned y) {
  return data[(y / 8) * 128 + x] & (1u << (y % 8));
}
inline void putScreenPixel(uint8_t* data, unsigned x, unsigned y) {
  data[(y / 8) * 128 + x] |= 1u << (y % 8);
}
}
