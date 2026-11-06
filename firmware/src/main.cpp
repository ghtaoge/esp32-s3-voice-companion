#include <Arduino.h>
#include <WiFi.h>
#include <WebSocketsClient.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <driver/i2s_std.h>
#include <esp_heap_caps.h>
#include <esp_timer.h>
#include <atomic>
#include <math.h>
#include "voice_core.h"
#include "ui.h"
#if __has_include("config.local.h")
#include "config.local.h"
#else
#include "config.example.h"
#endif

namespace {
i2s_chan_handle_t microphone = nullptr;
constexpr size_t QueueFrames = 128; // 2.56 seconds, allocated once in PSRAM.
constexpr uint32_t DrainTimeoutMs = 5000;
static_assert(MIC_SAMPLE_SHIFT >= 8 && MIC_SAMPLE_SHIFT <= 24, "MIC_SAMPLE_SHIFT must be in 8..24");
struct AudioFrame { uint32_t epoch; uint16_t size; int16_t pcm[voice::FrameSamples]; };
QueueHandle_t audioQueue = nullptr;
StaticQueue_t audioQueueControl;
uint8_t* queueStorage = nullptr;
voice::CaptureControl captureControl;
portMUX_TYPE captureGuard = portMUX_INITIALIZER_UNLOCKED;
DRAM_ATTR voice::DmaStamp dmaStamp;
portMUX_TYPE dmaGuard = portMUX_INITIALIZER_UNLOCKED;
std::atomic<uint32_t> captureFinished{0}, captureOverflow{0}, capturedSamples{0};
std::atomic<uint32_t> captureDmaLoss{0};
std::atomic<uint16_t> microphoneLevel{0};
std::atomic<bool> micReady{false}, micFailed{false};
WebSocketsClient socket;
Preferences preferences;
voice::Settings settings;
struct ButtonEdge { int8_t edge; uint32_t atUs; uint32_t epoch; };
QueueHandle_t buttonQueue = nullptr;
std::atomic<bool> buttonEventOverflow{false};
bool wsConnected = false, serverReady = false, active = false, streamReady = false;
bool released = false, stopSent = false;
bool settingsDirty = false;
bool networkEnabled = false, localError = false;
uint32_t epoch = 0, beganMs = 0, releaseMs = 0, stopSentMs = 0, levelAt = 0;
uint32_t wifiAttemptAt = 0;
uint32_t settingsWriteAt = 0;
char recordingId[65] = {}, lastRecordingId[65] = {};
int lastSegment = -1, lastRevision = -1;

void settingsJson(JsonObject result, const voice::Settings& value) {
  result["font_scale"] = value.scale;
  result["display_mode"] = voice::modeName(value.mode);
  result["page_ms"] = value.pageMs;
  result["scroll_speed"] = value.scrollSpeed;
  result["brightness"] = value.brightness;
  result["animation"] = value.animation;
}
bool sendJson(const JsonDocument& data) {
  if (!wsConnected) return false;
  String wire; wire.reserve(384); serializeJson(data, wire);
  return socket.sendTXT(wire);
}
bool sendControl(const char* type) {
  JsonDocument data; data["type"] = type; data["recording_id"] = recordingId;
  return sendJson(data);
}
voice::CaptureControl captureSnapshot() {
  portENTER_CRITICAL(&captureGuard);
  const voice::CaptureControl result = captureControl;
  portEXIT_CRITICAL(&captureGuard);
  return result;
}
voice::DmaStamp readDmaStamp() {
  portENTER_CRITICAL(&dmaGuard);
  const voice::DmaStamp result = dmaStamp;
  portEXIT_CRITICAL(&dmaGuard);
  return result;
}
bool IRAM_ATTR onDmaReceive(i2s_chan_handle_t, i2s_event_data_t* event, void*) {
  const uint32_t now = static_cast<uint32_t>(esp_timer_get_time());
  portENTER_CRITICAL_ISR(&dmaGuard);
  dmaStamp.producedSamples += event->size / sizeof(int32_t); dmaStamp.endedUs = now;
  portEXIT_CRITICAL_ISR(&dmaGuard);
  return false;
}
bool IRAM_ATTR onDmaOverflow(i2s_chan_handle_t, i2s_event_data_t* event, void*) {
  portENTER_CRITICAL_ISR(&dmaGuard);
  dmaStamp.droppedSamples += event->size / sizeof(int32_t);
  portEXIT_CRITICAL_ISR(&dmaGuard);
  return false;
}
void requestCaptureStop(uint32_t atUs = 0) {
  const uint32_t cutoff = atUs ? atUs : micros();
  portENTER_CRITICAL(&captureGuard);
  captureControl.stop(epoch, cutoff);
  portEXIT_CRITICAL(&captureGuard);
}
void retireCapture() {
  const uint32_t cutoff = micros();
  portENTER_CRITICAL(&captureGuard);
  captureControl.retire(captureControl.generation, cutoff);
  portEXIT_CRITICAL(&captureGuard);
}
void buttonTask(void*) {
  voice::Button button;
  uint32_t heldEpoch = 0;
  TickType_t wake = xTaskGetTickCount();
  for (;;) {
    const int edge = button.update(digitalRead(RECORD_BUTTON) == LOW, millis());
    if (edge) {
      ButtonEdge event{static_cast<int8_t>(edge), micros(), 0};
      const voice::DmaStamp dma = readDmaStamp();
      portENTER_CRITICAL(&captureGuard);
      if (edge > 0) {
        // Publish the capture command HERE, before the loop sees this event.
        // A stalled WebSocket must neither lose the sentence head nor reset
        // a release cutoff already stored for the same generation.
        heldEpoch = captureControl.press(event.atUs, dma.droppedSamples);
        if (heldEpoch) { captureOverflow.store(0); captureDmaLoss.store(0); capturedSamples.store(0); }
      } else captureControl.stop(heldEpoch, event.atUs);
      event.epoch = heldEpoch;
      if (edge < 0) heldEpoch = 0;
      portEXIT_CRITICAL(&captureGuard);
      if (event.epoch) {
        if (edge > 0) {
          ui::beginRecording(event.epoch);
        } else ui::setPhase(ui::Phase::Processing, "整理字幕");
      }
      if (xQueueSend(buttonQueue, &event, 0) != pdTRUE) { retireCapture(); buttonEventOverflow.store(true); }
    }
    vTaskDelayUntil(&wake, max(static_cast<TickType_t>(1), pdMS_TO_TICKS(2)));
  }
}
void failRecording(const char* message, bool notify = true) {
  retireCapture();
  if (active) {
    if (notify && wsConnected) sendControl("record_cancel");
  }
  active = streamReady = false; released = stopSent = false;
  localError = true;
  ui::setLevel(0); ui::setPhase(ui::Phase::Error, message);
  Serial.println(message);
}
void persistSettings() {
  // One versioned byte record, written only outside recording. NVS writes can
  // pause caches/other core; six separate writes in the audio path cause gaps.
  const uint8_t bytes[] = {1, settings.scale, static_cast<uint8_t>(settings.mode),
    static_cast<uint8_t>(settings.pageMs), static_cast<uint8_t>(settings.pageMs >> 8),
    settings.scrollSpeed, settings.brightness, static_cast<uint8_t>(settings.animation)};
  if (preferences.putBytes("settings", bytes, sizeof(bytes)) == sizeof(bytes)) settingsDirty = false;
}
bool readSettings(JsonObjectConst input, voice::Settings& next) {
  for (JsonPairConst item : input) {
    const char* key = item.key().c_str();
    if (!strcmp(key, "font_scale")) {
      if (!item.value().is<int>()) return false;
      int n = item.value().as<int>(); if (n < 1 || n > 4) return false; next.scale = n;
    } else if (!strcmp(key, "display_mode")) {
      if (!voice::parseMode(item.value().as<const char*>(), next.mode)) return false;
    } else if (!strcmp(key, "page_ms")) {
      if (!item.value().is<int>()) return false;
      int n = item.value().as<int>(); if (n < 500 || n > 10000) return false; next.pageMs = n;
    } else if (!strcmp(key, "scroll_speed")) {
      if (!item.value().is<int>()) return false;
      int n = item.value().as<int>(); if (n < 5 || n > 60) return false; next.scrollSpeed = n;
    } else if (!strcmp(key, "brightness")) {
      if (!item.value().is<int>()) return false;
      int n = item.value().as<int>(); if (n < 1 || n > 255) return false; next.brightness = n;
    } else if (!strcmp(key, "animation")) {
      if (!item.value().is<bool>()) return false;
      next.animation = item.value().as<bool>();
    } else return false;
  }
  return !input.isNull();
}
void applySettings(JsonDocument& data) {
  const char* request = data["request_id"] | "";
  if (!request[0] || strlen(request) > 64) return;
  JsonDocument reply; reply["type"] = "settings_ack"; reply["request_id"] = request;
  voice::Settings next = settings;
  if (!readSettings(data["settings"].as<JsonObjectConst>(), next)) reply["error"] = "invalid_settings";
  else if (next != settings) { settings = next; settingsDirty = true; ui::setSettings(settings); }
  settingsJson(reply["settings"].to<JsonObject>(), settings); sendJson(reply);
}
void transcriptMessage(JsonObjectConst data, bool fromHistory = false) {
  const char* id = data["recording_id"] | "";
  if (!fromHistory && strcmp(id, active ? recordingId : lastRecordingId)) return;
  const int segment = data["segment_id"] | 0;
  const int revision = data["revision"] | 0;
  if (!fromHistory && (segment < lastSegment || (segment == lastSegment && revision <= lastRevision))) return;
  if (fromHistory) voice::copyUtf8(lastRecordingId, sizeof(lastRecordingId), id);
  const bool restart = fromHistory || segment != lastSegment || (data["final"] | false);
  lastSegment = segment; lastRevision = revision;
  ui::setText(data["text"] | "", restart);
}
void onMessage(uint8_t* payload, size_t length) {
  if (length > 8192) { Serial.println("Ignored oversized server JSON"); return; }
  JsonDocument data;
  if (deserializeJson(data, payload, length)) { Serial.println("Ignored malformed server JSON"); return; }
  const char* type = data["type"] | "";
  if (!strcmp(type, "hello")) {
    if ((data["protocol"] | 0) != 1) { serverReady = false; failRecording("协议不兼容"); return; }
    serverReady = data["ready"] | false;
    localError = false;
    if (!active) ui::setPhase(serverReady ? ui::Phase::Idle : ui::Phase::Processing, serverReady ? "按住BOOT说话" : "模型准备中");
  } else if (!strcmp(type, "record_ready")) {
    if (active && !stopSent && !strcmp(data["recording_id"] | "", recordingId)) streamReady = true;
  } else if (!strcmp(type, "transcript")) transcriptMessage(data.as<JsonObjectConst>());
  else if (!strcmp(type, "recording_done")) {
    if (active && stopSent && !strcmp(data["recording_id"] | "", recordingId)) {
      active = streamReady = false;
      retireCapture();
      voice::copyUtf8(lastRecordingId, sizeof(lastRecordingId), recordingId);
      ui::setPhase(ui::Phase::Idle, (data["segments"] | 0) ? "" : "没有听到内容");
      ui::setLevel(0);
    }
  } else if (!strcmp(type, "emotion")) {
    const char* id = data["recording_id"] | "";
    const voice::CaptureControl command = captureSnapshot();
    const bool pendingPress = command.gate == voice::CaptureGate::Reserved && (!active || command.generation != epoch);
    if (!pendingPress && !strcmp(id, active ? recordingId : lastRecordingId) && (data["segment_id"] | 0) >= lastSegment)
      ui::setEmotion(data["label"] | "unknown", epoch);
  } else if (!strcmp(type, "settings_set")) applySettings(data);
  else if (!strcmp(type, "snapshot")) {
    if (!active && captureSnapshot().gate != voice::CaptureGate::Reserved) {
      for (JsonObjectConst item : data["history"].as<JsonArrayConst>()) {
        if (item["text"].is<const char*>()) transcriptMessage(item, true);
      }
    }
  } else if (!strcmp(type, "status")) {
    const char* id = data["recording_id"] | "";
    const char* state = data["state"] | "";
    if (!active && captureSnapshot().gate != voice::CaptureGate::Reserved && !strcmp(state, "idle")) {
      if (!localError) ui::setPhase(serverReady ? ui::Phase::Idle : ui::Phase::Processing, serverReady ? "按住BOOT说话" : "模型准备中", epoch);
    } else if (!strcmp(state, "processing") && active && !strcmp(id, recordingId) && stopSent) ui::setPhase(ui::Phase::Processing);
  } else if (!strcmp(type, "error")) {
    const char* id = data["recording_id"] | "";
    if (data["request_id"].is<const char*>() && !id[0]) return;
    if (active && (!id[0] || !strcmp(id, recordingId))) failRecording("录音失败请重试", false);
    else if (!active) ui::setPhase(ui::Phase::Error, "服务尚未就绪");
    Serial.printf("Server error code: %s\n", data["code"] | "unknown");
  }
}
void onSocket(WStype_t type, uint8_t* payload, size_t length) {
  if (type == WStype_CONNECTED) {
    wsConnected = true; serverReady = false;
    JsonDocument hello; hello["type"] = "hello"; hello["protocol"] = 1; hello["firmware"] = "0.1.0";
    settingsJson(hello["settings"].to<JsonObject>(), settings); sendJson(hello);
    ui::setPhase(ui::Phase::Processing, "连接本地ASR");
  } else if (type == WStype_DISCONNECTED) {
    wsConnected = serverReady = false;
    if (active) failRecording("连接中断请重试", false);
    else ui::setPhase(ui::Phase::Offline, "等待电脑服务");
  } else if (type == WStype_TEXT) onMessage(payload, length);
}

void captureTask(void*) {
  i2s_chan_config_t channel = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
  channel.dma_desc_num = 4; channel.dma_frame_num = 160;
  i2s_std_config_t config = {
    .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(16000),
    .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_MONO),
    .gpio_cfg = {
      .mclk = I2S_GPIO_UNUSED, .bclk = static_cast<gpio_num_t>(MIC_BCLK),
      .ws = static_cast<gpio_num_t>(MIC_WS), .dout = I2S_GPIO_UNUSED,
      .din = static_cast<gpio_num_t>(MIC_SD),
      .invert_flags = {.mclk_inv = false, .bclk_inv = false, .ws_inv = false}
    }
  };
  // Standard I2S always has two 32-bit slots (64 BCLK per WS frame).
  // Mono+LEFT extracts only the microphone whose L/R pin is tied to GND.
  config.slot_cfg.slot_mask = I2S_STD_SLOT_LEFT;
  i2s_event_callbacks_t callbacks = {};
  callbacks.on_recv = onDmaReceive; callbacks.on_recv_q_ovf = onDmaOverflow;
  if (i2s_new_channel(&channel, nullptr, &microphone) != ESP_OK ||
      i2s_channel_init_std_mode(microphone, &config) != ESP_OK ||
      i2s_channel_register_event_callback(microphone, &callbacks, nullptr) != ESP_OK || i2s_channel_enable(microphone) != ESP_OK) {
    micFailed.store(true); Serial.println("I2S initialization failed"); vTaskDelete(nullptr); return;
  }
  micReady.store(true);
  // Always drain DMA so starting a recording never uploads stale pre-press audio.
  // Only samples within the current press/release interval enter the queue.
  int32_t raw[voice::FrameSamples];
  AudioFrame frame{};
  voice::DmaReadClock audioClock;
  uint32_t seenEpoch = 0;
  for (;;) {
    size_t bytes = 0;
    esp_err_t result = i2s_channel_read(microphone, raw, sizeof(raw), &bytes, 40);
    const voice::DmaStamp dma = readDmaStamp();
    const uint32_t samples = bytes / sizeof(int32_t);
    // Date the data at its DMA sample position, not the task's wake-up time.
    const uint32_t endedUs = audioClock.readEnd(samples, dma);
    const voice::CaptureControl command = captureSnapshot();
    const uint32_t generation = command.generation;
    if (result != ESP_OK || !bytes) {
      if (result != ESP_OK) micFailed.store(true);
      if (generation && command.stopUs) captureFinished.store(generation);
      continue;
    }
    if (!generation || captureFinished.load() == generation) continue;
    if (command.hasDmaLoss(dma.droppedSamples)) {
      captureDmaLoss.store(generation); captureFinished.store(generation); continue;
    }
    if (generation != seenEpoch) { seenEpoch = generation; capturedSamples.store(0); }
    const uint32_t startUs = command.startUs;
    const uint32_t endUs = command.stopUs;
    const voice::SampleSpan span = voice::clipFrame(endedUs, samples, startUs, endUs);
    uint64_t energy = 0;
    frame.epoch = generation; frame.size = 0;
    for (uint32_t n = span.first; n < span.last; ++n) {
      const int16_t sample = voice::pcm16(raw[n], MIC_SAMPLE_SHIFT);
      frame.pcm[frame.size / 2] = sample; frame.size += 2;
      energy += static_cast<int32_t>(sample) * static_cast<int32_t>(sample);
    }
    if (frame.size) {
      microphoneLevel.store(static_cast<uint16_t>(sqrtf(static_cast<float>(energy) / (frame.size / 2))));
      if (xQueueSend(audioQueue, &frame, 0) != pdTRUE) {
        captureOverflow.store(generation); captureFinished.store(generation); continue;
      }
      capturedSamples.fetch_add(frame.size / 2);
    }
    if (endUs && static_cast<int32_t>(endedUs - endUs) >= 0) captureFinished.store(generation);
  }
}

