# 局域网协议 v1

电脑是唯一字幕与设置分发端。音频不经过小程序或 BLE。默认 TCP 端口 8765，PCM 为 16000 Hz、单声道、signed PCM16 little-endian。

## 连接

- 开发板：`/ws/device/{device_id}?token={pairing_token}`。
- 小程序：`/ws/client/{device_id}?token={pairing_token}`。
- `device_id` 仅允许 `[A-Za-z0-9_-]{1,40}`。
- token 是本地生成的随机配对口令，勿提交。两种连接都由客户端主动发起。开发板同 ID 重连替换旧连接、结束旧录音。慢客户端不能阻塞音频。
- GET `/api/health` 只报告就绪与模型状态；配对详情与历史不在未认证健康接口返回。

## 开发板 → 电脑

JSON 字段 `type` 标识消息。所有控制消息与二进制音频按同一 WebSocket 顺序发送。

- `hello`: `protocol:1, firmware:"...", settings:{...}, capabilities:["history_display"]`。能力字段可省略，只有固件实际支持才声明。电脑回当前状态与最近字幕。
- `record_start`: `recording_id`（设备生成的唯一字符串，<=64字符）。服务回 `record_ready` 后发送音频。为保留按下后的句首，设备在等待 ready 期间缓存本次音频。模型未就绪/忙时返回 error，不伪造结果。
- binary: 20 ms / 640 字节为常用帧；最后一帧可以较短但必须偶数字节。上限 6400 字节/帧；后端有有界队列，溢出明确失败，不静默丢音。
- `record_stop`: `recording_id`。必须在所有已采集尾包之后发送。松开后停止采音；中间停顿不会结束整次录音。
- `record_cancel`: `recording_id`，丢弃当前录音。
- `level`: `recording_id, level`（0..1），最多 10Hz。
- `settings_ack`: `request_id, settings`（实际应用值），可附 `error`。收到设备确认后电脑才向小程序报告已应用。
- `display_ack`: `request_id`，可附 `error:busy|too_long|invalid`。只在手动历史内容已写入显示状态后确认；按键 Reserved、采音或处理中应拒绝。

## 小程序 → 电脑

- `settings_set`: `request_id, settings`，仅允许下表字段。电脑校验后转发开发板。设备不在线则返回错误，不宣称应用成功。
- `history_get`: 请求最近字幕。连接成功也会收到 `snapshot`。
- `history_correct`: `request_id, recording_id, segment_id, expected_edit_version, text`。仅可校对已完成的分句；`text` 为去首尾空白后非空、最多512个Unicode码点且UTF-8不超过1536字节的字符串，`null` 为恢复原始显示。原 `transcript.text` 永不被校对覆盖。初始 `edit_version=0`；SQLite提交后版本递增并广播 `history_corrected`。版本不一致返回 `history_conflict` 和最新快照，客户端保留编辑草稿。
- `history_display`: `request_id, recording_id, segment_id, source:original|corrected`，推送校对版本必须附 `expected_edit_version`。选择原始或校对内容手动推OLED，不重新识别、不会修改历史。录音/识别期间、上一推送未确认、固件未声明能力时明确拒绝。单次UTF-8不超过1536字节；不静默截断。
- `ping`: 返回 `pong`，用于前台保活。

设置：`font_scale` 1/2/3/4；`display_mode` `page`/`scroll`/`typewriter`/`static`；`page_ms` 500..10000；`scroll_speed` 5..60 px/s；`brightness` 1..255；`animation` boolean。

## 电脑 → 两端

- `hello`: `protocol:1, device_id, ready, settings, capabilities`。capabilities由当前开发板实际声明，断线清空；设备hello更新后客户端收到快照。
- `record_ready`: `recording_id`。设备开始排出本次缓存并持续发送。
- `status`: `state` 为 `offline`/`idle`/`recording`/`processing`/`error`，带 `device_id, recording_id`（无则 null）、可选 `message`。
- `transcript`: `device_id, recording_id, segment_id`（整数，从0递增）, `revision`（整数）, `text, final`（boolean）, `start_ms, end_ms`。同录音同分句以 revision 较新者覆盖，不能追加两遍结果。`final:true` 是分句完成，不代表整次录音完成。
- `emotion`: `device_id, recording_id, segment_id, label, event`；可有 `status`（`ready`/`skipped`/`error`）。label 为 SenseVoice 原始标签映射：neutral/happy/sad/angry/fearful/disgusted/surprised/unknown。没有识别标签时必须 unknown，不能按关键词伪造情绪；不提供模型没有输出的置信度。
- `recording_done`: `recording_id, segments, audio_ms, final_latency_ms`，松键之后所有分句最终结果已发出；情绪结果可稍后单独到达。诊断字段：`worker_calls` 为本次推理调度次数，`audio_queue_peak_ms` 为排队音频峰值，`first_partial_ms` 为服务端会话创建到首个临时字幕的时间（没有临时字幕时为null）。
- `settings_set`: 只发设备，`request_id, settings`。
- `settings_applied`: 两端，`request_id, settings`，仅由设备 ACK 触发。
- `settings_pending`: 只发请求客户端，尚待设备 ACK。
- `history_corrected`: 只发客户端，`request_id, recording_id, segment_id, edit_version, corrected_text, corrected_at`。`corrected_at`为UTC ISO时间。版本独立于ASR `revision`，旧快照不能覆盖较新的校对；恢复原始也保留递增版本与`corrected_text:null`。
- `display_set`: 只发设备，`request_id, recording_id, segment_id, source, edit_version, text`。此处`request_id`为服务端生成的独立命令nonce，设备原样ACK；客户端继续收到自己原来的request_id，防止迟到ACK确认另一条推送。设备显示原始/校对标记，下一次正常BOOT录音覆盖手动历史；不得修改流式字幕的录音/分句去重游标。
- `display_pending`: 只发请求客户端，尚待设备确认。
- `history_displayed`: 收到当前设备正确`display_ack`后向客户端广播，带`request_id, recording_id, segment_id, source, edit_version`。超时、旧ACK、拒绝均不得报告成功。确认表示内容已进入显示任务，物理OLED是否接好仍需实际观察。
- `error`: `code, message`，可有 `recording_id, request_id`。新录音/断线后旧异步结果不得改写当前录音状态。
- `snapshot`: `device_id, state, recording_id, settings, history, capabilities`。history 为有界最近 `transcript` 与 `emotion` 合并记录，按录音、分句键覆盖。可选校对字段`edit_version, corrected_text, corrected_at`与原文一起保存；客户端总文字预算同时计算原文与校对文本。

## 按住录音状态机

启动先等按钮释放；按下与松开消抖约25ms。按下→缓存采音+请求 ready→流式上传；松开→停止采音→排空尾包→stop→等待 recording_done。busy/断网/过载要显示明确错误并要求先释放再按，不把旧音频续进下一次录音。最长单次录音默认60秒，可配置。

OLED 的音量与嘴形直接使用本机 PCM RMS，不等待服务端。I²S 采集、网络、显示各自运行，显示最多20 FPS。电脑发送临时字幕但不用固定频率发送整份历史。

20ms是传输粒度，电脑按既有100ms VAD粒度聚合后提交推理线程，最后不足100ms的尾包随stop立即提交。VAD回报可以回溯端点、单次含多个边界，网关按绝对样本位置顺序处理并回填句首。整次上限60秒，不以任意12秒重置识别上下文。
