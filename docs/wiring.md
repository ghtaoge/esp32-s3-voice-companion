# 接线与板载按键

接线前拔掉 USB 和其他电源。按模块与开发板丝印逐根核对；使用杜邦线插接，无需剪线。所有模块与 ESP32 必须共地。

## OLED：SSD1306，128×64，I²C

| OLED 引脚 | ESP32-S3 |
|---|---|
| VCC / VDD | 3V3 |
| GND | GND |
| SDA | GPIO8 |
| SCL / SCK | GPIO9 |

保持现有 SDA=8、SCL=9。默认地址为 0x3C；如果屏幕无显示，先核实实际地址、驱动型号和分辨率。SCL 上的 SCK 丝印是 OLED 的 I²C 时钟，不要与麦克风的 I²S SCK 混接。

## INMP441：I²S 数字麦克风

| INMP441 引脚 | ESP32-S3 | 用途 |
|---|---|---|
| VDD / VCC | **3V3** | 3.3 V 供电 |
| GND | GND | 共地 |
| SCK / BCLK | GPIO4 | I²S 位时钟，由 ESP32 输出 |
| WS / LRCL / LRC | GPIO5 | I²S 左右声道时钟，由 ESP32 输出 |
| SD / DOUT | GPIO6 | 麦克风输出，接 ESP32 输入 |
| L/R | GND | 选择左声道，固件读取左声道 |

INMP441 不需要 MCLK。不要把 VDD 接到 5V，不要把 SD 接到 OLED 的 SDA。固件使用标准 Philips I²S 格式，每个 WS 帧保留 **64 个 BCLK（左右各 32 位）**，只取左槽的 24 位有效数据，再转换成 16 kHz 单声道 PCM16。麦克风底部声孔应保持通畅，避免贴在桌面或被外壳堵住。

## 按住录音

常见 ESP32-S3 开发板的 **BOOT 按键接 GPIO0**，按下为低电平，使用上拉输入。固件启动先等待松开，按下录音、松开停止并排空已采集尾包。请先确认具体开发板原理图或丝印；**EN / RST 是复位键，不能作录音键**。

GPIO0 同时是启动配置引脚。正常开机／复位时保持 BOOT 松开；需要下载模式时才按开发板烧录流程操作。

## N16R8 引脚注意

N16R8 常用八线 PSRAM。GPIO35、GPIO36、GPIO37 可能已被片上存储器接口占用，本项目不使用它们。GPIO8/9 与 GPIO4/5/6 的分配仍需以实际板子的原理图为准，特别注意板载外设是否已占用这些引脚。

## 上电核对

1. 断电核对 3V3、GND；确认没有把麦克风电源接到 5V。
2. 核对 OLED SDA8/SCL9 与麦克风 SCK4/WS5/SD6，确认没有错位。
3. 保持 BOOT 松开后上电；先看 OLED 状态，再按住 BOOT 说话。
4. 两端应先显示录音动画，松开后显示处理动画，再出现最终字幕。断网或模型未就绪会显示错误，不会伪造识别结果。

参考：[INMP441 官方数据手册](https://invensense.tdk.com/wp-content/uploads/2015/02/INMP441.pdf)、[ESP32-S3-DevKitC-1 官方硬件指南](https://docs.espressif.com/projects/esp-dev-kits/en/latest/esp32s3/esp32-s3-devkitc-1/user_guide_v1.1.html)。
