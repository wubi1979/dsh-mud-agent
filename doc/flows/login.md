---
sections: [11]
status: active
deps: ["§19", "§1", "§7", "§8"]
impl: packages/mud-core/src/flow/flows/index.ts
note: login 流程声明的设计事实源；实现跟随 flow/flows/index.ts 的 LOGIN_FLOW，机制见 §19
---

# login 流程（声明）

登录 = 流程表 `login`（v0.4.0，step 驱动；与 §19 同一套机制，运行时面见 §11）。
入口是**匹配服务端提示行**，不是定时器；每步"提示行 → 命令 → 结果判据"。步骤（`(估计)` 标记者待实录原文替换）：

```
login                                        priority = 1000（不可打断；无规则 interrupts > 1000）
  when        !logged_in                     （空闲且未登录才 arm 入口）
  name     driver  您的英文名字：|您的英文名字（要注册新人物请输入new。）：
           action  mud_send { cmd:'{name}' }
           fail    ['需要创建新人物'(估计)]     （用户名不存在 → 实质失败, 中断流程）
           next    ['pass']                  （后继只有 pass）
  pass     driver  此ID档案已存在，请输入密码：|请输入密码：
           action  mud_send { cmd:'{pass}' }
           fail    ['密码错误'(估计)]          （实测常表现为服务器直接断连 → 走桥 error 那条路）
           next    ['replace','success']     （两个都带 driver ⇒ 都是条件分支，谁的行先到谁生效）
  replace  driver  您要将另一个连线中的相同人物赶出去，取而代之吗？(y/n)     ← 可能步骤
           action  mud_send { cmd:'y' }
           next    ['success']               （答完 y 直接等成功句，不再要密码）
  success  driver  ['目前权限：(player)','重新连线完毕','欢迎来到'(估计)]   ← "已进入游戏"的成功句
           action  mud_send { cmd:'' }       （**空命令**：顶开服务端 / 跳过 MXP 检测）
           ok      [GA]                      （空命令必有 GA；无响应即异常 → 5s 超时失败收束）
           onEnter patch { logged_in:true }  （进入即落 world）
           timeoutMs 5_000
           （next 空 = 终态：空命令成功即整个登录流程成功结束）
  failPolicy { notify: 'none' }              （失败只写日志 + 决策记录, 不唤醒 T2）
```

- **本步结果 = 下一步的新文本**（登录流程的核心语义）：`name`/`pass`/`replace` **都不写 `ok`** ——
  "请输入密码"既是 `pass` 的 driver，也就是 `name` 的结果；"替换人物"是 `pass` 的结果（→`replace`）；
  "目前权限/重新连线完毕"是 `pass`/`replace` 的结果（→`success`）。判据**只写一份**（§19.2：命中后继 driver ⇒ 本步成功 + 走该分支）。
  反面：若在这里另写一条相同文本的 `ok`，它会**抢在条件分支之前**命中（`ok` 声明序在前）→ 密码提示行被消费 → 走不到 `pass`（流程挂死到超时）。
- **四步定稿**：`name → pass → [replace | success]`、`replace → success`；`name` 的后继**只有** `pass`（同名确认句不会在名字步之后出现）。**删掉了 `mxp` 与 `look` 两步** —— 终态步的**空命令**同时完成"顶开服务端（不发命令则输出要等约 5 分钟，实测）"与"跳过 MXP 检测（发任何命令都能跳过）"两件事，登录后的第一屏交给 T2 自己决定。
- **空命令必有 GA**：系统有响应则必然返回 GA，系统无响应即异常 → 5s 超时 → 流程失败收束。因此终态步保留 `ok:[GA]`（这是"登录流程真的收尾了"的确认）。
- **失败不设恢复路径**：用户名/密码是**人工给的**，T2 与用户都补不了；密码错实测还会连带断连。所以 `failPolicy = { notify: 'none' }` —— 只写会话日志 + 决策记录，**不唤醒 T2**。断线重连后照常重新跑整套登录（`logged_in` 在连接建立时复位，§11 开头）。
- **`success` 的进入判据是"已进入游戏"的成功句**：它带 driver（条件分支）→ 命中即表示前一步成功并进入本步，进入时置位 `logged_in` 并发出空命令；`pass` 的两个后继（`replace`/`success`）都带 driver，所以"两条句子都不出现"= 不静默等待，而是**本步超时失败收束**。
- **收束在终态 `success`**：中间每一步成功都只是**里程碑**，只有 `next` 为空的 `success` 成功时流程才结束（`[流程] login 完成（终态）`）。
- **`{pass}` 的值源是官方凭据 seam（W9）**：`pass` 步发的是 `mud_send { cmd:'{pass}' }`，占位符在**发送瞬间**插值；插进去的那份明文由 host 在**连接时**经 `ctx.credentials.resolve` 从凭据引用名解析（§10/§11）：进程 env → `$DSH_HOME/.credentials.yaml` → `.env`。页面名单只存引用名，RPC 只收引用名。解析失败（引用名非法 / 未挂载凭据 provider / 引用未配置）**在建连接之前**就 fail loud —— 流程根本不会起来，因此不会出现"名字发出去了、密码是空串"的半截登录。
- 待实录项（上线前核对）：`需要创建新人物` 原文、`密码错误` 原文、`success` 的三条成功句形态。
