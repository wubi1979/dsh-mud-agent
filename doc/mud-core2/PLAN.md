# mud-core2 计划起草区

> **文件角色**：mud-core2 的新计划在此起草；不作为长期事实来源。计划落地后同步到 `doc/architecture/` 对应章节文件并登记 `CHANGELOG`（基线完成前不登记），随后删除本文件中对应内容。
>
> 编号约定：本文件自身小节写 `1.1` / `第 3 章`；引用现行设计一律写 `§N`（§号属于 `doc/ARCHITECTURE.md` 章节地图）。交付切片暂用 `P*` 编号。

***

## V4：MUD 专用 agent —— 用户 / 连接 / 会话一一对应（多用户并发）

> **状态：草案修订（2026-09-28）——决策已全部裁定（第 2 章）。本次修订：切片重排（roster/管理面前置，实施策略见第 5 章）、评审修正（roles 单源 D5、corpusPath→corpusRoot、归属解析读宿主 header）、证据补强（1.2-15/16/17）。待核实清单见第 6 章**。
> 本版**整份替换**此前已废弃的计划文本（旧「P2 修订 v2」与「P3」）。v2 已落地代码的处置见 1.3；旧文本中的事实若有价值已在 1.2 重录并带证据。

### 第 1 章 业务需求与范围

#### 1.1 需求（用户口径）

1. 插件实现的是 **MUD 专用 agent**，不再保留原有义务——**所有工具插件均为该用户的 MUD 游戏服务**，不是通用编码 agent；
2. **用户在 Web 中创建**；**用户 — 连接 — 会话一一对应**；
3. **工作区对应服务器地址**；
4. 用户分**前台运行 / 后台运行**；**只要连接未断开、持续产生信息，agent 就必须为之提供决策**；
5. **上浮允许**：后台也可上浮；无人应答就**超时失败**；或者**在 Web 界面提示"某用户（会话）有待答问题"**；
6. **只有一个 preset**（角色），但**预留后期增加 preset 的位置**。

#### 1.2 已核实事实（全部带证据）

**宿主模型**

1. 会话↔agent 严格 1:1（`core/agent/src/index.ts:462,467`）；根会话可枚举（`agents.roots()`，`:596`）；**冷会话是文档化常态、按需恢复**（`docs/api-gateway.md:129`、`docs/subsystems/skills.md:237`）；
2. **多会话并发跑回合 = 会话内串行、会话间并行**：prompt 路径 `session/prompt → resolveAgent（live 复用 / 冷则 resume，并发去重）→ followup(queue) / steer(步边界插话) → 该 agent 自己的 inbox`（`api/session-controller/src/commands.ts:311-365`、`.../client/contract/session.ts:82`）；`ReactLoopInbox` 是 **per-Agent 实例**（`core/agent-loop/src/agent.ts:36,159,200,262,271`；`docs/architecture.md:111` "One inbox feeds the driver"）；无全局串行点（`docs/subsystems/sandbox.md:79` 明写 permits concurrent sessions）；
3. **无客户端在场机制**：Host 会话 RPC 只有 `list/search/create/selectModel/openWorkspacePath/rename/fork/prompt/attachment/updateQueue/cancel/page/projections`，**无 watch/retain/presence**（`api/session-controller/src/index.ts:251-490`）；客户端的 retain/release 是浏览器侧引用计数；`session-activity`/`updatedAt` 是**活动度**不是在场度；
4. 建会话可指定 `sessionId`（`api/session-controller/src/commands.ts:109`）；无"客户端断开即回收 agent"的策略；
5. **有宿主 storage 域可挂载**：`ctx.storage` 是 hub，数据形态由属主 `mount(form, facility)` 挂载、以 `ctx.storage.<form>` 取用，后端可换（JSON/SQLite）（`packages/storage/storage/src/index.ts:41-79`）；
6. **有官方凭据存储**：页面 `remote.credentials.{describe,set,unset}`（`api/settings-controller/src/credentials.ts:60-105`），插件侧 `ctx.get('credentials').resolve(ref)` 实时解析（v1 先例 `mud-core/src/session/credential-source.ts:45-92`）。

