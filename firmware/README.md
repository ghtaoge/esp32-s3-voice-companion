# ESP32-S3 语音终端固件

适用于已引出 GPIO0/4/5/6/8/9 的 ESP32-S3 N16R8，SSD1306 128×64 I²C OLED 与 INMP441。接线见项目的 `docs/wiring.md`；不要按模块排针顺序猜测。

## 配置与编译

安装 PlatformIO Core 或 VS Code 扩展，在本目录执行：

```powershell
Copy-Item include/config.example.h include/config.local.h
# 编辑 include/config.local.h：Wi-Fi、电脑局域网IP、端口、配对token、device_id。
pio run
pio device list
pio run --target upload --upload-port COM你的端口
pio device monitor --baud 115200 --port COM你的端口
```

`config.local.h` 被 Git 忽略。示例值可编译，但设备会显示配置提示，不会连接示例地址。日志不打印 Wi-Fi 密码或 token。上传会替换开发板上的固件。

默认按键是 BOOT / GPIO0，低电平有效；RST/EN 仍是复位。启动时先等待按键释放，运行后按住录音，松开结束。不要按住 BOOT 再上电或复位，否则会进入下载模式。识别处理中再次按键不启动新录音，结束后需要重新按下。

默认麦克风为左声道（L/R → GND），I²S BCLK4、WS5、SD6；OLED SDA8、SCL9。`MIC_SAMPLE_SHIFT=14` 提供4倍数字增益并做饱和限制；声音过大出现削波时改为16。不要通过增益弥补错误的声道接线。

## 性能与收尾

- 使用新版 ESP-IDF 标准 I²S 驱动，16kHz、双32-bit物理槽、仅取左声道。DMA 由驱动在内部RAM分配，网络PCM是16-bit单声道。
- I²S 任务独立运行，20ms音频帧；BOOT 由独立2ms轮询任务消抖。按下在按键任务内直接发布采音代号和起点，不等待网络主循环；松键绑定同一代号立即保存截止点，网络握手不能重置它。
- 128帧预分配队列优先放 PSRAM（约83KB，2.56秒音频），等待 `record_ready` 时保留本次句首；网络落后则明确取消，不静默丢音、不上传旧录音。
- 持续排空I²S硬件DMA以丢弃录音区间外的数据；只有按键录音区间的样本进入发送队列。松键后先发完已采集尾包，再发 `record_stop`，等待 `recording_done`。
- OLED 在独立低优先任务运行，I²C默认400kHz、最多20FPS；音量和嘴形用本机RMS，不等ASR。若模块或长线不支持400kHz，在本地配置里改 `OLED_I2C_HZ=100000`。
- 设置先应用到RAM并确认；持久化写入延后到录音结束，使用单条NVS记录，避免录音中Flash写入造成采音停顿。
- 本机时钟和任务调度用于把首尾帧裁剪到按压区间；实际采音边界、网络和OLED效果仍需真机验收。

字幕按 `recording_id + segment_id + revision` 更新，保留最新一句；最多1536个UTF-8字节，截断不会切断中文码点。完整历史由电脑和小程序管理。字库为文泉驿12px GB2312，1/2/3/4倍放大；未覆盖字符显示问号。大字号隐藏顶部角色区以留出文字空间。

## 本机逻辑验证

```powershell
g++ -std=c++17 -O2 -Wall -Wextra -Werror -I include tests/native.cpp -o .pio/native-test.exe
.\.pio\native-test.exe
```

测试覆盖开机按住忽略、消抖和按住不重复触发、UTF-8安全裁剪、PCM饱和、首尾帧裁剪和微秒计时器回绕，以及主循环阻塞时完整按下/松开已发生、句首仍采集、截止不被握手清掉、忙时拒绝新代号、旧松键不影响新录音的回归场景。队列只在生产者确认停止且门控禁用时清理。PlatformIO编译和本机测试不代替硬件采音/按键/屏幕验收。
