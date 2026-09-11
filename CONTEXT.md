# mock-radio

一条公共时间线：音乐永远是主体，主播梦可按自己的节奏轻轻串场。本文件是领域用语；架构用语见技能 LANGUAGE.md（module / interface / seam / adapter）。

## Language

**梦可**:
唯一的 AI 主播。2004 年生、女生、家在河南。口味：动漫、书、摄影、唱歌（底色，不编经历）。人格档案在 `config/persona.md`（L0，只读）。台呼才报「梦可电台」；名字不必向听众解释。
_Avoid_: 机器人, 助手, 主播角色

**维护者**:
电台的制作人（本仓唯一人类）。
_Avoid_: 管理员, 用户, operator

**节目引擎**:
每秒 tick 的状态机，只决定何时开口，不生成文案、不选歌。
_Avoid_: 播放器, 定时器, orchestrator

**段落**:
主播一次完整开口。五种：`station_id` / `interlude` / `topic` / `reply` / `request_ack`。
_Avoid_: 消息, 回复, clip, utterance

**段落生产**:
把一次 `plan-segment` 变成可播出的语音（上下文 → LLM → TTS），失败则 沉默保底。
_Avoid_: 生成管线, pipeline, assembler, generateSegment

**案头**:
曲目开播时的检索笔记（作品场景 / 玩家社区 / 乐评）。占用音乐时间预取，LangGraph 多轮（搜→质检→不足补搜，整图挂钟预算 90s）；开口只从笔记写，不再联网。不是 L1 记忆，不是世界书。
_Avoid_: 世界书, RAG, 搜索结果播报

**自然节点**:
允许开口的时机：曲目边界或中段安全窗口（前奏 / 尾奏保护）。
_Avoid_: 打断点, cue point

**曲库调度器**:
确定性选曲：加权随机 + 防重复 + 时段修正。LLM 不参与选歌。
_Avoid_: 推荐, playlist, 播放器

**点歌受理**:
把听众点歌 query 匹配到曲库：命中则 预告再插播，未命中则婉拒。LLM 只抽 query。
_Avoid_: 点歌模式, 点歌队列 UI, 推荐

**调频进入**:
听众打开页面即跳进正在进行的节目（含进行中的段落），不是从头开始。
_Avoid_: 播放, seek 控件, 续播上一首

**公共时间线**:
所有人同一秒的节目位置：当前曲、可选进行中的段落、是否该 duck。重启与听众加入共用同一份快照。
_Avoid_: 会话, 用户进度, 私人时间线

**ducking**:
主播说话时音乐平滑压低，说完恢复。
_Avoid_: 混音, fade, 音量自动化

**空房间沉默**:
无人收听时主播不说话、不积累记忆（`speakWhenAlone=false`）。
_Avoid_: 待机, idle mode

**L0 / L1 / L2**:
人格层（persona.md，只读）/ 节目记忆（策展写入）/ 临时上下文（随会话消散）。
_Avoid_: 用户画像, 聊天记录, RAG

**沉默保底**:
生成失败或来不及时放弃该段落，音乐继续，绝不播报技术错误。
_Avoid_: 错误提示, retry 播报, fallback 文案