**工作区与会话身份**

7. `Workspace` 实体**只有 `{ id, path, title }` + `sessionIds`**，无自定义字段（`workspace/workspace/src/types.ts:63-111`）；`attachSession` 校验该会话 cwd 解析到本工作区 path（`entity.ts:109-176`）；`session.header.cwd` 是持久身份字段，建会话时 `mkdir(cwd, {recursive:true})`（`api/session-controller/src/agent.ts:480-494`）；cwd 用于文件/终端/搜索工具与技能发现（`tool-fs/src/session-cwd.ts:18`、`tool-bash/src/index.ts:153`）。

**preset（角色）语义**

8. **preset = 共享的环境声明，没有"每用户环境"**：registry 对每个定义只挂一棵树（`preset/agent-preset-registry/src/mount.ts:26-29` "One live revision shared by Agents and scoped readers"；`activate()` 建一次 scope+tree `index.ts:102-118`；`bind()` 只把各 agent 作用域挂到同一 key `:226-250`），宿主测试断言 "shares one revision across Agents"（`registry.spec.ts:17-33`）；
9. **中途不可切换**：产品路径 `select()` 对已开过回合的会话抛 `agent-preset/locked`（`index.ts:317-333`，locked 判定 `:320-323`）；低层 `recompose()` 不检查空白，注释明写 "the caller owns the blank-session check"（`:300-310`，不用）；
10. **角色跨冷启持久**：恢复时按会话**记录**的 preset 重建并拒绝不一致请求（`api/session-controller/src/agent.ts:431,466-468,518-525`）；
11. **子级继承父级角色**：`composeFrom(childCtx, parent.ctx)`（`preset/agent-preset-registry/src/index.ts:273`、`subagent/subagent/src/child-agent.ts:205`）；
12. **工具与 persona 的官方承载 = preset 的 `config.plugins` 行**；工具定义全员共享，**落点必须调用期解析**（`ToolExecutionInput.agent`，`core/tools/src/index.ts:339`）。

**上浮（ask_user_question）**

13. `ctx.userQuestions.ask` 走 `user-questions/request` waterfall，无人认领即 fail closed（`interaction/user-questions/src/index.ts:130-141`）；该事件经 `API_REMOTE_FORWARDED_EVENTS` **扇出给已连接客户端、只取第一个结果**，首次连接前的 pending 会等第一个连上的客户端（`api/remotes/src/remote-events.ts:47`、`api/gateway/tests/gateway-stream.host.spec.ts:1199,1247,1308`）；客户端应答者**按连接注册一次**、以 `ctx.sessions.scopeOf(owner)` 判会话、取不到即 `next()` 委派（`client/ui-user-questions/src/client/index.ts:51-79,105`）；客户端按会话各留一条、同会话多条按 precedence 取一（`client/ui-session/src/client/index.ts:461-481`）；
14. **宿主不给 `ask_user_question` 超时**：其定义未声明 `timeoutMs`（`interaction/tool-ask-user/src/index.ts:19-99`），而超时策略只在声明了预算时才武装（`timeoutMs === undefined → return next()`，`guard/timeout-policy/src/index.ts:57-59`）⇒ 无人应答**永久挂起**；只有 `exec.signal` 被中止才以 `ASK_ABORTED` 失败（`interaction/user-questions/src/index.ts:41-47,87-89`）；官方扩展点是 `tools/execute` waterfall（`timeout-policy` 本身就是这样一个包装，`:56-80`）；
15. **session header 原生携带谱系字段**：`delegationDepth`/`parentSession`/`origin` 随 meta 持久进 header（`core/session/tests/session.spec.ts:1450`、`core/agent-loop/tests/resume.spec.ts:920`）——深度与父链是宿主事实，插件不必自算；
16. **ask 的 caller 门槛 = exact live root，而非谱系**：供 agent 时校验 `CALLER_NOT_LIVE`/`DELEGATED_CALLER`（`interaction/user-questions/src/index.ts:94-106`）；注释明写 "a lineage-bearing session resumed as a new runtime root may ask normally"（`:74-77`）——**冷会话恢复成新运行时根后，上浮能力不受损**；
17. **waterfall 结算即广播 cancel**：pending 结算（含 reject）时宿主向所有已投递客户端推 `{type:'cancel', eventId}`（`api/gateway/src/index.ts:616,638-655`）——ask 被中止/应答后，客户端侧 pending 提示随之消失。