void startRecording(uint32_t pressedUs, uint32_t generation) {
  if (active) return;
  if (!generation) { ui::setPhase(ui::Phase::Error, "尚未就绪请重按"); return; }
  const voice::CaptureControl command = captureSnapshot();
  if (!command.accepts(generation)) return;
  epoch = generation;
  if (!micReady.load() || micFailed.load()) { failRecording("麦克风初始化失败", false); return; }
  if (!wsConnected || !serverReady) { failRecording("电脑服务未就绪", false); return; }
  if (captureOverflow.load() == generation) { failRecording("网络太慢录音取消", false); return; }
  if (captureDmaLoss.load() == generation) { failRecording("采音丢帧请重试", false); return; }
  const uint64_t mac = ESP.getEfuseMac();
  snprintf(recordingId, sizeof(recordingId), "%08lx-%08lx-%08lx", static_cast<unsigned long>(mac >> 16), static_cast<unsigned long>(esp_random()), static_cast<unsigned long>(epoch));
  lastSegment = lastRevision = -1;
  active = true; streamReady = released = stopSent = false;
  beganMs = millis() - static_cast<uint32_t>(micros() - pressedUs) / 1000u;
  localError = false; microphoneLevel.store(0);
  // The button task already updated UI and capture boundaries. Do not reset
  // either here: this delayed event may represent an already released press.
  if (!sendControl("record_start")) failRecording("开始录音失败", false);
}
void updateCaptureArming() {
  const bool available = networkEnabled && wsConnected && serverReady && micReady.load() && !micFailed.load() && !active;
  voice::CaptureControl command = captureSnapshot();
  if (!available) {
    portENTER_CRITICAL(&captureGuard); captureControl.disarm(); portEXIT_CRITICAL(&captureGuard);
    return;
  }
  if (command.gate == voice::CaptureGate::Disabled && (!command.generation || captureFinished.load() == command.generation)) {
    // The producer has acknowledged this generation, and Disabled prevents a
    // new press from publishing another. Queue reset is safe only here.
    xQueueReset(audioQueue);
    portENTER_CRITICAL(&captureGuard);
    captureControl.arm(captureFinished.load());
    portEXIT_CRITICAL(&captureGuard);
  }
}
void endRecording(uint32_t releasedUs = 0) {
  if (!active || released || stopSent) return;
  requestCaptureStop(releasedUs); released = true; releaseMs = millis();
  ui::setPhase(ui::Phase::Processing, "整理字幕");
}
void serviceRecording() {
  if (!active) return;
  const uint32_t now = millis();
  if (captureOverflow.load() == epoch) { failRecording("网络太慢录音取消"); return; }
  if (captureDmaLoss.load() == epoch) { failRecording("采音丢帧请重试"); return; }
  if (micFailed.load()) { failRecording("麦克风读取失败"); return; }
  if (!released && now - beganMs >= MAX_RECORDING_MS) endRecording();
  if (!streamReady && now - beganMs > READY_TIMEOUT_MS) { failRecording("服务响应超时"); return; }
  if (released && !stopSent && now - releaseMs > DrainTimeoutMs) { failRecording("音频发送超时"); return; }
  if (stopSent && now - stopSentMs > FINAL_TIMEOUT_MS) { failRecording("识别结果超时"); return; }
  ui::setLevel(released ? 0 : microphoneLevel.load());
  if (!streamReady || stopSent) return;
  AudioFrame frame;
  const uint32_t sendStartedUs = micros();
  // Bound work per loop so incoming control/results and button release stay responsive.
  for (unsigned n = 0; n < 6; ++n) {
    if (n && !voice::sendBudgetAvailable(sendStartedUs, micros())) break;
    if (xQueueReceive(audioQueue, &frame, 0) != pdTRUE) break;
    if (frame.epoch != epoch) continue;
    if (!socket.sendBIN(reinterpret_cast<uint8_t*>(frame.pcm), frame.size)) { failRecording("音频发送失败", false); return; }
    if (captureOverflow.load() == epoch || captureDmaLoss.load() == epoch) { failRecording("音频过载请重试"); return; }
  }
  if (released && captureFinished.load() == epoch && uxQueueMessagesWaiting(audioQueue) == 0) {
    if (!sendControl("record_stop")) { failRecording("结束录音失败", false); return; }
    stopSent = true; stopSentMs = now;
  } else if (!released && now - levelAt >= 100) {
    levelAt = now;
    JsonDocument data; data["type"] = "level"; data["recording_id"] = recordingId;
    data["level"] = min(1.0f, microphoneLevel.load() / 16384.0f); sendJson(data);
  }
}
String urlEncode(const char* text) {
  static const char* digits = "0123456789ABCDEF";
  String output;
  while (*text) {
    const uint8_t c = static_cast<uint8_t>(*text++);
    if (isalnum(c) || c == '-' || c == '_' || c == '.' || c == '~') output += static_cast<char>(c);
    else { output += '%'; output += digits[c >> 4]; output += digits[c & 15]; }
  }
  return output;
}
bool configured() {
  const size_t idLength = strlen(DEVICE_ID);
  if (!idLength || idLength > 40 || !strcmp(WIFI_SSID, "YOUR_WIFI") || !strcmp(PAIRING_TOKEN, "YOUR_PAIRING_TOKEN")) return false;
  for (const char* c = DEVICE_ID; *c; ++c) if (!isalnum(static_cast<uint8_t>(*c)) && *c != '_' && *c != '-') return false;
  return true;
}
}

