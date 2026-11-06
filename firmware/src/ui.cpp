#include "ui.h"
#include <Wire.h>
#include <U8g2lib.h>
#include <atomic>
#if __has_include("config.local.h")
#include "config.local.h"
#else
#include "config.example.h"
#endif

namespace ui {
namespace {
Snapshot shared;
SemaphoreHandle_t guard;
std::atomic<uint16_t> level{0};
U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(U8G2_R0, U8X8_PIN_NONE, OLED_SCL, OLED_SDA);
uint8_t textFrame[voice::ScreenBytes];
uint8_t nextFrame[voice::ScreenBytes];
uint16_t pageStarts[voice::MaxText + 1];
bool available = false;
uint32_t animationAt = 0;
uint32_t previousVersion = UINT32_MAX;
uint32_t previousReset = UINT32_MAX;
voice::Settings previousSettings;
uint8_t previousContrast = 0;
unsigned pages = 1;
int bodyTop = 12;

uint16_t glyph(uint32_t cp) {
  return cp <= 0xFFFF && u8g2_IsGlyph(oled.getU8g2(), static_cast<uint16_t>(cp)) ? cp : '?';
}
size_t layout(const Snapshot& data, size_t start, bool draw, size_t visibleCharacters = SIZE_MAX) {
  const size_t length = strlen(data.text);
  const int width = 128 / data.settings.scale;
  const int rows = max(1, (64 - bodyTop) / (16 * data.settings.scale));
  size_t offset = start, characters = 0;
  int x = 0, row = 0;
  while (offset < length) {
    if (characters++ >= visibleCharacters) return offset;
    const size_t before = offset; uint32_t cp;
    if (!voice::nextUtf8(data.text, length, offset, cp)) break;
    if (cp == '\n') { x = 0; if (++row == rows) return offset; continue; }
    const uint16_t code = glyph(cp);
    int advance = u8g2_GetGlyphWidth(oled.getU8g2(), code);
    if (advance < 1) advance = 6;
    if (x + advance > width) { x = 0; if (++row == rows) return before; }
    if (draw) oled.drawGlyph(x, row * 16 + 13, code);
    x += advance;
  }
  return offset;
}
void paginate(const Snapshot& data) {
  bodyTop = data.settings.scale >= 3 ? 0 : 16;
  pages = 1; pageStarts[0] = 0;
  size_t offset = 0;
  const size_t length = strlen(data.text);
  while (offset < length && pages < voice::MaxText) {
    const size_t next = layout(data, offset, false);
    if (next <= offset || next >= length) break;
    pageStarts[pages++] = static_cast<uint16_t>(next); offset = next;
  }
}
void renderText(const Snapshot& data, unsigned page, int verticalShift, size_t visible) {
  oled.clearBuffer();
  layout(data, pageStarts[page], true, visible);
  memcpy(textFrame, oled.getBufferPtr(), voice::ScreenBytes);
  if (verticalShift) {
    oled.clearBuffer();
    layout(data, pageStarts[(page + 1) % pages], true);
    memcpy(nextFrame, oled.getBufferPtr(), voice::ScreenBytes);
  }
  oled.clearBuffer();
  const unsigned scale = data.settings.scale;
  uint8_t* target = oled.getBufferPtr();
  const unsigned height = 64 - bodyTop;
  for (int y = bodyTop; y < 64; ++y) {
    const unsigned unscaledY = y - bodyTop + verticalShift;
    const uint8_t* source = unscaledY < height ? textFrame : nextFrame;
    const int sourceY = (unscaledY % height) / scale;
    if (sourceY < 0 || sourceY >= 64) continue;
    for (unsigned x = 0; x < 128; ++x)
      if (voice::screenPixel(source, x / scale, sourceY)) voice::putScreenPixel(target, x, y);
  }
}
void face(int x, int y, const char* mood, bool blink, uint16_t amplitude) {
  const bool sad = !strcmp(mood, "sad") || !strcmp(mood, "fearful");
  const bool angry = !strcmp(mood, "angry") || !strcmp(mood, "disgusted");
  const bool happy = !strcmp(mood, "happy");
  if (blink) { oled.drawHLine(x, y + 3, 5); oled.drawHLine(x + 16, y + 3, 5); }
  else if (happy) {
    oled.drawLine(x, y + 4, x + 2, y + 1); oled.drawLine(x + 2, y + 1, x + 4, y + 4);
    oled.drawLine(x + 16, y + 4, x + 18, y + 1); oled.drawLine(x + 18, y + 1, x + 20, y + 4);
  } else { oled.drawBox(x, y, 4, 6); oled.drawBox(x + 16, y, 4, 6); }
  if (angry) { oled.drawLine(x - 1, y - 2, x + 5, y + 1); oled.drawLine(x + 15, y + 1, x + 21, y - 2); }
  if (amplitude) oled.drawFrame(x + 7, y + 7, 7, 2 + min(6, amplitude / 4096));
  else if (sad) { oled.drawLine(x + 7, y + 11, x + 10, y + 9); oled.drawLine(x + 10, y + 9, x + 13, y + 11); }
  else oled.drawHLine(x + 7, y + 10, 7);
}
void render(const Snapshot& data, uint32_t now) {
  const uint32_t elapsed = now - animationAt;
  unsigned page = 0;
  int shift = 0;
  size_t visible = SIZE_MAX;
  if (data.settings.mode == voice::Mode::Scroll) {
    const unsigned height = max(16, 64 - bodyTop);
    const uint32_t cycle = data.settings.pageMs + height * 1000u / data.settings.scrollSpeed;
    page = (elapsed / cycle) % pages;
    const uint32_t into = elapsed % cycle;
    if (into > data.settings.pageMs) shift = min(static_cast<int>(height), static_cast<int>((into - data.settings.pageMs) * data.settings.scrollSpeed / 1000));
  } else if (data.settings.mode == voice::Mode::Page) page = (elapsed / data.settings.pageMs) % pages;
  else if (data.settings.mode == voice::Mode::Typewriter) {
    const uint32_t revealMs = 1600;
    const uint32_t cycle = data.settings.pageMs + revealMs;
    page = (elapsed / cycle) % pages;
    visible = (elapsed % cycle) / 45u + 1;
  }
  // Live transcripts follow the newest page instead of hiding newly spoken words.
  if (data.phase == Phase::Recording || data.phase == Phase::Processing) {
    page = pages - 1; shift = 0; visible = SIZE_MAX;
  }
  renderText(data, page, shift, visible);
  if (bodyTop) {
    const char* label = data.phase == Phase::Recording ? "录音" : data.phase == Phase::Processing ? "识别" : data.phase == Phase::Offline ? "离线" : data.phase == Phase::Error ? "错误" : "就绪";
    oled.drawUTF8(0, 12, label);
    if (data.phase == Phase::Recording) {
      char duration[12]; snprintf(duration, sizeof(duration), "%lus", static_cast<unsigned long>((now - data.startedMs) / 1000));
      oled.drawStr(28, 12, duration);
      oled.drawBox(51, 7, min(40, static_cast<int>(level.load() * 40u / 32768u)), 4);
    } else if (data.phase == Phase::Processing) {
      const unsigned dot = now / 250 % 3;
      for (unsigned n = 0; n < 3; ++n) oled.drawDisc(34 + n * 7, 8, n == dot ? 2 : 1);
    } else if (pages > 1) {
      char count[16]; snprintf(count, sizeof(count), "%u/%u", page + 1, pages); oled.drawStr(31, 12, count);
    }
    if (data.settings.animation) face(100, 1, data.emotion, now % 4000 < 130, data.phase == Phase::Recording ? level.load() : 0);
    oled.drawHLine(0, 15, 128);
  }
  if (!data.text[0]) {
    oled.drawUTF8(0, 35, data.message[0] ? data.message : "按住BOOT说话");
    if (data.settings.animation) face(52, 44, data.emotion, now % 4000 < 130, data.phase == Phase::Recording ? level.load() : 0);
  }
  oled.sendBuffer();
}
void displayTask(void*) {
  Wire.begin(OLED_SDA, OLED_SCL);
  Wire.setTimeOut(25);
  for (uint8_t address : {0x3C, 0x3D}) {
    Wire.beginTransmission(address);
    if (!Wire.endTransmission()) {
      oled.setI2CAddress(address << 1);
      oled.setBusClock(OLED_I2C_HZ);
      oled.begin(); oled.setFont(u8g2_font_wqy12_t_gb2312); available = true; break;
    }
  }
  if (!available) { Serial.println("OLED not detected on GPIO8/9 (0x3C/0x3D); audio service remains available."); vTaskDelete(nullptr); }
  TickType_t wake = xTaskGetTickCount();
  Snapshot data;
  for (;;) {
    xSemaphoreTake(guard, portMAX_DELAY); data = shared; xSemaphoreGive(guard);
    if (data.textVersion != previousVersion || data.settings != previousSettings) {
      paginate(data); previousVersion = data.textVersion;
      if (data.resetVersion != previousReset || data.settings != previousSettings) animationAt = millis();
      previousReset = data.resetVersion; previousSettings = data.settings;
    }
    if (data.settings.brightness != previousContrast) { oled.setContrast(data.settings.brightness); previousContrast = data.settings.brightness; }
    render(data, millis());
    vTaskDelayUntil(&wake, pdMS_TO_TICKS(50));
  }
}
}
void begin() {
  guard = xSemaphoreCreateMutex();
  if (!guard) return;
  if (xTaskCreatePinnedToCore(displayTask, "oled", 12288, nullptr, 1, nullptr, 0) != pdPASS) Serial.println("OLED task allocation failed");
}
void beginRecording(uint32_t generation) {
  if (!guard) return;
  xSemaphoreTake(guard, portMAX_DELAY);
  shared.generation = generation; shared.phase = Phase::Recording; shared.startedMs = millis();
  shared.text[0] = 0; ++shared.textVersion; ++shared.resetVersion;
  voice::copyUtf8(shared.message, sizeof(shared.message), "正在录音");
  voice::copyUtf8(shared.emotion, sizeof(shared.emotion), "unknown");
  xSemaphoreGive(guard); level.store(0);
}
void setPhase(Phase phase, const char* message, uint32_t expectedGeneration) {
  if (!guard) return;
  xSemaphoreTake(guard, portMAX_DELAY);
  if (expectedGeneration != UINT32_MAX && shared.generation != expectedGeneration) { xSemaphoreGive(guard); return; }
  if (shared.phase != phase && phase == Phase::Recording) shared.startedMs = millis();
  shared.phase = phase; voice::copyUtf8(shared.message, sizeof(shared.message), message);
  xSemaphoreGive(guard);
}
void setText(const char* text, bool restartAnimation) {
  if (!guard) return;
  xSemaphoreTake(guard, portMAX_DELAY);
  voice::copyUtf8(shared.text, sizeof(shared.text), text);
  ++shared.textVersion;
  if (restartAnimation) ++shared.resetVersion;
  xSemaphoreGive(guard);
}
void setEmotion(const char* label, uint32_t expectedGeneration) {
  if (!guard) return;
  xSemaphoreTake(guard, portMAX_DELAY);
  if (shared.generation == expectedGeneration) voice::copyUtf8(shared.emotion, sizeof(shared.emotion), label);
  xSemaphoreGive(guard);
}
void setSettings(const voice::Settings& settings) {
  if (!guard) return;
  xSemaphoreTake(guard, portMAX_DELAY); shared.settings = settings; xSemaphoreGive(guard);
}
void setLevel(uint16_t value) { level.store(value); }
}