#### 1.3 v2 已落地部分的处置

| 类别 | 内容 |
|---|---|
| **保留** | `link/`（1424 行：mud/telnet/ansi/corpus）、`awareness/`（362）、`wake/`（171）及其全部回放/竞态用例；preset 通道机制（`@deepseek-ai/dsh-agent-preset` 行）；**调用期由 `exec.agent` 解析**的形态；per-instance 纪律（N 会话天然成立）；preset 行插件 `src/preset.ts` 的骨架 |
| **作废** | standard 逐条副本与漂移守卫；单根守卫 `rootAgentId`/`rootSessions`/`belongs` 复合判定；`MudCoreHandle` 单份引擎窄面；config 静态 `connect`/`creds`；"按深度判归属"（改为按会话） |
| **重写** | `src/index.ts` 装配、`src/config.ts`、`src/tools/tools.ts` 契约外壳、`src/preset.ts` 解析入口 |

#### 1.4 非目标

不做通用编码能力面（fs/shell/web/todo/plan-mode 等一律不进 preset）；不做账号自动注册（newid）；**不做跨用户共享**（连接、世界状态、凭据、语料一律按会话隔离）；不保留 v1 `mud-core` 的任何义务（已裁决退役）；本轮不做多角色（仅预留位置）。

### 第 2 章 核心决策

| # | 决策 | 理由 / 证据 |
|---|---|---|
| **D1** | **一用户 = 一 DSH 会话 = 一 MUD 连接**；连接归会话独占 | 需求 2；1.2-1 |
| **D2** | **工作区 = 服务器（1:1）**：`workspace.path` 为一台服务器的目录，host:port 存我们的 roster（键 = workspace id/path）；同服务器下 N 个用户各一个会话、cwd 相同 | 需求 3 + 裁决 A；1.2-7 |
| **D3** | **每会话运行时注册表** `Map<sessionId, SessionRuntime>` 取代 `apply` 级单例 | 数据只供唯一会话、零共享 |
| **D4** | **工具按调用期解析会话**：`MudToolDeps.runtimeFor(agent)`；工具定义由 preset 行注册一次（定义共享、数据不共享） | 1.2-12 |
| **D5** | **角色 = preset**：当前只声明一个（`mud-player`），**预留增加位**——归属门唯一读 **Config `roles`**（唯一事实源，缺省 `['mud-player']`；不另设代码常量），加角色 = patch 加一条 preset 行 + config 加一项 + 建用户时可选，**引擎不按角色分支**；建会话时**显式传 `agentPreset`**，**不覆盖** registry 的 `default`（保持 standard） | 需求 6；1.2-8/9/10；避免"全局默认"成为角色选择的杠杆 |
| **D6** | **能力面 = 最小行集**（3.4），**不复制 `standard`**；漂移守卫删除 → 改为行集白名单自检 | 需求 1；1.2-8 |
| **D7** | **上浮允许（前后台都给）+ 自持截止**：preset 始终注册 `tool-ask-user`；我们以 `tools/execute` waterfall 给本插件会话的 `ask_user_question` 装 `askTimeoutMs`，到期中止 → 模型收到可读超时 → 自行降级继续 | 需求 5 + 裁决"超时失败即可"；1.2-14 |
| **D8** | **前台/后台 = 观测面**：由页面在场状态（open/close/心跳）维护，用于"待答提示"与运维视图，**不影响能力面与决策链** | 需求 4/5；1.2-3 |
| **D9** | **凭据走宿主 credentials**：每用户一个 `CredentialRef`；页面写入，引擎**每次连接实时 resolve**，不缓存、不落 corpus、不进上下文 | 1.2-6；§13 |
| **D10** | **roster 存宿主 storage 域**（服务器 / 账号 / 角色 / 绑定 sessionId），不进代码常量、不进页面 localStorage | 裁决；1.2-5 |
| **D11** | **管理面原地重写 `packages/mud-webui`**：复用其包注册与构建链，客户端整体重写 | 裁决 |
| **D12** | **连接生命周期随会话**：会话 disposed → 断连并拆 runtime；连接断开不销毁 runtime，**重连由 runtime 自持**；会话冷掉时由行流触发恢复（路径见待核实 ⑨） | 需求 4；1.2-4 |
| **D13** | **预算与账目按用户**：`BudgetRegistry`/`Meter` 按会话；Config 增 `maxSessions`（并发上限，I10 护栏），超限以可读 RemoteError 拒绝 connect/bind（3.8） | I1/I10 |
| **D14** | v1 `mud-core` 退役、`dev:web` 下线；mud-core2 为唯一生产路径 | 既有裁决 |

