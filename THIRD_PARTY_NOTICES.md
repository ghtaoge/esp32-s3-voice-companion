# 第三方组件与模型

本仓库自有代码按 MIT 发布，不改变以下组件及模型各自的许可证。模型由下载工具从官方 ModelScope 仓库获取，权重不包含在 Git 中；下载后 `models/manifest.json` 保留具体文件、SHA256、上游版本和许可来源。

- [FunASR / funasr-onnx](https://github.com/modelscope/FunASR)：MIT，流式 Paraformer、FSMN-VAD、CT-Transformer 运行适配。
- [SenseVoice](https://github.com/FunAudioLLM/SenseVoice)：Apache-2.0，语音情绪及声音事件模型。具体权重许可以对应模型仓库为准。
- [ONNX Runtime](https://github.com/microsoft/onnxruntime)：MIT。
- [Arduino-ESP32](https://github.com/espressif/arduino-esp32)：LGPL-2.1，包含 ESP-IDF 等组件的独立许可。
- [U8g2](https://github.com/olikraus/u8g2)：BSD-2-Clause；字体各有来源与许可。固件使用文泉驿中文字库，见 [U8g2 字体许可](https://github.com/olikraus/u8g2/wiki/fntgrp)。
- [arduinoWebSockets](https://github.com/Links2004/arduinoWebSockets)：LGPL-2.1。
- [ArduinoJson](https://github.com/bblanchon/ArduinoJson)：MIT。
- Python / JavaScript 依赖的完整列表以 `pyproject.toml`、`requirements.lock.txt` 和各组件包的许可为准。

固件实现与来源说明另见 `firmware/NOTICE`。本仓库不包含训练数据、模型权重或第三方源码副本。
