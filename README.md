# dsh-mud-agent

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 **仓库外 MUD 插件 workspace**（pkuxkx，`mud.pkuxkx.net`），独立构建、独立从 npm registry 安装依赖，不参与 harness 的根 workspace 构建链。

三个兄弟子包：

| 包 | 目录 | 角色 |
| --- | --- | --- |
| `@deepseek-ai/dsh-mud-core` | `packages/mud-core/` | MUD 核心服务（telnet/GMCP 客户端、感知/规则管线、agent 桥），发布为 `ctx.mud` |
| `@deepseek-ai/dsh-mud-tui` | `packages/mud-tui/` | 终端壳（pi-tui 双栏布局），消费 `ctx.mud` |
| `@deepseek-ai/dsh-mud-webui` | `packages/mud-webui/` | WebUI 壳（xterm + 决策日志），消费 `ctx.mud` |

三包独立以 tsc/tsdown 产出 `dist/`，插件的 `cordis.patch.yml` 把 `name` 指向 `dist/index.js` 的绝对路径（`file:///` 形式），按标准 npm 包发布。

> mud-core 是统一 host 引擎，mud-tui / mud-webui 是两种可互换的外壳。一次启动挂 **core + 一个壳**，换壳只需换 patch。

## 词汇表

- **skill**：agent 的决策单元与程序性知识（被动，给 LLM 看）；steps 编排 tool/flow，由 agent loop 逐步执行，无自动执行引擎。
- **flow**：确定性事务（主动，给运行时看）；唯一激活入口 `flow.start`，调用来源 = 系统 watch / 人类 UI / agent（经 skill 绑定）。
- **watch**：flow 声明的常驻探测触发器，运行时代为注册（owner `watch:<id>`），命中 → `flow.start` 可携捕获数据。
- **触发器不变式**：`flow.start` 原子注册全部事务触发器，严格先于任何 `driver.send`（先捕获再执行 / 先执行再捕获都靠它）。
- **步骤粒度**：结果需 agent 判断 → skill step；无需判断连着跑 → 包成 flow（flow 一次调用一个结果）。
- **flow 是执行事实的唯一来源**：skill 描述引用 flow 语义，不复述步骤，防两份菜单漂移。

---

## 开发模式

当前各包以 registry 自装依赖、`dist/` 产物通过 harness 的 **`web` profile** 加载（无需新建 profile 目录——harness 对 `web` 有内置模板，自动创建并借 module-fallback 解析 `@deepseek-ai/*` 上游）。

前置：`pnpm`、harness 克隆于 `D:/Code/deepseek-harness`、Node `^22.19 || >=24`。

```bash
pnpm install          # 首次：按 pnpm-workspace.yaml 装全部依赖

pnpm dev:web          # core + webui：构建并启动 harness web profile（浏览器壳）
pnpm dev:tui          # core + mud-tui：构建并启动 harness web profile（终端壳）
pnpm restart:web      # 等价 pnpm run dev:web
pnpm restart:tui      # 等价 pnpm run dev:tui

pnpm build            # 全量构建 packages/* → dist/
pnpm test             # core + mud-tui 两套 vitest（80 + 7）
```

等价的手工命令（`dev:web`）：

```bash
pnpm --dir D:/Code/deepseek-harness dsh web \
  --patch D:/Code/dsh-mud-agent/packages/mud-core/cordis.patch.yml \
  --patch D:/Code/dsh-mud-agent/packages/mud-webui/cordis.patch.yml
```

`dev:tui` 把第二个 `--patch` 换成 `packages/mud-tui/cordis.patch.yml`。

要点：

- `dsh web` 等价 `dsh --profile web`；harness 内置 `web` 模板，无 profile 时自动创建，无需手动写 `~/.dsh/profiles/web`。
- patch `name` 用 `file:///D:/Code/dsh-mud-agent/packages/<pkg>/dist/index.js` 绝对路径，指向 `dist` 产物。
- harness 的 `web` profile 自带 `@deepseek-ai/dsh-web-app` bundle，开发模式下会一并加载（绑定 Web 端口、打开浏览器 dashboard）。**已知取舍**：终端壳 `dev:tui` 也会带上 web-app，但 TUI 本身照常工作；如需纯净底座，走下文「正式安装 + 启动」。
- 部署值（服务器地址、账号等）写在 `~/.dsh/profiles/web/cordis.patch.yml`，不进本仓库。

---

## 正式安装 + 启动

> **状态占位**：以下流程要在三个 mud 包发布到 npm 之后才能完整执行。
>
> 当前三包均为 `0.1.1-rc.2`，**未发布**；且 `mud-webui` 对 `mud-core` 依赖仍是 `workspace:^` 本地链接——发布顺序须为 **core →（webui / tui）**。到时先 `pnpm publish` core，再发布两个壳。

正式安装走 harness 的 **profile + bundle 装配**（dsh-TUI 的 standalone 模式）：把 mud 包装进一个自定义 profile，用 `dsh --profile` 启动。做法（一次性建立 `mud` profile）：

```bash
# 装核心 + 一个壳（在 harness 目录下执行；以 webui 为例，tui 同理）
pnpm --dir D:/Code/deepseek-harness dsh plugin --profile mud add @deepseek-ai/dsh-mud-core
pnpm --dir D:/Code/deepseek-harness dsh plugin --profile mud add @deepseek-ai/dsh-mud-webui

# 启动
pnpm --dir D:/Code/deepseek-harness dsh --profile mud
```

要点：

- `dsh plugin --profile mud add <pkg>` 创建 `~/.dsh/profiles/mud`，把包写进 `dsh.profile.bundles` 清单，并建立 module-fallback 链接。
- `dsh --profile mud` 按 `bundles` 顺序加载 mud-core 与所选壳的 patch（一个 profile 只挂 **core + 一个壳**）。
- 部署值（服务器、账号）写 `~/.dsh/profiles/mud/cordis.patch.yml`。
- 后续 `pnpm publish` 新版后，在 profile 内 `pnpm update` 即可。

> 发布前的开发期若不绑 web-app，可在 `~/.dsh/profiles/mud/package.json` 的 `dsh.profile.bundles` 只留 `@deepseek-ai/dsh-base`，让 `mud` profile 仅含底座 + 两个 mud 包。
