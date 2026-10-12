---
sections: []
status: active
deps: ["§8.8", "§8.10", "§8.13", "§8.17"]
impl: packages/mud-core3/src/flows/fullme.ts
note: fullme 流程实体声明（locked）；词汇表扩展与链路机制见 §8.17，呈现见 §9.7，判据依据同源附录 A（v1 实录）
---

# fullme 流程（声明 · locked）

- **归属**：§8.17 的从属声明文件。**§8 的规则优先**；本文件只细化步表、判据原文与语料依据。
- **性质**：**locked**（拒改拒删，§8.11）；与 `login` 并列第二个 locked-only `captcha` 动作流程（§8.12 红线双闸）。
- **实现**：`packages/mud-core3/src/flows/fullme.ts`（流程实体归 core3；`mud-workflow` 是纯架构，§8.8）。
- **触发**：**被动处置**——agent 判系统提示/信息降级后跑 `fullme`（不发周期探针，§8.17 口径）。
- **判据原文**：v1 实录七常量起步（v1 §11 `doc/archive/mud-core/flows/fullme.md`），宽匹配起步，**实机触发时按语料校准**（stale 句与失效句原文待实录，§13.4 纪律）。

## 步表（主链五步 + stale 自愈环三步 + 4 出口；T26.6 两级路由词汇，DEC-19）

步预算 `STEP_MS = 30_000`（urlwait/judge 读窗）；**挂起预算独立** = Config `captchaTimeoutMs` 缺省 180_000（§8.17 双预算分立）。
判据按**结局槽名**挂 `wait.outcomes`（`closeOn: 'criteria'`），路由走两级 `onOutcome`
（kind 直达 / `when` 按槽名细化）；捕获源具名化 `wait.captureFrom`
（组数只对该槽 patterns[0] 计）。

| # | 步 `id` | 读窗 `wait`（`closeOn: 'criteria'`，flags `m`） | 动作 `action` | 路由 |
|---|---|---|---|---|
| 1 | `request` | — | `send: 'fullme'` | `next → urlwait` |
| 2 | `urlwait` | outcomes：`已挂起`(fail) = stale 句、`冷却中`(fail) = 冷却句、`验证码地址`(ok) = robot.php URL 行；`captureFrom: '验证码地址'` + `captures: ['captchaUrl']`（**组 1 入 `captchaUrl`**——T14） | **无动作** | `onOutcome.fail.when` 细化：`已挂起 → abandon1`、`冷却中 → exit{stage:'cooldown', ok:false}`（两 fail 分支不同 ⇒ when）；`验证码地址`（ok 未覆盖）`next → answer` |
| 3 | `answer` | —（**captcha 步不设 wait 门**，§8.17） | `captcha: { url: '{captchaUrl}' }`（T14 参数化：URL 由捕获槽传入 → 抓图 → 推帧 → 挂起等人工码 → 值入 `{captcha}`） | `next → send-code` |
| 4 | `send-code` | — | `send: 'fullme {captcha}'`（引擎注入槽替换） | `next → judge` |
| 5 | `judge` | outcomes：`失效`(fail) = 失效句、`答对`(ok) = 答对句、`答错`(**fail**，信号视角改判 T26.6/DEC-19：被拒是 fail，重入用 when 表达) = 答错句 | **无动作**（收束窗） | `onOutcome.ok` **直达** `exit{stage:'success', ok:true}`；`onOutcome.fail.when` 细化：`答错 → goto answer`（重入，不重发引子）、`失效 → exit{stage:'expired', ok:false}` |
| 6–8 | `abandon1/2/3` | — | `send: 'fullme 1'` × 3 | 末步 `→ exit{stage:'abandoned', ok:false}` |

**判据常量（与实现一一对应；kind 在前、槽名在内——两表同构，§8.10；fail 组在前 = 判定序）**

| kind | 槽名 | 常量 | 值 |
|---|---|---|---|
| fail | `已挂起` | `STALE_SRC` | `你之前请求的fullme还没有完成` |
| fail | `冷却中` | `COOLDOWN_SRC` | `^你刚刚用过这个命令不久，还要[^。]*才能再用。`（flags `m`，时长动态通配） |
| fail | `答错` | `WRONG_SRC` | `好像什么都没有发生，但是又好像有什么事情做错了` |
| fail | `失效` | `EXPIRED_SRC` | `还没完成\|失效\|过期`（宽匹配起步，待语料校准） |
| ok | `验证码地址` | `URL_SRC` | `^(https?:\/\/[^\s]*robot\.php[^\s]*)`（flags `m`；行首锚 + 整体捕获——组 1 入 `captchaUrl` 槽） |
| ok | `答对` | `OK_SRC` | `你突然感到精神一振，浑身似乎又充满了力量` |

