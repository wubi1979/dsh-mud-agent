# dsh-mud-agent

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 **仓库外 MUD 插件 workspace**（pkuxkx，`mud.pkuxkx.net`），独立构建、独立从 npm registry 安装依赖，不参与 harness 的根 workspace 构建链。

两个兄弟子包：

| 包 | 目录 | 角色 |
| --- | --- | --- |
| `@deepseek-ai/dsh-mud-core` | `packages/mud-core/` | MUD 核心服务（telnet/GMCP 客户端、感知/规则管线、agent 桥、触发器 LLM），发布为 `ctx.mud` |
| `@deepseek-ai/dsh-mud-webui` | `packages/mud-webui/` | WebUI 壳（xterm + 决策日志），消费 `ctx.mud` |

两包独立以 tsc/tsdown 产出 `dist/`，插件的 `cordis.patch.yml` 把 `name` 指向 `dist/index.js` 的绝对路径（`file:///` 形式），按标准 npm 包发布。

> mud-core 是统一 host 引擎，mud-webui 是目前唯一壳。一次启动挂 **core + 壳**；终端壳（mud-tui）已在 M0 移除，如需换壳只需换 patch。

## 词汇表(v5)

- **感知（perception）**：`PerceptionDriver` 把 telnet 原始行折叠成感知记录；`TriggerService` 用 `contains`/`regex`/`color`/`guard` 匹配规则，命中发 `mud/percept` 事件（`p:*`）。
- **触发器 LLM（trigger-llm）**：确定性 LLM adapter（假 provider `mud-trigger`）。带 lite 标记的 user/message 借道官方 agent 工具管道执行确定性动作；分流在 `agent/request` 瀑布按 step 粒度完成，无标记消息走真实 LLM。
- **感知 lite 捕获器（LiteCapture）**：订阅 `mud/percept`，对确定性反射动作（如战斗开始立即 `halt`）构造 lite marker → 抢占（`agent.cancel({kind:'user'},{keepInbox:true})`）+ `agent.send` → mud-trigger → 官方 `mud_send` 工具执行。取代旧 dispatcher 的单步 `action:"tool"` 规则。
- **flow**：确定性事务流程（登录/fullme）；仅保留 flow 直调与声明式 llm 决策规则在 dispatcher（战斗反射已迁到 LiteCapture）。
- **工具集（agent 视角）**：`mud_send`/`mud_recall`/`mud_status`/`mud_flow_enable|disable|status`（`mud_map_*` 在 M5）；触发器与 agent 共用同一套工具，无触发器专用工具。

---

## 开发模式

当前各包以 registry 自装依赖、`dist/` 产物通过 harness 的 **`web` profile** 加载（无需新建 profile 目录——harness 对 `web` 有内置模板，自动创建并借 module-fallback 解析 `@deepseek-ai/*` 上游）。

前置：`pnpm`、harness 克隆于 `D:/Code/deepseek-harness`、Node `^22.19 || >=24`。

```bash
pnpm install          # 首次：按 pnpm-workspace.yaml 装全部依赖

pnpm dev:web          # core + webui：构建并启动 harness web profile（浏览器壳）
pnpm restart:web      # 等价 pnpm run dev:web

pnpm build            # 全量构建 packages/* → dist/
pnpm test             # core vitest（131 用例）
```

等价的手工命令（`dev:web`）：

```bash
pnpm --dir D:/Code/deepseek-harness dsh web \
  --patch D:/Code/dsh-mud-agent/packages/mud-core/cordis.patch.yml \
  --patch D:/Code/dsh-mud-agent/packages/mud-webui/cordis.patch.yml
```

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
