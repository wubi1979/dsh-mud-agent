---
sections: [15]
status: active
deps: ["§2", "§8", "§9"]
note: 横切面（索引章）：对外契约 + Config 总表；权威条款在各层章，本章只做汇总与查表
---

# §15 契约与配置汇总

> 本章是**索引章**：只列名字、形状与指针，**条款权威在各层章**（同一事实只写一处，§0.2 规则 4）。

## 15.1 `remote.mud.*` 动词表

服务键：`mudRemote`（命名空间 `mud`）；实现 `MudRemoteService`（构造即 `ctx.provide`）。Remote 边界类型从**非根子路径** `mud-core3/types` 导出（typert 要求）。

| 动词 | 入参 | 返回 | 权威章节 |
|---|---|---|---|
| `servers()` | — | `{ servers: ServerRecord[] }` | §11.1 |
| `addServer(record)` | `ServerRecord \| undefined` | `{ server }` | §11.1 |
| `removeServer(workspaceId)` | id | `{ workspaceId, removed }`（仍有账号时**拒绝**） | §11.1 |
| `accounts()` | — | `{ accounts: AccountRecord[] }`（`passRef` 是引用名） | §11.2 |
| `addAccount(input)` | `{ serverId, name, passRef, preset, cwd }` | `{ account }`（**一个动作**：写名册 → 建会话 → 投任务书） | §11.2 |
| `removeAccount(sessionId)` | id | `{ sessionId, removed }`（清名册 + 清该账号日志；**不销毁会话**，§2.4） | §11.2 |
| `connect(sessionId)` | id | `{ sessionId, state }`（**只建连**，不登录） | §3.2 |
| `disconnect(sessionId)` | id | `{ sessionId, state }`（硬收尾） | §3.2 |
| `admit(sessionId)` | id | `{ sessionId, admitted }`（开闸门 + 投状态任务书） | §6.3、§7.4 |
| `stop(sessionId)` | id | `{ sessionId, admitted }`（投递停，行流照常录制） | §6.3 |
| `status(sessionId?)` | id 可选 | `{ state, admitted, sessions[] }` | §13.2 |
| `logs(sessionId)` | id | `{ sessionId, entries, fileTarget }` | §13.1、§13.2 |
| `follow(sessionId)` | `@Remote({mode:'stream'})` | `AsyncIterable<GameFrame>`（snapshot / output / state） | §5.3、§9.4 |
| `watchStatus()` | `@Remote({mode:'stream'})` | 流动词：首帧全量 + 变化推帧 | §9.5、§13.2 |
| `watchCaptcha()` | `@Remote({mode:'stream'})` | 流动词：首帧补推挂起态 + 变化推全量快照帧（行摘除 = 清除帧） | §8.17、§9.7 |
| `captchaAnswer(sessionId, value)` | id + 码值（trim） | `{ sessionId }`（resolve 挂起；`fullme {captcha}` 由流程动作统一发送） | §8.17 |
| `captchaAbort(sessionId)` | id | `{ sessionId }`（专用 `aborted` 出口收束） | §8.17 |
| `captchaRefresh(sessionId)` | id | `{ sessionId, image }`（重抓同 URL；每轮挂起限 1 次，超配额可读拒） | §8.17、§9.7 |

**错误面统一**：未登记会话抛 `session/not-found` 语义错误，文案统一为「会话未登记，可能宿主重启过或页面残留旧会话——请刷新页面后重连或重建账号」（§9.2）；`undefined`/空 id 由 `requireId` fail-loud。

## 15.2 `ctx.provide('mudCore3')` 服务窄面

工具面与流程面**执行期**解析的唯一引擎面（注册期不依赖，§8.1）。

```ts
interface MudCore3Service extends MudCore3Handle {
  runtimeFor(agent): SessionRuntime | null          // 归属解析；不属于本插件 ⇒ null
  toolContextFor(agent): { sessionId, runtime, admitted, connState } | null
  connect(sessionId): Promise<{ state }>            // mud_connect 的落点（幂等）
  workflowIoFor(sessionId, holder): WorkflowIO        // §8.14 缝合点（io 原语 awaitCaptcha(url)——T14 URL 参数化，§8.17）
  stateOf(sessionId): { connState, loggedIn, admitted, world, recording, dropped }
  defaults: { sendTimeoutMs, sendMaxLines }         // 工具缺省参数
  builtinFlows: readonly WorkflowRecord[]           // 流程实体（login 等），交 mud-workflow 注册表
}
```

