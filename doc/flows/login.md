---
sections: []
status: active
deps: ["§8.8", "§8.10", "§8.13", "§8.15"]
impl: packages/mud-core3/src/flows/login.ts
note: login 流程实体声明（locked）；机制见 §8.13、执行缝见 §8.14、判据依据见附录 A
---

# login 流程（声明 · locked）

- **归属**：§8.15 的从属声明文件。**§8 的规则优先**；本文件只细化步表、判据原文与语料依据。
- **性质**：**locked**（拒改拒删，§8.11）；**全系统唯一允许使用 `sendCredential` 的流程**（§8.12 凭据红线双闸）。
- **实现**：`packages/mud-core3/src/flows/login.ts`（流程实体归 core3；`mud-workflow` 是纯架构，§8.8）。
- **入口**：**匹配服务端提示行**，不是定时器。
- **机制**：解释器语义见 §8.13（动作在路由前执行；`initial` 取 `pendingLines` 尾部快照 ⇒ **提示符先到先结算**）。
- **判据原文**：全部取自 [附录 A](../appendices/A-capture-facts.md) 实测记录（不得凭印象改正则）。

## 步表（7 步 + `success` 出口）

步预算 `STEP_MS = 30_000`；终态兜底 `SUCCESS_MS = 5_000`。

| # | 步 `id` | 读窗 `wait` | 动作 `action` | 路由 |
|---|---|---|---|---|
| 1 | `prompt-name` | `until`: `您的英文名字（要注册新人物请输入new。）：` \| `您的英文名字：` | `sendCredential: '{name}'` | `next → prompt-pass` |
| 2 | `prompt-pass` | `until`: 密码提示（两形态）；`failOn`: `需要创建新人物` | `sendCredential: '{pass}'` | `onFailOn[0] → exit{stage:'need-new', ok:false}`；`next → confirm` |
| 3 | `confirm` | `until`: [`替换在线人物提示`, `成功句`]；`failOn`: `^密码错误\|^密码不正确\|^登录失败`（flags `m`） | **无动作**（它是接收 `{pass}` 应答的那一窗） | `onFailOn[0] → exit{stage:'bad-pass', ok:false}`；`branch[0] → replace`；`next → send-empty` |
| 4 | `replace` | — | `send: 'y'` | `next → wait-success` |
| 5 | `wait-success` | `until`: `成功句` | — | `next → send-empty` |
| 6 | `send-empty` | — | `sendCredential: ''`（**空命令**） | `next → wait-ga` |
| 7 | `wait-ga` | `gaCount: 1`（`timeoutMs = SUCCESS_MS`） | — | `next → exit{stage:'success', ok:true}` |

**判据常量（与实现一一对应）**

| 常量 | 值 |
|---|---|
| `NAME_SRC` | `您的英文名字（要注册新人物请输入new。）：\|您的英文名字：` |
| `NEED_NEW_SRC` | `需要创建新人物` |
| `PASS_SRC` | `此ID档案已存在，请输入密码：\|请输入密码：` |
| `BAD_PASS_SRC` | `^密码错误\|^密码不正确\|^登录失败`（`flags: 'm'`） |
| `REPLACE_SRC` | `您要将另一个连线中的相同人物赶出去，取而代之吗？\(y\/n\)` |
| `SUCCESS_SRC` | `目前权限：\(player\)\|重新连线完毕` |

## 设计要点

1. **名字与密码都走 `sendCredential`**：两条都不触发 `onSend` ⇒ 不进画面回显（§12.2 发送侧闸）。
   - 代价：登录期间画面上看不到自己发出的用户名/密码——**这是有意的**（服务器本身也不回显，附录 A.5）。
2. **`failOn` 归窗（勘误 ①）**：失败分类是**被应答的那一窗**的事——
   - 「需要创建新人物」挂在 `prompt-pass`：它是 `{name}` 的应答；
   - 「密码错误」挂在 `confirm`：它是 `{pass}` 的应答。
   - **反例**：把「密码错误」挂在 `prompt-pass`（发送前等 driver 的窗）——那一窗在密码发出前就已关闭，**永远赶不到**。
3. **成功句不用「欢迎来到」（勘误 ②）**：与建连横幅「欢迎来到北大侠客行」撞车，登录前即到达会误判成功；只认 `目前权限：(player)` 与 `重新连线完毕`。
4. **`confirm` 无动作、三出口**：`until` 命中替换提示 → `branch → replace`；命中成功句 → `next → send-empty`；`failOn` 命中 → `bad-pass`。三条都不中 ⇒ **结构化 timeout**（点名步骤，不静默，§8.13）。
5. **`replace`（答 `y`）→ `wait-success`**：接管在线同名人物后就等成功句。
6. **终态两步**：`send-empty` 发**空命令**（顶开服务端 + 跳过 MXP 探测，实现天然走凭据通道、不进回显）→ `wait-ga` 收 GA = **"登录真的收尾了"的确认**；GA 不到 ⇒ 5s 兜底到期 ⇒ 结构化 timeout ⇒ 流程失败。
7. **`success` 是出口不是步**：`wait-ga` 的 `next` 直接 `exit{stage:'success', ok:true}`；**`'success'` 强制 `ok: true`**（§8.10）。

## 边界与不做的

| 项 | 结论 |
|---|---|
| **连接守卫** | **不在流程表**：`workflowEnvFor` 在 env 注入前就拒绝未连接（§8.14）——未连接时 driver 永远不会到达 |
| **验证码链路** | **不进流程**：流程**不能等人工**，人工环节留在 agent 层（§17.3 后置） |
| **失败恢复路径** | **不设**：用户名/密码是人工给的，流程**不自作主张重试**；失败以结构化出口返回给子 agent（§7.6） |
| **`need-new` / `bad-pass`** | 是**结构化失败现场**（agent 据此改写规划或向人报告），不是"重试信号" |
| **改名/改密** | 无此流程；凭据更换走页面重新写入（§11.6） |

## 参考

- 判据原文与语料依据：[附录 A 抓包与语料事实](../appendices/A-capture-facts.md)
- 机制与词汇表：§8.10（词汇表）、§8.13（解释器）、§8.14（`workflowEnvFor`）
- 凭据红线：§8.12、§12.2
- 端到端链路：§1.8.3、§7.6

> AI生成
