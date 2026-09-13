# dsh-mud-agent

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 **仓库外 MUD 插件 workspace**（pkuxkx，`mud.pkuxkx.net`），独立构建、独立从 npm registry 安装依赖，不参与 harness 的根 workspace 构建链。

两个兄弟子包：

| 包 | 目录 | 角色 |
| --- | --- | --- |
| `@deepseek-ai/dsh-mud-core` | `packages/mud-core/` | MUD 核心服务（telnet/GMCP 客户端、感知/规则管线、agent 桥、触发器 LLM），发布为 `ctx.mud` |
| `@deepseek-ai/dsh-mud-webui` | `packages/mud-webui/` | WebUI 壳（xterm + 决策日志），消费 `ctx.mud` |

两包独立以 tsc/tsdown 产出 `dist/`，插件的 `cordis.patch.yml` 把 `name` 指向 `dist/index.js` 的绝对路径（`file:///` 形式），按标准 npm 包发布。

> mud-core 是统一 host 引擎，mud-webui 是目前唯一壳。一次启动挂 **core + 壳**；终端壳（mud-tui）已在 M0 移除，如需换壳只需换 patch。

## 架构

> 设计事实源：**[`doc/ARCHITECTURE.md`](doc/ARCHITECTURE.md)**（版本 v0.1：不变量、术语、L1–L4 分层、权限档位、preset 化、交付切片）。本节只是速览，冲突以文档为准。

- **用户即会话**：一个 MUD 账号 = 一个 DSH 会话 = 一个 `MudSessionRuntime`（连接绑定、感知折叠、观察窗、命令-应答桥、命令队列、WorldModel、recall 缓冲、登录看门狗都在该运行时内）。跨会话没有共享可变状态。
- **官方路径分工**：
  - 创建用户 = 创建会话：页面调官方 `ctx.sessions.create()`（id 由 host 分配并返回，页面不自铸身份）；切换用户 = 官方 `ctx.sessions.open(id)`。
  - 回复用户 = 回复会话：host 用 `ctx.agents.get(sessionId)` **只读**解析该会话的 live agent，再 `agent.followup(mud-owned 消息)` 投递（与官方 webhook 入口同一模式）。本插件**不创建、不 dispose** agent；会话无 live agent 时行进该会话观察窗滞留，待官方 `agent/created` 冲刷。
  - 网络连接只接入消息：`MudConnectionManager`（`runtime/connection.ts`）只认 host/port；绑定方向唯一 —— 会话 → 连接（`runtime.connectionId`），传输层不持有会话。
- **T1 / T2（lane）**：投递前判类（event 规则命中 → `lane=t1`，其余 → `t2`）写入消息 `source`（`kind='mud-owned'`）；`agent/request` 瀑布注册在**该 agent 自己的 ctx** 上并 `prepend`（防官方 per-session 模型选择覆盖），只在 `lane=t1` 时把 provider 换成 `mud-t1`，其余**不介入**（T2 基线 = 会话自身模型选择）。
  - T1：本地模拟模型 `mud-t1`（官方 `ctx.llm.registerAdapter`），按投递消息的 `turnRef` 取**感知引擎的命中队列**渲染确定性工具调用（不耗真实 LLM，不做文本反查）。
  - T2：真实 LLM（会话当前模型选择），收到按预算裁剪的**批次**。
