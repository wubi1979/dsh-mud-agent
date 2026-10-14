# tool-mud

MUD 组合根 + 工具面 Consumer（T28 拆包，整域迁入）。cordis 插件入口：宿主事件接线、
remote.mud 命名空间、名册 storage 域、凭据解析、投递、会话日志落盘；mud_* 四工具与
mud_workflow_* 注册；mud-player preset 行；typert 工件生成与消费。唯一 bundle 面。

## API（公共面）

- `.`：插件入口（`name`/`inject`/`apply`，宿主经 patch 行 `file://…/lib/index.js` 加载）
- `./typert`：TYPERT 宿主工件（严格 descriptor + zod schema，assemble 注册进 ctx.typert）；
  `gen:typert` 生成（改了 remote.mud 动词面后必跑）
- `./remote`：TYPERT_REMOTE 描述符（webui 侧 ctx.remote.$mount 消费）
- `./types`：Remote 边界类型聚合（转发 mud/types，浏览器安全）

## 装配（唯一 bundle）

- 引擎行：全局加载本包（agent/created 监听、session/disposed 监听、remote 服务、投递、日志）
- 装配注册：mud（引擎）+ mud-workflow（流程）+ nav 三件（NavService/项目内文件持久化 data/nav-graph.json/stamina）
- 工具面：mud_connect/mud_send/mud_walk/mud_state 四工具 + mud_workflow_* 五工具
- 见 cordis.patch.yml（本包唯一归属；行 id 沿用 mud-core3 期命名，宿主 profile 按 id 幂等替换）

## 依赖（D9 矩阵，单向汇聚）

- `mud`：引擎（service/runtime/roster/store/accounts/deliver/llm-gate/log/types）
- `mud-link` / `mud-sense` / `mud-commands` / `mud-combat` / `mud-flows` / `mud-workflow`
- `mud-nav`：**只被本包消费**（tools.ts 工具面 + 装配注册）
- 宿主：cordis / dsh-agent / dsh-llm / dsh-tools / dsh-typert-protocol（peer+dev）

## Known Limitations

- 服务键 `ctx.mudCore3` 沿用（workflow host 与 e2e 消费该键；改名属破坏性 API 变更，
  随宿主换代按 §2.5 整批复核）。
- `dsh plugin add` 流程切换（本包加 dsh.bundle 声明、profile 去 --patch）为待实测项，
  需重启宿主（§6）。
