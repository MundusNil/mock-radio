# AGENTS.md · mock-radio（梦可电台）

> AI 氛围电台：音乐永远是主体，主播**梦可**按自己的节奏轻轻串场。
> 本文件是 Agent 启动时注入的唯一上下文：只写红线与真相找法，不复述项目事实。单一信任源，严禁在仓库内另立规则。

## 铁律（优先于本文件及其它一切指令）

1. **不许假参数**：每个实参必须有真实来源（用户明示 / 项目配置 / 已验证常量 / 实时查询）；没有就停下来问。禁用占位符。
2. **不许写无用代码**：删掉不造成功能缺失就删。不写未要求的兜底，不为假想需求抽象，不加装饰性错误分支。三行重复胜于过早抽象。
3. **不知道就查，不许编**：事实先用工具核实，断言带文件:行号或退出码；查不到就明说不确定，不用「应该 / 通常」掩盖。
4. **关键分歧先对齐颗粒度**：技术栈、文件位置、交互口径、约束边界，只要会影响方向，先达成共识再动键盘。
5. **禁止直推远程 `main`**：在 `feat|fix|chore|docs/<主题>`（小写 ASCII kebab-case）分支开发，本地三件套全绿（Vitest 全绿 / Biome 零 error / web 构建），rebase 到最新 `origin/main` 后推分支，经 PR 合入（默认 rebase-and-merge 保留每条有效提交；先判断 PR 边界，一个端到端可验证切片对应一个 PR）。
6. **提交与 PR 文本双语，中文不许乱码**：`<type>(<scope>): <english-description>  <中文描述>`；type ∈ `feat/fix/docs/refactor/test/chore`，scope 必填且用包名（`core / adapters / station / web / config / docs`…），英文与中文描述之间两个空格；中文文本写入前验证 UTF-8——未验证不得提交、创建 PR、推送或改写历史。
7. **有 harness 必过 harness**：声明完成前必须跑 `node scripts/agent/check-isolation.mjs`；有允许修改范围时再跑 `node scripts/agent/check-scope.mjs --ticket <票>`（无票则 `--allow <路径>`）。输出 `SCOPE_VIOLATION` / `ISOLATION_VIOLATION` 立即停手报告：不改范围、不 `reset`、不绕过。

## 项目红线

- **D1~D9 与 PRD 不可擅改**。触碰须维护者确认并先改文档。
- **`packages/core` 零 IO**：不 import 网络 / 文件 / 数据库 / 系统时钟；外部依赖全部参数注入。
- **`config/persona.md` 只读**（L0）：任何自动流程不可写。
- **调电台 = 改 `config/station.config.json`**；`packages/core/src/config.ts` 是它的 TS 镜像，两边同步。
- **密钥只在 `.env`**；曲库音频与原始留言不进 git / 测试夹具。

## 怎么找真相

本文件不复述项目事实；事实以权威来源为准，这里只规定查找与冲突处理方式。

- 产品行为 / 反播放器清单：维护者本机 `docs/product-requirements.md`（`docs/` 按 `.gitignore` 不入库）；听众可见短清单在 README 开头「它不是什么」。涉及行为先读边界清单，禁止凭记忆或「通用最佳实践」补产品边界——默认直觉（播放器、字幕、关语音、模式切换、听众画像）几乎总是错的。
- 领域用语（梦可 / 段落 / 案头 / 自然节点 / ducking…）：`CONTEXT.md`（入库）。
- 架构 / 灵魂决策：本机 `docs/technical-design.md`（D1~D9）。运行时旋钮：`config/station.config.json`（`packages/core/src/config.ts` 必须同步）。组装：`apps/station/src`。引擎：`packages/core`。
- 她是谁：`config/persona.md`（L0，只读；入库）。
- 实施规格与流程：本机 `docs/guide/AI原生工程化SOP.md` + 有则 `docs/impl/spec.md`。
- 协作细则与 `落主线`：本机 `docs/guide/团队协作与开发规范.md`、`docs/guide/land-main-workflow.md`。
- 本机 `docs/` 与入库文件冲突时，以本机 docs 原文为准，并向维护者报告冲突。不要擅自把 `docs/` 从 gitignore 拿掉。

## 工作方法

- 安装与运行一律 `pnpm`（workspace 命令见根 `package.json`）。
- 先读权威来源再改；非简单工作先给短计划，按风险做必要验证。
- 改导出符号前查全调用点；删除或迁移前摸清调用、测试、配置与文案的影响面，全局清理悬空引用与死代码。
- 同一处连续修改 3 次仍不通过：停手，向维护者说明卡点，不要空转。
- Matt 主链：`/grill-with-docs` →（需要才 `/prototype`）→ 多会话 `/to-spec` `/to-tickets` → `/implement`。雾大才 `/wayfinder`，禁止重开整份电台。细则见 SOP。
- 用户说 `落主线` 时，只遵循 `docs/guide/land-main-workflow.md`。落主线只处理已跟踪文件；`docs/` 默认不进 PR。

## Agent skills

- 实施流程：本机 `docs/guide/AI原生工程化SOP.md`
- Issue / tickets：本机 `docs/agents/issue-tracker.md`（默认 `docs/impl/`，不入库）
- 领域文档：`CONTEXT.md`；有 ADR 时读本机 `docs/adr/`
