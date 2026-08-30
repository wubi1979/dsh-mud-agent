# dsh-mud-agent

[deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的 **仓库外 MUD 插件**（pkuxkx，`mud.pkuxkx.net`），独立维护，不参与 harness 的根 workspace 构建链。

三个兄弟子包：

| 包 | 目录 | 角色 |
| --- | --- | --- |
| `@deepseek-ai/dsh-mud-core` | `mud-core/` | MUD 核心服务（telnet/GMCP 客户端、感知/规则管线、agent 桥）、发布为 `ctx.mud` |
| `@deepseek-ai/dsh-mud-tui` | `mud-tui/` | 终端壳（pi-tui 双栏布局），消费 `ctx.mud` |
| `@deepseek-ai/dsh-mud-webui` | `mud-webui/` | WebUI 壳（xterm + 决策日志），消费 `ctx.mud` |

> 本仓库的 tsconfig/package.json 保留了对 harness workspace 的 `workspace:^` / `references` 引用（指向原 `packages/mud/*` 布局的遗留配置）。本仓库**不作为独立可运行/可安装的 workspace**，只作为源码载体。

## 加载方式

本仓库的包通过 harness 的源码执行机制（`node --import tsx/esm` + tsconfig `paths`）**零构建直跑**。在 **harness 主仓库**中（此时 tsx 使用 harness 的 tsconfig `paths` 解析 `@deepseek-ai/dsh-*` 与 `@deepseek-ai/cordis`），把本仓库 patch 的 `name` 指向本仓库 **src 源码的绝对路径**：

```bash
# 在 deepseek-harness 主仓库根目录：
pnpm dsh web --patch <abs>/dsh-mud-agent/mud-core/cordis.patch.yml --patch-extra ...
```

对应的 `cordis.patch.yml` 里 `name` 使用绝对路径指向 src（而不是包名）：

```yaml
- insert:
    - id: mud-core
      name: 'D:/code/dsh-mud-agent/mud-core/src/index.ts'
      config:
        host: mud.pkuxkx.net
        port: 8081
        # ...
```

`dsh-mud-tui` / `dsh-mud-webui` 同理，`name` 分别指向 `mud-tui/src/index.ts` / `mud-webui/src/index.ts`。

如需换 UI 壳，在 profile patch 里追加对应行（MUD core + 任一面壳）。

> **注意（包间互引）**：`mud-tui` / `mud-webui` 内部以包名 `@deepseek-ai/dsh-mud-core`（及 `…/src/client/wire.ts` 深层路径）引用 core，而 harness 的 tsconfig `paths` 没有这些映射。上述绝对路径加载要求这两个互引在 harness 侧能解析（或在 patch 加载前于 harness tsconfig 补 `paths` 映射 `@deepseek-ai/dsh-mud-core -> <abs>/mud-core/src`）。harness 侧其余依赖（`dsh-agent`、`dsh-session`、`dsh-tools`、`dsh-invariants`、`@deepseek-ai/cordis` 等）均由 harness 的 tsconfig `paths` 解析，无需额外处理。

### 构建（如需烧录成 profile 插件产物）

本仓库三个包仍是 harness `packages/mud/*` 的 bundle 形态（`dsh.bundle.patch` / `dsh.client`）。若要从本仓库产出可 `dsh plugin add` 的装配插件，需在其父 workspace（含 harness 全部 `@deepseek-ai/dsh-*` 源）内构建；本仓库单独无法 `pnpm install` 通过（`workspace:^` 依赖无来源）。

## 开发

```bash
# 仅跑泥包自身的 vitest（需在含 harness 源的 workspace 内执行）
pnpm --dir <harness> exec vitest run packages/mud/mud-core/tests
```