- **感知与投递（V10）**：`perception/engine.ts`（L1，每会话一实例、多行状态跨文本块持久）+ `perception/split.ts`（L2 单流切分：消费边界前投 T1、其后留作遗留段）。在途命令应答的行只进桥与感知引擎（供命中），不作为投递消息重复出现。
- **工具集（agent 视角）**：`mud_send`/`mud_recall`/`mud_status`/`mud_move`/`mud_look`/`world_patch`/`mud_flow_*`。工具注册在**该会话 agent 的 ctx** 上（`agent.ctx.tools.register`），闭包绑定本会话运行时，随 agent 释放（V10 计划改由官方 `mud-player` preset 挂载，见文档 §9）。
- **HTTP/WS 入口**（全部按 `sessionId` 键控）：`POST /mud/bind`（声明"该官方会话是 MUD 会话"）、`/mud/connect`、`/mud/disconnect`、`/mud/command`、`/mud/captcha/refresh`、`/mud/logs`、`POST /mud/purge`（注销：删用户/删服务器时释放运行时与连接、删该会话全部日志文件）、`GET/POST /mud/capability`（权限档位读写）、`GET /mud/status`、`GET /mud/diag`；推送走 `/mud/ws`，条目自带 `sessionId`，前端按会话过滤。
- **连接入口**：左栏用户行的 ⋯ 菜单（会话体在 blank 期间不渲染）；**不发送占位 prompt** —— `blank` 由首个 `turn/start` 翻转，连接后第一批发出的游戏输出自然开回合翻页。
- **agent 装配（V10 §9，方案 A1）**：MUD 会话的能力面（工具 + 提示区段）由官方 **agent preset** 提供 —— `packages/mud-core/presets/mud-player/` 是 preset 目录，其 `agent.cordis.yml` 是 **`standard` 的整份副本 + 我们的 `mud-agent` 一行**（preset = 该会话的**全部**组装；只写自己那一行会让会话丢掉所有标准工具）。宿主在会话首个回合前用官方 `ctx.agentPresets.select(agent, 'mud-player')` 装配（仅空白会话可切），装配未落地前**不投递**；装配失败留痕并回落宿主侧装配。开关是 `Config.agentPreset`（留空 = 宿主侧装配，回退门）。升级 harness 后需重新对齐这份副本（harness 已知限制）。
- **部署（全部在本包 patch，profile patch 留 `[]`）**：`agent-presets` 的 `roots` 与 `mud-core` 的 `agentPreset` 都写在 `packages/mud-core/cordis.patch.yml`（`--patch` 传入，启动期一层），用户不需要维护 profile patch。片段见 `doc/ARCHITECTURE.md` §9。**不要把这两条写进 profile patch**：本机 profile 是 `patchReload: live`，热应用一次 `agent-presets` 配置会重建它的常驻挂载，导致所有 preset 组装出来的工具当场消失（实测过两次，改回 `[]` 不重启即恢复）。
- **权限档位（V10 §10）**：每会话三档 `observe`（只读：`mud_state`/`mud_recall`，登录流程除外）/`operate`（读写）/`full`（+外围能力）。可见性层按档注册工具（切换即重挂），强制层是官方 `tools/pre-execute` 上的闸门（T1 反射与 T2 推理同权受约束）；危险命令走数据驱动策略表（`deny`：suicide/passwd；`ask`：abandon/steal/kill/drop/quit，`Config.dangerousCommands` 可整体覆盖）。档位是会话日志里的 `mud/capability` 事件 + `mudCapabilities` 投影，读写走 `GET/POST /mud/capability`（`/mud/status` 每行带 `tier`），页面入口在用户行 ⋯ 菜单，右栏状态区显示当前档。**preset 模式下**档位只剩强制层 + 提示说明（共享组装无法按会话切换工具集）。
- **删除用户 / 删除服务器**：配套的官方会话走**归档**（`IWorkspaces.archiveSession` —— 官方没有删除会话，归档即从分组/搜索界面隐藏，会话文件与 workspace 记账保留）；插件侧则调 `POST /mud/purge` 释放运行时与连接、删除该会话全部日志文件、清本页与 host 缓冲。日志是我们自己的资产，按现有按会话落盘的命名直接删除。
- **已移除**：`/mud/prepare` 与自建 agent 的 `createMudAgent`/`prepareAgent`（旧实现与官方 `ApiSessionAgentController` 争夺同一会话的 agent 生命周期，是 T1 不通的根因）。

---

## 开发模式