- **归属解析同一路径**：`runtimeFor` 与 `toolContextFor` 都走 roster + 父链上溯（§8.5）。
- **窄结构代位**：`ctx.get('agents')` 的品牌化 `SessionId` 类型定义在宿主 `@deepseek-ai/dsh-session` 内，pnpm 严格链接下不可直连 import ⇒ 用**最小结构断言**读 `agents.get(id)?.session?.header?.parentSession`（§2.1 事实 9）。
- **取用走 `ctx.get`（不写进 `inject`）**：`agents` 是**可选依赖**——缺席/提供方 fiber 未 ACTIVE ⇒ `undefined` ⇒ 上溯终止（§2.3）；且必须在**调用期**解析（apply 期未必就绪，与 `storageDomain` 同一课，§14.3）。写成 `ctx.agents` 会因未声明 inject 直接抛错并使 `apply` 整体失败 ⇒ `remote.mud` 全动词 404。
- `MudService`（内部服务面）：`register` / `connect` / `disconnect` / `admit` / `stop` / `status` / `statuses` / `subscribeStatus` / `watchStatusStream` / `subscribeCaptcha` / `watchCaptchaStream` / `captchaAnswer` / `captchaAbort` / `captchaRefresh` / `get` / `getDeliverer` / `screenOf` / `logOf` / `flushPending` / `turnStart` / `turnEnd` / `dispose` / `disposeAll`（§11.4、§11.7、§8.17）。

## 15.3 preset 行清单

`packages/mud-core3/cordis.patch.yml` 定义 `mud-player` preset：

| 行 | 作用 |
|---|---|
| 宿主 `standard` 插件面 | 基础能力（**不覆盖** registry 的 `default`；建账号时显式选 preset） |
| **引擎行** | `mud-core3`（`lib/index.js`）：名册 / 连接 / 投递 / 服务面 / 流程实体 |
| **preset 行**（`src/preset.ts` → `lib/preset.js`） | 工具注册（preset 作用域，执行期解析引擎窄面，§8.1–§8.2） |
| **`mud-workflow` 行** | 流程注册表 + 五工具（§8.14） |
| persona | 玩家身份 + 工具说明 + **分工协议五条**（§7.1、§7.6） |

- **声明合并自扩**：`MessageSourceMap` 增加 `'mud'`（行批次）与 `'mud-wake'`（任务书/唤醒）两种 kind（§6.2、§7.4）。
- 加载形态：patch 的 `name` 指向构建产物；`headless` 屏 cols 等视图参数成组（§15.5）。
- **启动链**（根 `package.json`）：`gen:typert` → build `mud-core3` → build `mud-webui` → `dsh web --patch <patch>`（§2.2）。

## 15.4 流程词汇表与保存门（索引）

| 项 | 权威章节 |
|---|---|
| 读窗 / 动作 / 路由词汇表 | §8.10 |
| 保存门三门（zod + `checkFlow` + 凭据红线） | §8.11 |
| 凭据红线双闸（静态 + 执行） | §8.12 |
| 解释器语义（步序、出口、步上限、pass 掩码） | §8.13 |
| 五工具与 `workflowIoFor` 执行序 | §8.14 |
| `login` 实体步表与两条实测勘误 | §8.15 + [flows/login.md](../flows/login.md) |
| `fullme` 实体步表与人工验证码链路（`captcha` 动作 / `awaitCaptcha` / 双预算） | §8.17 + [flows/fullme.md](../flows/fullme.md) |
| 目标形态（`goto` / `exit`，`'success'` 强制 `ok: true`） | §8.10 |

## 15.5 Config 总表

### `MudCore3Config`（引擎行）

