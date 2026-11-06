#pragma once
// Copy to config.local.h; local credentials are excluded from Git.
#define WIFI_SSID "YOUR_WIFI"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"
#define SERVER_HOST "192.168.1.100"
#define SERVER_PORT 8765
#define PAIRING_TOKEN "YOUR_PAIRING_TOKEN"
#define DEVICE_ID "esp32-s3"

// GPIO numbers, not physical pin positions. INMP441 L/R -> GND (left).
#define MIC_BCLK 4
#define MIC_WS 5
#define MIC_SD 6
#define RECORD_BUTTON 0
#define OLED_SDA 8
#define OLED_SCL 9
#define OLED_I2C_HZ 400000
// INMP441 signed 24-bit data are left-aligned in 32-bit slots.
// Shift 16 = unity; 14 = 4x digital gain with saturation (default).
#define MIC_SAMPLE_SHIFT 14
#define MAX_RECORDING_MS 60000
#define READY_TIMEOUT_MS 1800
#define FINAL_TIMEOUT_MS 30000
