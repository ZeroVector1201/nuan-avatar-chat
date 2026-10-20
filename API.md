# 接口约定

页面同源使用 `/ws`。不需要账号或任务 ID。适配层只接受同源浏览器连接；模型地址在服务器环境变量配置。

## 浏览器 → 适配层

| 消息 | 字段 |
|---|---|
| `actor_start` | 启动持续人物流 |
| `text` | `turn_id`：唯一字符串；`text`：1–1500字符 |
| `audio` | `turn_id`；`audio`：base64 WAV，单声道 PCM16，8–48 kHz，0.1–30秒 |
| `cancel` | 取消当前回复，保留已完成聊天上下文 |
| `reset` | 取消回复并清空当前连接的聊天上下文 |
| `ping` | 保持连接 |

## 适配层 → 浏览器

| 消息 | 字段与用途 |
|---|---|
| `hello` | 连接就绪、`portrait` |
| `status` | `turn_id`、`label` |
| `transcript` | `turn_id`、`text`，语音识别结果 |
| `text` | `turn_id`、`text`，累计回复；前端先暂存，语音开始再显示 |
| `actor_stream_start` | `stream_id`、`mime`，初始化 MediaSource |
| `actor_stream_chunk` | `stream_id`、`seq`、`data`：base64 fMP4；序号从0连续递增 |
| `actor_speech_start` | `turn_id`、`stream_id`、`text`，准备播放这轮回复 |
| `actor_cue_start`、`actor_cue_end` | `turn_id`、`stream_id`、`pts`：人物媒体时间轴上的秒数 |
| `done` | 生成完成，**不代表播放完毕** |
| `cancelled` | 取消确认；前端已即时停止声音 |
| `error`、`actor_error` | 可选 `turn_id`、`message` |

人物视频一直延续；每轮回复不用重新挂载人物或重置解码器。字幕与对话气泡在 `cue_start` 到达实际播放时间时一起显示；到 `cue_end` 才恢复输入。

## 适配层 → 人物推理服务

连接 `CONTINUOUS_AVATAR_URL` 对应的 `/actor`：

1. 发 `{portrait_id, transport: "mp4"}`。
2. 收 `{type: "ready", mime: ...}`。
3. 服务器持续发送二进制 fMP4，包括初始化段和静默倾听画面。
4. 一轮说话：发 `{type:"begin", turn_id}`，依次发二进制24 kHz PCM16，发 `{type:"finish", turn_id}`。
5. 服务返回 `{type:"cue_start", turn_id, pts}`、`{type:"cue_end", turn_id, pts}`。
6. 打断：发 `{type:"cancel", turn_id}`；人物流保持连接。

这是现有 Nuan 连续真人服务的接口，不是任意数字人项目的通用协议。更换渲染服务时修改 `actor.py` 即可，不需要引入原平台。
