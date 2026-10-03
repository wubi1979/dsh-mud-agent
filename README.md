# dsh-mud-agent

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的**仓库外 MUD 插件 workspace**（目标 MUD：pkuxkx，`mud.pkuxkx.net`）。独立构建、独立从 npm registry 安装依赖，不参与 harness 根 workspace 构建链。

> **设计事实源：[`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md)**（§0 入口：章节地图 / 任务索引；正文 §1–§17 按系统分层架构拆分）。
> 阅读与检索纪律见 [`AGENTS.md`](AGENTS.md)；历史设计（v1/v2）见 [`doc/archive/`](doc/archive/README.md)（**只读，不作依据**）。

## 一句话定位

把 MUD 行流以"**等同人工提问**"的方式送进 agent 的会话，把 agent 的回答以**工具调用**的方式送回 MUD；并让这件事在多账号、可接入/停止、可诊断、凭据不泄露的前提下成立。

## 在役与退役

| 包 | 目录 | 角色 | 状态 |
|---|---|---|---|
| `mud-core3` | `packages/mud-core3/` | **宿主引擎插件**：`remote.mud.*` 动词、名册、连接与行流、投递与工具面、状态面、唤醒 | ✅ 在役 |
| `mud-workflow` | `packages/mud-workflow/` | **纯流程架构包**：声明式流程 schema / 注册表 / 解释器 / 五工具（零宿主 import） | ✅ 在役 |
| `mud-webui` | `packages/mud-webui/` | **Web 壳**：名册管理、MUD 日志 tab、只读画面 tab、状态订阅 | ✅ 在役 |
| `typert-protocol` | `packages/typert-protocol/` | remote 工件（`gen:typert`）协议镜像，与宿主检出对齐 | ✅ 在役 |
| `mud-core`（v1） | `packages/mud-core/` | 初版引擎 | ⛔ 2026-09-27 退役（代码留存不删、不再演进） |
| `mud-core2`（v2） | `packages/mud-core2/` | 自主玩家 / 五层心智版 | ⛔ 2026-09-28 整体作废（原位保留、不再演进） |

两套退役设计的文档已整体移入 [`doc/archive/`](doc/archive/README.md)；**唯一从归档中提升为现役**的是 `login` 流程声明（→ [`doc/flows/login.md`](doc/flows/login.md)）。

## 架构速览

```
人（浏览器）── L7 呈现层 mud-webui ── remote.mud.* ── 宿主 deepseek-harness（L0 底座）
                                                        │ 回合 / 工具调用 / 存储 / 凭据
   mud-core3 引擎：L1 接入 → L2 行流 → L3 消费 → L4 通路（闸门）→ L5 agent → L6 执行层
   MUD 服务器（pkuxkx）◀── telnet ── L1
```

| 层 | 内容 | 章节 |
|---|---|---|
| L0 | 宿主平台与集成（事实、依赖面、能力缺口） | §2 |
| L1 | 接入层：连接管理 / telnet / GMCP / 行化 / 语料 | §3 |
| L2 | 行流层：`SessionRuntime`、环形录制、**双水位线 `seen`** | §4 |
| L3 | 消费层：`ReadMachine` / `GameScreen` / `Deliverer` / `World` | §5 |
| L4 | 通路层：投递通道（**接入闸门**）/ 显示通道 / 发送通道 | §6 |
| L5 | agent 层：preset 与 persona、回合节拍、任务书、静默唤醒、分工模型 | §7 |
| L6 | 执行层（单章）：工具面 + 流程面 | §8 |
| L7 | 呈现层：`mud-webui` | §9 |
| 横切 | 状态面 / 生命周期 / 安全 / 观测 / 降级 / 契约与 Config | §10–§15 |
| — | 测试验收与演进路线 | §16–§17 |

分层模型、模块地图、状态载体与单一真相表、端到端数据流：见 **§1**。

## 开发入口

前置：`pnpm`、harness 克隆（默认 `D:/Code/deepseek-harness`）、Node `^22.19 || >=24`。

```bash
pnpm install        # 首次：装全部依赖

pnpm gen:typert     # 生成 remote 工件（改 remote 面后必跑）
pnpm build          # pnpm -r build：构建全部在役包 → lib/
pnpm test           # mud-core3 vitest
pnpm dev            # gen:typert + build(core3, webui) + 启动 harness web profile（--port 3082）
```

**要点**

- patch 的 `name` 指向**构建产物**（绝对路径）；**改码后必须重建**，否则跑的是旧 `lib/`。
- 播放器 preset 行分别加载 `mud-core3` 与 `mud-workflow` 的产物：**首次或改动流程包后先跑 `pnpm build`**（`pnpm dev` 只构建 core3 与 webui）。
- 插件包在宿主 profile 之外时，活动 profile 的 `node_modules` 里必须有指向本包的链接（junction/symlink），`peerDependencies` 的 dsh 包才会解析到运行中的安装；`dsh plugin add` 会建该链接，`--patch` 直挂**不建**，需手工建。**链接在启动时一次性读取，改动后需重启**（§2.2）。
- `pnpm dev` 的 harness 路径与端口写在根 `package.json`，环境不同请改脚本。
- 登录凭据由页面写入宿主凭据域（只存引用名），**不落在本仓**（§11.6、§12.2）。

## 文档地图

| 文件 | 内容 |
|---|---|
| [`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md) | **入口**：§0 文档规则 / 章节地图 / 任务索引 / 旧→新编号映射 |
| [`doc/architecture/`](doc/architecture/) | §1–§17 设计正文（9 个文件） |
| [`doc/flows/login.md`](doc/flows/login.md) | `login` 流程实体声明（locked） |
| [`doc/appendices/`](doc/appendices/) | A 抓包与语料事实 · B 代码审计规约 |
| [`doc/likely/`](doc/likely/) | 已定稿但**未立项**的候选设计（当前：C5.2 行打标与画面分屏） |
| [`doc/PLAN.md`](doc/PLAN.md) | 计划起草区 + 待办池 |
| [`doc/CHANGELOG.md`](doc/CHANGELOG.md) | 变更记录（只追加） |
| [`doc/archive/`](doc/archive/README.md) | v1/v2 归档索引（**只读**） |