## 设计要点

1. **URL 仅首轮锚定 + 窄缓存保留（T14）**：URL 由 urlwait 捕获槽提取（`captchaUrl`），answer 动作收参数取图；答错重入未重经捕获步沿槽上值（**同轮不重发引子**——服务端事实：每次 fullme 只回一次 URL 无重发，重发 = 新 URL 新周期弃旧配额），同 URL 沿用缓存图（弹窗重现缓存图**不重抓**，image 复用职责不变），不同 URL 新抓新周期；URL 行未出现 = urlwait 结构化 timeout（报错点前移，awaitCaptcha 不再自取兜底）。
2. **answer 后必跟 judge 收束窗**：fullme 应答被窗口消费（readAbs 推进）**不进投递**——答案行不上浮 agent。
3. **答错 goto answer 跳过 urlwait 直接重入**（`onOutcome.fail.when 答错`，信号视角改判 fail——被拒是 fail，重入是分支不是缺省）：弹窗重现缓存图、刷新可再点 1 次（配额 = 每轮挂起 1 次，帧边界 diff 恢复，§9.7）；护栏 = 既有 MAX_TRANSITIONS（限次不建新机制，人工中止按钮兜底）。
4. **stale 自愈环**：上次 fullme 超时/中止留下的服务端悬挂态必踩（超时与中止均为常规路径）——三连 `fullme 1` 才真放弃，然后**结构化 fail 收束不重试**（服务端事实：放弃后约 15 分钟冷却，立即重试必再 stale）；agent 收到 fail 后自然结束，等下次服务器提示再触发。
5. **`{captcha}` 非敏感 + 替换四源（T14）**：普通引擎替换源，**不进凭据红线与 pass 掩码**（验证码不属于敏感信息）；`send` 上的槽替换是「模型内容零变换」纪律的**收窄例外**——替换 `{captcha}` 与 T14 命名槽（次序 `{captcha}` → 命名槽 → `{name}`/`{pass}`，send 侧不碰凭据占位），模型不得自造槽名，未知 `{xxx}` 原样保留。
6. **双预算分立**：`STEP_MS` 管读窗（等 URL/判据行）；挂起 180s 走 `captchaTimeoutMs`（env 实现内注入，解释器无参）——两预算先后串行不竞争，且独立于 MAX_TIMEOUT_MS/silenceMs 校验（§8.17）。
7. **判据一律 `^` 行首锚 + `flags: 'm'`**（login 勘误 ③ 同款纪律，§8.13）。

## 边界与不做的

| 项 | 结论 |
|---|---|
| **连接守卫** | **不在流程表**：`workflowIoFor` 在 io 注入前就拒绝未连接（§8.14） |
| **OCR 识别** | 本期不实现；`captcha` 动作内部留识别器注入位（识别成功直接填槽不推 UI，失败回落人工）——后期接入零接口/词汇表变更 |
| **挂起期投递** | **不暂停**：挂起持有 send 锁 ⇒ busy 谓词恒真 ⇒ 探测 tick 抑制（§3.2）；行流照常录制 |
| **多会话并发等码** | 等待注册表单会话单槽（并发冲突可读拒，I10）；webui 弹窗按最新帧呈现，未呈现的照常等 + 超时兜底（§9.7） |
| **流程历史面板** | 无专用验证码历史面板（呈现只在弹窗，§17.3 后置纪律） |

## 参考

- 词汇表扩展与链路机制：§8.17（`captcha` 动作 / `awaitCaptcha` 原语 / 双预算 / 等待注册表 / 三退出路径）
- remote 四动词与 webui 呈现：§15.1、§9.7
- 凭据红线（captcha 同列 locked-only）：§8.12
- 判据书写纪律：§8.13（整窗匹配模型）
- 判据语料 v1 实录：v1 §11（[archive](../archive/README.md)，只作追溯）；v1 抓包事实同源见[附录 A](../appendices/A-capture-facts.md)

> AI生成