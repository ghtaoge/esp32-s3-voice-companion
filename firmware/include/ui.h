#pragma once
#include <Arduino.h>
#include "voice_core.h"

namespace ui {
enum class Phase : uint8_t { Offline, Idle, Recording, Processing, Error };
struct Snapshot {
  Phase phase = Phase::Offline;
  voice::Settings settings;
  char text[voice::MaxText + 1] = {};
  char message[96] = {};
  char emotion[20] = "unknown";
  uint32_t textVersion = 0;
  uint32_t resetVersion = 0;
  uint32_t startedMs = 0;
  uint32_t generation = 0;
  voice::HistorySource historySource = voice::HistorySource::None;
};
void begin();
void beginRecording(uint32_t generation);
void setPhase(Phase phase, const char* message = "", uint32_t expectedGeneration = UINT32_MAX);
void setText(const char* text, bool restartAnimation, uint32_t expectedGeneration);
bool applyHistory(const char* text, size_t length, voice::HistorySource source, uint32_t expectedGeneration,
                  const voice::CaptureControl& capture, portMUX_TYPE& captureGuard);
void setEmotion(const char* label, uint32_t expectedGeneration);
void setSettings(const voice::Settings& settings);
void setLevel(uint16_t level);
}