### 第 3 章 机制与契约

#### 3.1 映射与建用户

```
workspace(path,title)  ←→  服务器（host, port）        # roster: server → workspace
user（Web 创建）        ←→  sessionId（显式指定）        # 一一对应
                       ←→  一条 Mud 连接（会话独占）
session.header.cwd     =   workspace.path
```
建用户流程：页面建服务器（选/建工作区，填 host/port）→ 建账号（name + 密码，写 credentials）→ 建会话 `session/create { sessionId, cwd: workspace.path, agentPreset: 'mud-player' }` → 绑定 → `connect` → runtime 起连接。

#### 3.2 会话运行时（新增 `src/session/runtime.ts` + `registry.ts`）

```ts
interface SessionRuntime {
  readonly sessionId: string
  readonly mud: Mud; readonly world: World; readonly corpus: CorpusWriter
  readonly gate: LoginGate            // 凭据每次连接时 resolve（D9）
  wake: Wake | null                   // 仅根 agent 实例换绑（resume/compact）
  readonly budget: BudgetRegistry     // 本会话子级预算（D13）
  readonly meter: Meter               // 本会话计数护栏（现未接线，随本版接上）
}
registry: Map<SessionId, SessionRuntime>      // 工具 / 唤醒 / 断连的唯一查找面
runtimeFor(agent): SessionRuntime | null      // 解析不到 ⇒ 工具可读拒绝
```
归属解析：深度直读 header 宿主原生 `delegationDepth`（1.2-15），不自算；根 id = 根取 `agent.id`，子级沿 `header.parentSession` 一跳上溯（子级恒为根直系）+ 登记表双源；任一不可解析 ⇒ `runtimeFor` 返回 null（工具可读拒绝）。

#### 3.3 工具契约（`src/tools/tools.ts`）

```ts
interface MudToolDeps { runtimeFor(agent: ToolAgent | undefined): SessionRuntime | null }
```
每次 `execute` 先 `const rt = deps.runtimeFor(exec.agent)`；`null` ⇒ 可读拒绝（"未绑定连接/非本插件会话"）。holder = `depthByHeader > 0 ? 'child:<id>' : 'root'`（**会话内**语义）；禁发表、`LoginGate`、`mud.read` 全部取 `rt`。

#### 3.4 角色（preset）与最小行集

**首版 4 行**：`delegation` 组（`tool-subagent` + `tool-subagent-control`）｜`compaction` 组｜`tool-ask-user`｜**本包 `mud-core2-preset` 行**。
**不含**：fs / shell / web / todo / goal / plan-mode / present / plugin-manager / `dsh-persona`。
**预留增加位**：归属门唯一读 **Config `roles`**（缺省 `['mud-player']`，D5 单源）；新增角色 = ①patch 增一条 `preset-<role>` 行；②config `roles` 加一项；③建用户时传该 role。**引擎、runtime、工具面零改动**。
**后加不预留**：`skill-filesystem` + `tool-skill`、`dsh-persona`。