void setup() {
  Serial.begin(115200);
  pinMode(RECORD_BUTTON, INPUT_PULLUP);
  ui::begin();
  preferences.begin("voice-screen", false);
  uint8_t saved[8] = {};
  if (preferences.getBytesLength("settings") == sizeof(saved) && preferences.getBytes("settings", saved, sizeof(saved)) == sizeof(saved) && saved[0] == 1) {
    settings.scale = constrain(saved[1], 1, 4);
    settings.mode = static_cast<voice::Mode>(min(3, static_cast<int>(saved[2])));
    settings.pageMs = constrain(saved[3] | saved[4] << 8, 500, 10000);
    settings.scrollSpeed = constrain(saved[5], 5, 60);
    settings.brightness = max(1, static_cast<int>(saved[6])); settings.animation = saved[7] != 0;
  }
  ui::setSettings(settings);
  queueStorage = static_cast<uint8_t*>(heap_caps_malloc(QueueFrames * sizeof(AudioFrame), MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
  if (!queueStorage) queueStorage = static_cast<uint8_t*>(heap_caps_malloc(QueueFrames * sizeof(AudioFrame), MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (queueStorage) audioQueue = xQueueCreateStatic(QueueFrames, sizeof(AudioFrame), queueStorage, &audioQueueControl);
  buttonQueue = xQueueCreate(8, sizeof(ButtonEdge));
  if (!audioQueue || !buttonQueue || xTaskCreatePinnedToCore(captureTask, "i2s-capture", 6144, nullptr, 4, nullptr, 1) != pdPASS ||
      xTaskCreatePinnedToCore(buttonTask, "ptt-button", 3072, nullptr, 3, nullptr, 1) != pdPASS) {
    ui::setPhase(ui::Phase::Error, "音频内存不足"); Serial.println("Audio queue/task allocation failed"); return;
  }
  Serial.printf("Voice companion 0.1.0: flash=%lu PSRAM=%lu, PCM=16k/16bit mono, button=GPIO%d\n", static_cast<unsigned long>(ESP.getFlashChipSize()), static_cast<unsigned long>(ESP.getPsramSize()), RECORD_BUTTON);
  if (!configured()) { ui::setPhase(ui::Phase::Error, "请配置本地连接"); Serial.println("Copy include/config.example.h to config.local.h and fill local connection settings."); return; }
  WiFi.mode(WIFI_STA); WiFi.setSleep(false); WiFi.setAutoReconnect(true); WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiAttemptAt = millis();
  String path = "/ws/device/"; path += DEVICE_ID; path += "?token="; path += urlEncode(PAIRING_TOKEN);
  socket.begin(SERVER_HOST, SERVER_PORT, path);
  socket.onEvent(onSocket); socket.setReconnectInterval(3000); socket.enableHeartbeat(15000, 3000, 2);
  networkEnabled = true;
  ui::setPhase(ui::Phase::Offline, "连接无线网络");
}
void loop() {
  const uint32_t now = millis();
  ButtonEdge event;
  if (buttonQueue) while (xQueueReceive(buttonQueue, &event, 0) == pdTRUE) {
    if (event.edge > 0) startRecording(event.atUs, event.epoch);
    else if (event.epoch == epoch) endRecording(event.atUs);
  }
  if (buttonEventOverflow.exchange(false)) failRecording("按钮事件过多请重试");
  if (networkEnabled) {
    if (WiFi.status() == WL_CONNECTED) socket.loop();
    else {
      if (active) failRecording("无线连接中断", false);
      wsConnected = serverReady = false;
      if (now - wifiAttemptAt > 10000) { wifiAttemptAt = now; WiFi.reconnect(); }
    }
    serviceRecording();
    if (settingsDirty && !active && now - settingsWriteAt > 1000) {
      bool idle = false;
      portENTER_CRITICAL(&captureGuard);
      if (captureControl.gate != voice::CaptureGate::Reserved && (!captureControl.generation || captureFinished.load() == captureControl.generation)) {
        captureControl.disarm(); idle = true;
      }
      portEXIT_CRITICAL(&captureGuard);
      if (idle) { settingsWriteAt = now; persistSettings(); }
    }
  }
  if (audioQueue) updateCaptureArming();
  delay(1);
}