| # | 项 | 缺省 | 语义 | 章节 |
|---|---|---|---|---|
| 1 | `resolveCreds` | 缺省接宿主 `credentials` | 凭据解析器覆盖（**只给测试/特殊部署**） | §11.6 |
| 2 | `deliverQuietMs` | 500 | 投递静默窗口 | §5.4 |
| 3 | `deliverMaxWaitMs` | 3000 | 批次最长等待（防刷屏流永不投递） | §5.4 |
| 4 | `deliverMaxLines` | 50 | 单条投递最大行数（超出拆批） | §5.4 |
| 5 | `deliverMaxChars` | 8000 | 单条投递最大字符数（超出拆批） | §5.4 |
| 6 | `recordLines` | 2000 | 每会话环形录制上限（未接入期间保留的最近行数） | §4.2 |
| 7 | `viewScrollback` | 2000 | 画面通道 snapshot 回放深度（对齐录制缓冲） | §5.3 |
| 8 | `viewCols` | **120** | 画面通道列数（固定，不做 resize 回传） | §5.3 |
| 9 | `viewMaxBufferedBytes` | 2MB | 单 follower 缓冲上限（超限显式断流） | §5.3 |
| 10 | `viewSubCap` | 1000 | 副屏行环上限（按有标行条数计，超限丢最旧） | §9.4 |
| 11 | `classifyRules` | 内置（语料校准） | 行分类规则清单（声明序取首个命中；正则字符串，非法正则启动即拒装） | §6.3、§17.4 |
| 12 | `deliverAllowKinds` | —（有标行一律不投） | 投递白名单：列出放行的 kind（如 `['chat']`） | §6.3 |
| 13 | `logFile` | `true` | 是否落盘 JSONL | §13.1 |
| 14 | `logDir` | `<cwd>/mud-logs` | 日志落盘目录 | §13.1 |
| 15 | `logBufferMax` | 2000 | 日志内存环上限（`logs` 的可读窗口） | §13.1 |
| 16 | `rosterStorage` | `true` | 是否挂宿主 storage 域（`false` = 强制内存） | §14.3 |
| 17 | ~~`bootstrapOnCreate`~~ | — | **已退役**（2026-10-02）：建账号 = 纯登记不投任务书，接入 = 唯一点火点（§7.4、§7.4.1） | §11.2、§7.4 |
| 18 | `taskBrief` | `DEFAULT_TASK_BRIEF` | 任务书模板（占位符 `{{serverName}}`/`{{endpoint}}`/`{{account}}`/`{{conn}}`/`{{loggedIn}}`） | §7.4 |
| 19 | `silenceMs` | 120_000 | 静默唤醒时长（**正整数 fail-loud**） | §7.5 |
| 20 | `probeStartMs` | 90_000 | 探活静默首发延迟（自**最后数据到达**起；T12 link 层静默伴随自驱） | §3.2 |
| 21 | `probeRetryMs` | 9_000 | 探活无应答重发间隔 | §3.2 |
| 22 | `probeMaxAttempts` | 3 | 探活总次数上限（判死刻度 = `probeStartMs + 次数 × probeRetryMs`，须 ≤ `silenceMs`） | §3.2 |
| 23 | `reconnectMaxAttempts` | 5 | 意外断线自动重连尝试次数上限（到限次保持断开等人工） | §3.2、§11.3 |
| 24 | `reconnectIntervalMs` | 30_000 | 自动重连尝试固定间隔 | §3.2、§11.3 |
| 25 | `sendTimeoutMs` | 15000 | `mud_send` 缺省总超时（工具侧钳制 ≤ 60000） | §8.7 |
| 26 | `sendMaxLines` | 50 | 裸读尾部 / 兜底行数 | §8.7 |
| 27 | `captchaTimeoutMs` | 180_000 | 验证码挂起预算（**独立预算**，不受 MAX_TIMEOUT_MS/silenceMs 校验约束；**正整数 fail-loud**） | §8.17 |

> 上表与 `packages/mud-core3/src/index.ts` 的 `MudCore3Config` 一一对应（**26 项现役 + 1 已退役**）。探活三项 + `silenceMs` 受启动期校验式约束（`probeStartMs + probeMaxAttempts × probeRetryMs ≤ silenceMs`，fail-loud，§3.2）。变更 Config 必须同时改本表与 §0.1 版本号语义（Y/Z 级）。

### 硬编码项（**不进 Config**，附理由）

| 项 | 值 | 不入 Config 的理由 |
|---|---|---|
| 禁词表 | `{ suicide }` | 安全面最小集；**实证发现危险行为再逐行加回**（§12.3） |
| 裸读 `quietMs` | 300 | 无例证不进 Config（§8.7） |
| `timeoutMs` 上限 | 60000 | 协作式超时上限（§8.7） |
| 流程步转移上限 | 256 | 防 `goto` 环（§8.13） |
| 归属环深护栏 | 32 | 防谱系数据成环（§8.5） |
| `RECORD/LOG` 滚动 | 5MB × 3 | 诊断面容量（§13.1） |

### 视图与流程侧配置

- **画面视图参数成组**：`viewScrollback` / `viewCols` / `viewMaxBufferedBytes` 由引擎行一次注入 `MudService` 的 `view`（§5.3）。
- **流程存储域**：`mud_workflow`（表 `workflows`），无独立 Config（域不可用即降级内存，§8.11）。

## 15.6 宿主依赖面索引

| 面 | 权威章节 |
|---|---|
| `credentials` / `sessionController` / `storageDomain` / `agents` / 事件 / `tools` / `llm` / `typert` | §2.3 |
| 宿主能力缺口（会话删除面、blank、ask 无超时、preset 共享、Workspace 无字段） | §2.4 |
| 加载与模块解析（peer 拦截 / linked root / junction） | §2.2 |
| 宿主事实锚点与整批复核 | §2.1、§2.5 |

> AI生成