#### 3.5 上浮与超时降级（D7）

```
我们自持 ask 截止（官方 tools/execute waterfall 扩展点，宿主 timeout-policy 同款）：
  const timer = setTimeout(() => { fired = true; ctrl.abort() }, cfg.askTimeoutMs)
  exec.signal = AbortSignal.any([upstream, ctrl.signal])      // 仅 mud 会话的 ask_user_question
  await next()
  fired ? 可读超时结果 : 原结果
```
- 无人应答 ⇒ 到期 → `ASK_ABORTED` → 模型看到可读超时 → 自行降级（fullme 记一条并跳过，继续当前计划）；
- **无顺序竞争**：宿主 `timeout-policy` 对未声明 `timeoutMs` 的工具直接 `next()`（`guard/timeout-policy/src/index.ts:57-59`）——`ask_user_question` 无超时声明 ⇒ 宿主不换装 signal，我们的包装是唯一换装者（待核实 ① 就此基本判定；照抄其 scoped-code 手法区分自家 timer，`:18-25`）；
- answerer 侧 pending 由宿主按 `eventId` 取消（`api/gateway/src/stream-protocol.ts:51-60`），waterfall 结算即广播 cancel 已实证（1.2-17），页面提示随之消失；
- **盲区**：无客户端连接时 pending 无人认领、页面不可见（1.2-13）——此时自持截止是唯一保证，"待答提示"是辅助面不是可靠面；
- **页面提示**（D8）：管理面在会话上标出"有待答问题"（客户端已有按会话 pending 投影，1.2-13）；点击即打开该会话作答；
- 子级的 ask 由宿主 `DELEGATED_CALLER` 拒绝（`interaction/user-questions/src/index.ts:101-106`），与本机制无冲突。

#### 3.6 生命周期

建会话 → `agent/created`（归属门 `composedPreset ∈ config.roles`，D5）→ 取/建 runtime（幂等；`remote.mud.connect`（页面触发，V4.2 接线）同样先取/建再建连）→ 行流驱动 Wake；连接断 → runtime 保留并自持重连（退避参数 `reconnect`，3.10）；会话 disposed → 拆 runtime + 断连；插件卸载 → 全拆。**冷会话**（agent 被释放但会话仍在）由行流触发恢复后再唤醒（待核实 ⑨；resume 成新根后上浮不受损，1.2-16）。

#### 3.7 凭据（D9）

页面 `credentials.set(passRef, 明文)`；`connect` RPC 传 `{ sessionId, host, port, name, passRef }`；引擎建连时 `ctx.get('credentials').resolve(passRef)`，明文只进连接的登录流程（`sendCredential` 直发纪律），不落 corpus、不进上下文。resolve 失败 = 连接失败，指名引用名报错。

#### 3.8 roster 存储域（D10）

新增 storage 域（`ctx.storage.mount(form, facility)`）：

```
servers: { workspaceId, path, title, host, port }
users:   { userId, serverId, name, passRef, sessionId, role }
```
读写动词经我们的 remote 面暴露给管理面；`sessionId` 与 role 落库后不因页面状态丢失。超限（D13 `maxSessions`）与非法绑定（sessionId 未登记/已被占用）以可读 RemoteError 拒绝。

#### 3.9 管理面（D11：原地重写 `packages/mud-webui`）

服务器 CRUD（host/port ↔ 工作区）、账号 CRUD（name + 密码 → `credentials.set`，页面不留明文）、绑定/连接/断开、**前台状态上报**（打开/关闭/心跳）、**"有待答问题"会话提示**。

#### 3.10 Config 形态

删 `connect`/`creds`（→ roster + credentials，V4.2 起）；`corpusPath` **改名** `corpusRoot`（语义变化：根目录，按会话派生子文件，见 ⑩）；保留 `silenceMs`/`defaultTimeoutMs`/`budgetMs`；新增 `askTimeoutMs`、`roles`（缺省 `['mud-player']`，唯一事实源，D5）、`maxSessions`（D13）、`reconnect`（自持重连参数：间隔/退避/上限）。

