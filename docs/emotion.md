# 本地声学情绪：实现、证据与边界

本模块使用官方 `iic/SenseVoiceSmall-onnx` INT8 权重，只提供**送入片段的句级声学标签**。它不识别人的真实心理状态，也不提供声学词级情绪。文字中的情绪词、否定词、程度词属于独立文字分析，不能反写成声学标签。

## 官方实现核对

- [SenseVoice 官方项目](https://github.com/QwenAudio/SenseVoice)：公开的 Small checkpoint 提供 ASR、语言、情绪及声音事件输出。
- [官方 SER 评测约定](https://github.com/QwenAudio/SenseVoice/blob/main/benchmarks/ser/README.md)及[评测代码](https://github.com/QwenAudio/SenseVoice/blob/main/benchmarks/ser/evaluate.py)：直接读取原始情绪 token，使用 `language="auto"`、`use_itn=True`，不从格式化文字推断情绪。
- [官方 ONNX 示例](https://github.com/QwenAudio/SenseVoice/blob/main/demo_onnx.py)：对应参数是 `language="auto"`、`textnorm="withitn"`。本项目已对齐此设置；这不等于已经证明准确率提高。
- [FunASR ONNX 解码器](https://github.com/modelscope/FunASR/blob/main/runtime/python/onnxruntime/funasr_onnx/sensevoice_bin.py)及[SenseVoice 模型代码](https://github.com/QwenAudio/SenseVoice/blob/main/model.py)：使用多任务前缀及 greedy CTC 解码。情绪前缀位为输出 frame 1。

采样保持 16 kHz、单声道、PCM16 little-endian。PCM 除以 32768 转为浮点；官方特征前端按其契约恢复幅度尺度。没有按情绪目标调整增益、利用文字关键词替代模型、强制禁止未知标签，或杜撰置信度。

官方 ONNX 仓库提供的是预导出量化权重。本次没有同源 FP32 对照，因此不能把某次误判或 UNKNOWN 归因于量化。权重及 tokenizer 的来源、文件提交版本、SHA-256 和模型许可证保存在模型 manifest。

## 可复现的公开样例研究

工具：`tools/evaluate_emotion.py`。样例、标注清单和报告均写入被 Git 忽略的缓存目录，不包含用户历史录音、私人转写或配对口令。

公开参考集来自 [CREMA-D 作者仓库](https://github.com/CheyneyComputerScience/CREMA-D)，许可为 ODbL 1.0，单条内容适用 Database Contents License 1.0。工具保留来源和文件 SHA-256。

选择规则在推理前固定：使用 `tabulatedVotes.csv` 的 **voice-only** 票（`queryType=1`），至少 8 名评分者，至少 75% 一致；多数票与表演类别一致；每类按文件名顺序选男、女各一条，不查看模型输出后挑样例。共 12 条英文表演语音，覆盖愤怒、厌恶、恐惧、开心、中性、悲伤。另加 1 条官方普通话普通朗读作中性观察对照，它没有独立人工 SER 金标。

这只是小型、偏清晰的英文参考研究，**不能外推普通话部署准确率**，也不对应完整 CASIA、RAVDESS 或 CREMA-D 基准。裁短后可能已经不包含完整情绪表达，原整句标注不能自动当成短裁片段的新金标。

### 四种语言／ITN 参数

共 13 条 × 4 种设置 = 52 次真实推理。

| 设置 | 12 条英文的原生标签 | 普通话对照 |
|---|---|---|
| auto + woitn，原设置 | 12 UNKNOWN | NEUTRAL |
| auto + withitn，官方评测对应设置 | 12 UNKNOWN | NEUTRAL |
| 已知语言 + woitn | 12 UNKNOWN | NEUTRAL |
| 已知语言 + withitn | 12 UNKNOWN | NEUTRAL |

已知语言在英文样例中为 `en`，普通话样例中为 `zh`。结果说明这组样例中改 ITN 或指定语言没有改变原生情绪标签，不能宣传“调参提高命中率”。UNKNOWN 是当前 checkpoint 的实际输出，前缀原始分数也显示未知 token 胜出，不是漏了标签映射。

### VAD 裁剪与边缘上下文

共 13 条 × 3 种设置 = 39 次真实推理，比较原始整段、现有 FSMN-VAD 裁剪、在裁剪结果两边各保留至多 150 ms 原始上下文。三组均为英文 12 UNKNOWN、普通话 NEUTRAL。

现有 VAD 配置已经有起点回看与终点扩展。该研究未提供额外 padding 改善标签的证据，因此没有盲目修改生产裁剪，也没有添加人工静音来改变判断。

### 短时长敏感性

共 13 条 × 5 种设置 = 65 次真实推理。

| 保留范围 | 英文 12 条 | 普通话对照 |
|---|---|---|
| 完整片段 | 12 UNKNOWN | NEUTRAL |
| 开头 300 ms | 12 UNKNOWN | UNKNOWN |
| 开头 600 ms | 11 UNKNOWN、1 NEUTRAL | UNKNOWN |
| 开头 1000 ms | 12 UNKNOWN | UNKNOWN |
| 开头 2000 ms | 12 UNKNOWN | NEUTRAL |

普通话对照开头含约 610 ms 静音，所以极短开头不能与整句等价。结果支持暴露送入时长、提示上下文不足；它不支持用某个时长阈值硬改模型标签。生产中小于 1 秒的 `short_context` 只是时长提示，仍保留模型的原生标签。

### 与官方 wrapper 的一致性

运行 `--suite parity` 比较同参数官方 wrapper 与项目适配器的标签、声音事件、全部原始 token，并记录每次模型 forward 次数。原始输出记录保存在 `emotion-study-parity.json`。该检查用于防止候选提取或质量统计改变原生解码，不是额外准确率基准。

实测 13 条 × 2 条路径 = 26 次推理，13/13 的 `label`、`event`、`raw_tags` 全部一致；每次调用均只有 1 次 forward。四批研究合计 182 次真实推理。18 项模型适配单测另覆盖全部官方情绪标签、原始 UNKNOWN 不被文字或候选覆盖、PCM 幅度、质量统计、短片段、不重复 forward 和无效输入；它们不运行真实模型。

### 重跑

```powershell
.venv/Scripts/python.exe tools/evaluate_emotion.py --prepare-only
.venv/Scripts/python.exe tools/evaluate_emotion.py --suite prompts
.venv/Scripts/python.exe tools/evaluate_emotion.py --suite cuts
.venv/Scripts/python.exe tools/evaluate_emotion.py --suite duration
.venv/Scripts/python.exe tools/evaluate_emotion.py --suite parity
```

默认监听本地 ASR 的录音／处理状态，暂停实验子进程给真实录音让路。因此研究报告的 wall time 可能包含暂停时间，不能当作独占速度基准；有 `cpu_ms` 的记录排除了暂停。正式性能验收应独立串行执行。

## 输出字段

`label` 仍为原生标签映射：neutral、happy、sad、angry、fearful、disgusted、surprised 或 unknown。`event`、`raw_tags` 保留模型依据。`status=ready` 表示分析流程返回，不表示模型确定了情绪。

新增字段不改变这些含义：

| 字段 | 含义 |
|---|---|
| `candidates` | 至多 3 个已知情绪的 `{label, score}`，按本次 forward 的情绪前缀位原始分数排序 |
| `audio_quality.duration_ms` | EmotionRecognizer 实际收到的片段时长，不是原始整句时长 |
| `audio_quality.analyzed_ms` | 本次实际分析的前缀时长 |
| `audio_quality.peak` | 分析区间 PCM 归一化峰值，范围 0..1 |
| `audio_quality.rms_dbfs` | 分析区间 RMS dBFS；全数字零时为 null |
| `audio_quality.clipping_ratio` | 分析区间中恰好达到 PCM16 数字上下限的样本比例，仅提示削波风险，不能证明模拟链路已经削波 |
| `audio_quality.reason` | no_audio、below_feature_window、no_signal、short_context、truncated 或 null |

候选分数**不是概率或置信度**，不能转成“情绪准确率百分比”。候选不覆盖原生 UNKNOWN，不计入“模型已确定”的情绪统计，也不产生声学词级标签。不同片段的分数不应直接比较。

无音频、不足 25 ms 特征窗或分析区间全为数字零时，不运行模型，返回 unknown 和空 token／候选；低音量但非零信号不会被自动屏蔽。短片段、削波风险和截断信息均不强制改写模型标签。

两级长度上限不同：上游从每个 VAD 分句中最多截取开头 12 秒送入情绪队列；recognizer 再以 15 秒作防御上限。因而正常链路中的 `duration_ms` 已经是上游截过的送入片段。它不能证明整句只有这么长，也不能代表未分析的句子尾部。

## ASR 性能保护

情绪保持独立子进程、单线程 ORT、低进程优先级，录音／ASR 处理时暂停，待 ASR 释放 CPU 后恢复。没有把情绪模型放进 ASR feed 关键路径。

候选来自**同一次 forward** 已产生输出的情绪前缀位，只读取七个标量；不再次调用模型，不复制整份 CTC logits。解码沿用官方 argmax、相邻去重、blank 过滤和 tokenizer。音频质量统计也仅在 SER 进程完成。

后续若要判断普通话情绪准确性，需要取得合法、独立、带声学情绪标注的普通话样本，预先固定评测协议。更改未知标签策略、量化方式或质量阈值都应在该参考集上另做验证，不能靠文字语义或单个演示样例代替。
