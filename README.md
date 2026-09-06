# mock-radio · 梦可电台

AI 主播驱动的氛围音乐电台。音乐永远是主体，主播**梦可**按自己的节奏轻轻串场、回应留言。

<a href="https://opensource.org/licenses/Apache-2.0"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="License Apache-2.0"></a> <img src="https://img.shields.io/badge/Node-%E2%89%A522-339933?logo=nodedotjs&logoColor=white" alt="Node >=22"> <img src="https://img.shields.io/badge/TypeScript-3178C6?logo=typescript&logoColor=white" alt="TypeScript"> <img src="https://img.shields.io/badge/Vite-646CFF?logo=vite&logoColor=white" alt="Vite"> <img src="https://img.shields.io/badge/pnpm-FF6F3E?logo=pnpm&logoColor=white" alt="pnpm">

![梦可电台待机画面：晴空主题氛围背景与开台按钮](assets/img/hero-idle.webp)

*待机 · 晴空主题*

![梦可电台开台画面：暮紫主题，ON AIR 亮起，正在播放曲目](assets/img/hero-live.webp)

*开台 · 暮紫主题 —— ON AIR 亮起，直接跳进正在进行的节目*

> [!IMPORTANT]
> **它不是什么**（按播放器/聊天机器人的预期去用，会觉得它坏了）：
>
> - 不能切歌、暂停、回放——歌随机播，原则上完整播完
> - 界面不显示她说的话——只有声音，没有字幕（刻意设计）
> - 不认识你是谁——不登录、不建档案、不做个性化推荐

## 快速开台

```bash
corepack enable         # 没有 pnpm 的话先跑这个（或 npm i -g pnpm）
pnpm install            # Node >= 22
pnpm setup:ffmpeg       # 首次：自动下载官方 FFmpeg 构建（已有系统 ffmpeg 会跳过）
pnpm start              # 体检环境 → 曲库自动入库 → 拉起电台 + 面板
```

把音频丢进 `config/library/`（子文件夹随便嵌套，支持 `.mp3` `.flac` `.ogg` `.m4a` `.wav` `.opus` `.aac`），启动后浏览器打开 **http://localhost:9731** 即可收听。

> [!TIP]
> **没有 API key 也能开台**：曲库照常随机播送，只是梦可不开口——先当纯音乐电台听。密钥随时在面板右上角「设置 → API 管理」补，保存即热生效，不用重启。

<details>
<summary>环境细节与可选依赖</summary>

- **TTS**：默认 **MiniMax 云端**（不需要本地 Python）。只有跑 `pnpm voice:compare`（edge-tts 音色盲听）或把 `tts.provider` 改回 `edge-tts` 时才需要 `pnpm setup:voice`
- **FFmpeg**：`pnpm setup:ffmpeg` 一键装进仓库（Windows 拉 gyan.dev 官方 zip，Linux 拉 johnvansickle 静态构建，macOS 走 brew）；已有系统 ffmpeg 则跳过。手动兜底：`winget install Gyan.FFmpeg` / `brew install ffmpeg` / `apt install ffmpeg`
- **习惯 `.env` 管理密钥**：`cp .env.example .env` 后填入，效果同面板
- **端口**：电台 `:9730`、面板 `:9731`；`pnpm stop` 回收残留进程

</details>

## 体验细节

- **她只在有人听时开口**（`speakWhenAlone: false`）——不开页面 = 空房间，她不会说话
- **串场间隔 5~8 分钟**，不是一直说；说话时音乐平滑压低，说完缓缓涨回来
- **任何一环失败都静默处理**——文案或语音生成失败就放弃该段，音乐从未停，绝不播报技术错误
- **六套氛围配色**，面板右上角「设置 → 主题」切换，跟随你的偏好

## 日常使用

| 命令 | 作用 |
| --- | --- |
| `pnpm start` / `pnpm stop` | 一键启动 / 回收 9730 · 9731 残留进程 |
| `pnpm setup:ffmpeg` | 首次部署补齐 FFmpeg（装进 `tools/ffmpeg/`） |
| `pnpm scan` | 手动重扫曲库（通常不需要，启动时自检） |
| `pnpm voice:compare` | TTS 音色盲听对比（挑她的声音） |
| `pnpm test` / `pnpm check` | Vitest 全量 / Biome lint + 格式 |

调电台 = 改 **`config/station.config.json`**（改完重启生效）：

| 区块 | 管什么 |
| --- | --- |
| `engine` | 说话频率、留言回应时限、小主题概率、空房间是否开口 |
| `scheduler` | 防重复窗口；可选的文件夹权重 / 时段加成 |
| `audio.ducking` | 说话时音乐压低多少、恢复多快 |
| `llm` / `tts` | 模型、音色、语速 |

## 排障

| 现象 | 处理 |
| --- | --- |
| 启动即退出并列出原因 | 按提示补依赖；`node scripts/start.mjs --check` 看体检详情 |
| 一直不说话 | ① 打开 9731 页面了吗 ② 密钥配了吗（没配 = 串场静默，音乐照常）③ 串场间隔 5~8 分钟，不是一直说 |
| 某首歌「无法读取时长」 | ffprobe 解析失败，该首跳过不入库 |
| 打开页面没声音 | 浏览器拦截自动播放，点一下页面 |
| 端口被占用 | 改 `station.port`，`apps/web/vite.config.ts` 代理同步改 |

## 参与开发

仓库结构：`packages/core`（电台大脑，纯逻辑零 IO）· `packages/adapters`（LLM / TTS / SQLite / ffprobe）· `apps/station`（守护进程 `:9730`）· `apps/web`（面板 `:9731`）· `config`（人格、配置、曲库）。

两条铁律：`config/persona.md` 只读，是梦可的人格层；`packages/core` 不许出现任何 IO。

AI 协作入口见 [`AGENTS.md`](AGENTS.md)，领域用语见 [`CONTEXT.md`](CONTEXT.md)。