### 第 4 章 源码变更清单

| 文件 | 变更 |
|---|---|
| `src/session/runtime.ts`、`src/session/registry.ts` | **新增**：单会话运行时 + 注册表 + 归属解析（深度读 header `delegationDepth`，3.2） |
| `src/storage/roster.ts` | **新增**：storage 域（servers/users） |
| `src/ask-deadline.ts` | **新增**：`tools/execute` 包装（D7） |
| `src/remote.ts` | **新增**：`remote.mud.*` 动词（V4.1：servers/users CRUD + bind；V4.2：connect/disconnect/status；V4.6：presence） |
| `src/index.ts` | **重写**：删单例与单根守卫；`agent/created` = 归属门 → 取/建 runtime → 根挂 Wake、子级登记预算；`session/disposed` 拆 runtime + 断连；`ctx.provide('mudCore2', { runtimeFor })` |
| `src/tools/tools.ts` | 契约：`MudCoreHandle` 单份 → 按会话 `SessionRuntime`；`MudToolDeps.core` → `runtimeFor`；`resolveHolder` 删除 |
| `src/preset.ts` | `core: () => ctx.get('mudCore2')` → `runtimeFor: agent => …` |
| `src/config.ts` | 按 3.10 一次到位改版（V4.2） |
| `src/subagent/subagent.ts` | 预算随父会话 runtime；复核不依赖全局单根 |
| `src/observe/meter.ts` | 每会话实例 + 接线（现未接线） |
| `src/link/corpus.ts` | 仅装配侧路径按会话派生（类不动） |
| `src/persona.ts` | 增补自主纪律（降级继续、超时即放弃该流程） |
| `cordis.patch.yml` | V4.2：引擎行 config 一次到位（删 `connect/creds`、`corpusPath`→`corpusRoot`、增 `askTimeoutMs`/`roles`/`maxSessions`/`reconnect`）；V4.4：preset 行 `plugins` 换 3.4 行集；**不覆盖** registry `default` |
| `packages/mud-webui` | **原地重写**客户端（3.9；V4.1 最小建管面，V4.6 观测面） |
| `test/*` | roster/storage + remote 契约用例（V4.1）；`index.spec.ts` 重写（注册表/归属/生命周期）+「两会话隔离」（各一条连接、互不串线、`runtimeFor` 不交叉）+ `preset.spec.ts` 改契约（V4.2）；ask 截止用例（V4.3，fake timers 断言"不装截止则挂起"）；`patch.spec.ts` → 行集白名单自检（V4.4） |

### 第 5 章 实施切片与验收

**实施策略（2026-09-28 裁定）**：基线未完成即发现单会话假设的重大设计失误，本版即修正案。**先修正、后找 bug**——先打通「Web 建服务器 → 建用户（preset + 绑定 session）→ session 运行时启动」主链（V4.1–V4.2），再逐个接入验证组件（V4.3，问题随接入暴露随修），行集收口（V4.4）后做全量回归与 bug 清理。旧「V4.1 暂用配置临时服务器/凭据」的过渡件因重排而不再需要。