当前各包以 registry 自装依赖、`dist/` 产物通过 harness 的 **`web` profile** 加载（无需新建 profile 目录——harness 对 `web` 有内置模板，自动创建并借 module-fallback 解析 `@deepseek-ai/*` 上游）。

前置：`pnpm`、harness 克隆于 `D:/Code/deepseek-harness`、Node `^22.19 || >=24`。

```bash
pnpm install          # 首次：按 pnpm-workspace.yaml 装全部依赖

pnpm dev:web          # core + webui：构建并启动 harness web profile（浏览器壳）
pnpm restart:web      # 等价 pnpm run dev:web

pnpm build            # 全量构建 packages/* → dist/
pnpm test             # core vitest（180 用例）
```

等价的手工命令（`dev:web`）：

```bash
pnpm --dir D:/Code/deepseek-harness dsh web \
  --patch D:/Code/dsh-mud-agent/packages/mud-core/cordis.patch.yml \
  --patch D:/Code/dsh-mud-agent/packages/mud-webui/cordis.patch.yml \
  --port 3081
```

> 注意 `--patch` 是**最后**一层：本包 patch 负责插入 `mud-core`/`mud-webui` 两行，所以针对 `mud-core` 的配置只能写在**这份** patch 里；`agent-presets` 的 `roots` 覆盖也放这里（启动期应用，安全），**profile patch 保持 `[]`**（它是热应用的，改错会当场把 preset 组装出来的工具全部卸掉）。

要点：

- `dsh web` 等价 `dsh --profile web`；harness 内置 `web` 模板，无 profile 时自动创建，无需手动写 `~/.dsh/profiles/web`。
- patch `name` 用 `file:///D:/Code/dsh-mud-agent/packages/<pkg>/dist/index.js` 绝对路径，指向 `dist` 产物。
- harness 的 `web` profile 自带 `@deepseek-ai/dsh-web-app` bundle，开发模式下会一并加载（绑定 Web 端口、打开浏览器 dashboard）。**已知取舍**：如只需纯净底座，走下文「正式安装 + 启动」。
- 部署值（服务器地址、账号等）写在 `~/.dsh/profiles/web/cordis.patch.yml`，不进本仓库。

---

## 正式安装 + 启动

> **状态占位**：以下流程要在 mud 包发布到 npm 之后才能完整执行。
>
> 当前 `mud-core` / `mud-webui` 均为 `0.1.1-rc.2`，**未发布**；且 `mud-webui` 对 `mud-core` 依赖仍是 `workspace:^` 本地链接——发布顺序须为 **core → webui**。到时先 `pnpm publish` core，再发布壳。

正式安装走 harness 的 **profile + bundle 装配**（dsh-TUI 的 standalone 模式）：把 mud 包装进一个自定义 profile，用 `dsh --profile` 启动。做法（一次性建立 `mud` profile）：

```bash
# 装核心 + 壳（在 harness 目录下执行）
pnpm --dir D:/Code/deepseek-harness dsh plugin --profile mud add @deepseek-ai/dsh-mud-core
pnpm --dir D:/Code/deepseek-harness dsh plugin --profile mud add @deepseek-ai/dsh-mud-webui

# 启动
pnpm --dir D:/Code/deepseek-harness dsh --profile mud
```

要点：

- `dsh plugin --profile mud add <pkg>` 创建 `~/.dsh/profiles/mud`，把包写进 `dsh.profile.bundles` 清单，并建立 module-fallback 链接。
- `dsh --profile mud` 按 `bundles` 顺序加载 mud-core 与所选壳的 patch（一个 profile 只挂 **core + 壳**）。
- 部署值（服务器、账号）写 `~/.dsh/profiles/mud/cordis.patch.yml`。
- 后续 `pnpm publish` 新版后，在 profile 内 `pnpm update` 即可。

> 发布前的开发期若不绑 web-app，可在 `~/.dsh/profiles/mud/package.json` 的 `dsh.profile.bundles` 只留 `@deepseek-ai/dsh-base`，让 `mud` profile 仅含底座 + 两个 mud 包。