| 切片 | 内容 | 验收 |
|---|---|---|
| **V4.1** | roster storage 域 + `remote.mud.*`（servers/users CRUD、bind）+ 管理面最小客户端：建服务器（选/建工作区 + host/port）、建用户（name + 密码 → `credentials.set`；建会话显式 `agentPreset:'mud-player'` 并绑定 roster） | 服务器/账号落库；`credentials.set/resolve` 全链路、明文不落 config/corpus/上下文；会话以显式 preset 建成、`users.sessionId` 落库 |
| **V4.2** | **session 运行时启动（修正核心）**：`src/session/runtime.ts`+`registry.ts`；`index.ts` 重写（归属门 → 取/建 runtime；disposed 拆；provide `runtimeFor`）；`tools.ts` 契约改 `runtimeFor`；config/patch 引擎行一次到位（3.10）；connect/disconnect 接线 runtime（roster 取参 + `credentials.resolve`，3.7）；归属解析读宿主 header（3.2） | `tsc` + 全量用例绿；两会话并行 connect 各持一条连接、互不串线（「两会话隔离」先红后绿）；会话 disposed 断连拆 runtime；超限/非法绑定可读拒绝 |
| **V4.3** | **接入组件逐个验证**：禁发表按会话内 holder；wake per-runtime 换绑（resume/compact）；ask 截止（D7）+ 超时降级 persona 纪律；corpus 按会话派生；meter 接线 | 后台会话持续产出决策；无人应答 ask 在 `askTimeoutMs` 后可读失败、模型降级继续（先红后绿：不装截止则挂起，fake timers）；语料/日志按会话不串线 |
| **V4.4** | preset 最小行集（3.4）+ `patch.spec.ts` 漂移守卫 → 行集白名单自检 | dump-config 断言行集 = 白名单且无 `entry not found` |
| **V4.5** | 生命周期补全：断线自持重连（`reconnect` 参数）、冷会话行流唤醒（⑨ 定案）、插件卸载全拆 | 断线自动重连；冷会话可被行流唤醒且上浮不受损（1.2-16）；卸载无残留 |
| **V4.6** | 前台/后台观测（⑧）+ 待答提示（D8）+ 每用户账目 | 管理面显示前台状态与"有待答问题"（无客户端时不可见属预期、自持截止兜底）；每用户 `step/start`/调用数可读 |

### 第 6 章 待核实 / 完成定义

**待核实**（实施第一步；①–④ 决定 3.5 与 3.9 的实现形状，建议先跑）

- [ ] ① ~~我们的 `tools/execute` 包装与宿主 `timeout-policy` 的先后关系~~ **已基本判定**：宿主对未声明 `timeoutMs` 的工具（含 ask）直接 `next()` 不换装（`guard/timeout-policy/src/index.ts:57-59`）⇒ 我们的包装是 ask 唯一换装者；照抄其 scoped-code 手法（`:18-25`），实施时实测一次互不吞掉即可；
- [ ] ② `askTimeoutMs` 取值与超时后模型看到的结果文案；
- [ ] ③ 客户端 `sessions.scopeOf(owner)` 的物化条件（列表即物化 vs 打开才物化）——决定哪个连接会认领、页面提示的可见范围；
- [ ] ④ 客户端会话级 pending 投影能否直接用于管理面的"待答提示"（`ui-session` 的 `pendingSnapshot` / `useSessionStatus`）；
- [ ] ⑤ `ctx.storage` 域 API 与后端行 id（`storage-json` 的落盘位置与命名）；域内 schema 版本化策略；
- [ ] ⑥ `ctx.get('credentials')` 现行服务名与 `resolve` 签名（v1 先例是旧宿主版本）；`remote.credentials.set` 的引用名约束；
- [ ] ⑦ 客户端插件发现与 remote 注册通路（`exports["./client"]` + `ctx.remote.$mount`、typer codec 工厂格式）在现行版本的实测；
- [ ] ⑧ 前台/后台状态上报的动词设计（谁上报、粗粒度到会话还是工作区）；
- [ ] ⑨ 冷会话唤醒路径：`ctx.agents.resume`（自带 preset setup）vs `schedule`；
- [ ] ⑩ 多连接下 corpus/log 布局与 `link/mud.ts` 的单例假设逐处核对；
- [ ] ⑪ 角色判据是否只有 `composedPreset` 一条路（加角色时是否有更稳的官方判据）——补充：`select()` 将 preset id 以 `agent-preset/selected` 追加进会话记录（`agent-preset-registry/src/index.ts:325`），判定可双源（会话记录 + composedPreset）。

**完成定义**：N 用户各自独立连接与状态、零共享；上浮可用且无人应答能超时降级；管理面能建服务器/账号并连接；`tsc` + 全量用例绿；设计章节（§1 I3 措辞、§2 术语、§3.3 文件映射、§11、§12、§13 凭据、§15–§17 账目、§19 连接生命周期）同步 + `CHANGELOG` 一行（基线完成后）；本文件内容删除。
