---
sections: [11]
status: active
deps: ["§19", "§1", "§7", "§8", "§10"]
impl: packages/mud-core/src/runtime/flow/flows/fullme.ts
note: fullme 流程声明的设计事实源；实现跟随 runtime/flow/flows.ts 的 FULLME_FLOW，机制见 §19
---

# fullme 流程（声明）

fullme（防机器人验证）= 流程表 `fullme`（v0.4.0）。**入口不是定时器**：人物经验值过 **5M**（五百万）之后长时间不使用 fullme 会被系统判定为机器人，服务端届时打出提醒。**实录提醒原文：`5M后长时间不使用fullme，会被系统判定为机器人。`**，判据就是这一串本身（不加容错变体）。步骤：

```
fullme                                       priority = 100（可被打断：interrupts > 100 的战斗类事件）
  when        logged_in
  request  driver  5M后长时间不使用fullme，会被系统判定为机器人。
           action  mud_send { cmd:'fullme' }
           fail    /^你刚刚用过这个命令不久，还要[^。]*才能再用。/
                   （时长动态：`还有 3 分 20 秒` / `还有 45 秒`，总计 15 分钟 → 通配符吃下两种形态）
           next    ['stale','prompt']       （两条条件分支，互斥）
           ※ **无 ok**：本步结果 = 下一步的新文本；fail 命中即中止（无兜底、无"直接成功"路径）
  stale    driver  （实录）你之前请求的fullme还没有完成。如果图片已过期，可以打三次"fullme 1"放弃本次fullme。
           action  mud_send { cmds:['fullme 1','fullme 1','fullme 1'] }   ← **必须三连发**才能放弃
           fail    [{ kind:'ga', why:'放弃上一轮（三连 fullme 1）→ 本轮作废' }]
           （无 next：以**失败收束**收场 → 复位到空闲、只留入口）
  prompt   driver  /^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/
           capture { captchaUrl: /(https?:\/\/[^\s]*robot\.php\?filename=[^\s]+)/ }
           action  mud_captcha { url:'{captchaUrl}', note:'{lastFail}' }
                   ← **ask-human**：推图后工具**在途挂起**等人工（回合不收束）；
                     人工提交码 = 工具结果 ok（note 含码）；中止 / 175s 兜底超时 = ok:false
           ok      [{ kind:'tool', outcome:'ok' }]        ← 人工提交（判据 = 工具结果）
           fail    [{ kind:'tool', outcome:'error' }]     ← 取图失败 / 中止 / 兜底超时 → 本轮失败收束
           timeoutMs 180_000                              ← 含等人工（175s 兜底先结算）
           next    ['answer']                             ← 顺序兜底
  answer   driver  （无：由 prompt 顺序兜底进入；**答错重试不换步**）
           action  mud_send { cmds:['halt','fullme {captcha}'] }
           awaitExternal  ['captcha']                     ← **兜底声明**（人工值已随 prompt 的
                                                             工具结果进槽；声明保留 = 进人工环节的
                                                             运行时语义不变）
           timeoutMs 180_000                 ← **本步总预算**：发答案 + 答错重来 + 收结果都算在内
                                             = 图片有效期 3 分钟（到点 = 本步超时 → 本轮失败）
           ok      ['你突然感到精神一振，浑身似乎又充满了力量！']   ← 行含该串即成功（实录句）
           fail    ['好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！']
                   [{ kind:'tool', outcome:'error' }]   ← 工具结果失败（取图/发送）同样算本步失败
           retry   { attempts:3, on:['fail'],            ← 重试**不出本步**、**不重置上面的预算**
                     action: mud_captcha { url:'{captchaUrl}', note:'{lastFail}' } }
                   （重试动作 = 重新取图 + 弹窗反馈失败原文；随后本步动作重新挂起等人工）
           next    ['success']
  success  action  mud_send { cmd:'hpbrief' }    ← 补状态（fullme 不只防挂机）
           ok      [GA]
           （next 空 = 终态：hpbrief 被接受即流程成功结束）
  failPolicy { notify:'none' }                   ← 只留痕，不叫 T2
```

- **`request` 的判据只有一份**：`stale` 与 `prompt` 的 driver 就是它的两种结果（§19.2）—— 成功句不在这里声明：**必须正确回码才能通过**。
- **四种收场都让服务端停在当前轮次**（作者实测）：取图失败 / 人工中止 / 3 次答错 / 3 分钟预算耗尽（人工没填或没填完）→ 下一轮 `fullme` 必然先撞 `stale`（先三连 `fullme 1` 放弃上一轮）。**答错 3 次是例外**：错码与 `fullme 1` 等价，三次错码本身就把上一轮放弃了 ⇒ 下一轮**不进** `stale`（`attempts:3` 正好等于"三连放弃"）。
- **冷却期不自己计时**：`fullme 1` 放弃后有冷却期；冷却未完时下一轮 `request.fail` 会把剩余时间原样报出来（再一次失败收束），冷却结束自然跑通 —— 不需要额外的"等 N 分钟"机制。
- **`answer` 的时间预算是"一步总计"**（不引入 `humanTimeoutMs`/`humanWaitMs` 字段）：`timeoutMs: 180_000` 从**首次进入本步**起算，覆盖"发答案 + 答错重来 ×3（每次重来**再问一次、再等一次人工**）+ 收结果"全部动作；**重试不重置**（这是它与"每步各自计时"的唯一差别）。3 分钟正好等于图片有效期 —— 到点即本步超时 → 本轮失败收束；**首次等人工在 `prompt` 步**（ask-human 工具在途，其 `timeoutMs` 同为 180s，175s 兜底先结算）。不需要单独的"人工超时"字段，也不需要 `Config.humanWaitMs`。
- **答错重试在步内自环**（不换步）：`{lastFail}` ← 答错句原文 → 清空 `{captcha}` 槽（**旧码作废**，`clearExternal`）→ 投 `retry.action`（`mud_captcha` 再抓同一个 `robot.php`，页面自动刷新出新图，弹窗带失败原文）→ **工具再次在途挂起（第二次提问）** → 新码提交后本步动作随**第二次工具结果** defer 进同一回合 → 计时器继续跑。三次提问 = 三次挂起-解挂，回合始终开着。`attempts:3` = 总尝试次数（含首次）；用尽 → 本轮失败收束。工具结果失败（取图失败/发送失败）命中 `fail` 里的 `tool` 判据 → 立即失败，不必等到预算耗尽。
- **重试动作的结果同样按本步 `fail` 判据结算**：所以"重试时图片也解析不出来"会当场失败收束，而不是让人对着坏图等到 3 分钟。
- **`hpbrief`**：终态步发 `hpbrief`，以 GA 判定"命令被接受"即收束；把它的应答**折叠进 world 的 state 规则后续一起加**（现行先只发命令）。

## 定稿的 `FlowSpec`（实现清单见下）

```ts
export const FULLME_FLOW: FlowSpec = {
  id: 'fullme',
  priority: PRIORITY_NORMAL,                    // 100：战斗/生存类（interrupts > 100）可打断
  when: world => world.flags.logged_in === true,
  entry: 'request',
  timeoutMs: 30_000,
  failPolicy: { notify: 'none' },               // 只留痕：人工/系统问题，T2 补不了
  steps: [
    {
      id: 'request',
      driver: { kind: 'text', includes: ['5M后长时间不使用fullme，会被系统判定为机器人。'] },
      action: { tool: 'mud_send', args: { cmd: 'fullme' } },
      // 无 ok：本步结果 = 下一步的新文本（stale 提示 / 验证码地址行）。
      fail: [{ kind: 'regex', patterns: [/^你刚刚用过这个命令不久，还要[^。]*才能再用。/] }],
      next: ['stale', 'prompt'],                // 两条条件分支；fail 命中即中止
      timeoutMs: 30_000,
    },
    {
      id: 'stale',
      driver: { kind: 'text', includes: ['你之前请求的fullme还没有完成。'] },
      // 必须三连发才能真的放弃上一轮（作者实测）。
      action: { tool: 'mud_send', args: { cmds: ['fullme 1', 'fullme 1', 'fullme 1'] } },
      fail: [{ kind: 'ga', why: '放弃上一轮（三连 fullme 1）→ 本轮作废' }],
      timeoutMs: 5_000,
    },
    {
      id: 'prompt',
      driver: { kind: 'regex', patterns: [/^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/] },
      capture: { captchaUrl: /(https?:\/\/[^\s]*robot\.php\?filename=[^\s]+)/ },
      action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      ok: [{ kind: 'tool', outcome: 'ok' }],    // 人工提交（ask-human 工具结果）
      fail: [{ kind: 'tool', outcome: 'error' }],
      next: ['answer'],                         // 顺序兜底
      timeoutMs: 180_000,                       // 含等人工（175s 兜底先结算）
    },
    {
      id: 'answer',
      action: { tool: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } },
      awaitExternal: ['captcha'],               // 进入即挂起动作 + 进人工环节
      ok: [{ kind: 'text', includes: [FULLME_OK_TEXT] }],
      fail: [
        { kind: 'text', includes: [FULLME_WRONG_TEXT] },
        { kind: 'tool', outcome: 'error' },     // 工具结果失败（取图/发送）同样算本步失败
      ],
      // 重试**不出本步**、**不重置本步预算**；重试动作 = 重新取图 + 弹窗反馈失败原文。
      retry: {
        attempts: 3,                             // 总尝试次数（含首次）
        on: ['fail'],
        action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      },
      next: ['success'],
      timeoutMs: 180_000,                        // 本步总预算 = 图片有效期（等人工 + 重来都算在内）
    },
    {
      id: 'success',
      action: { tool: 'mud_send', args: { cmd: 'hpbrief' } },
      ok: [{ kind: 'ga' }],                     // next 空 = 终态：hpbrief 被接受即成功收束
      timeoutMs: 5_000,
    },
  ],
}
```

## 实现面（8 项，✅ 已落地；注册期校验与端到端测试见 §13.6）

1. **工具结果判据** `{ kind:'tool', outcome:'ok'|'error' }`（§19.1）：官方工具结果经现有包装器（`runWithDeliveryChannel` → `endToolCall`）喂回流程机 —— call-id `mud-<delivery>-<index>` → 该动作的 `ruleId`（`flow:fullme/prompt`）→ 步骤 id，**只认当前步**。
2. **流程实例槽 + 槽占位符**：`capture` 声明把命中行抽进槽（`{captchaUrl}`；**答错重试不重新抽取，沿用首次的值**）；内建 `{lastFail}` = 本流程最近一次 `fail` 命中行原文。运行时**投递前**按槽插值；`{captcha}` 仍留到**发送瞬间**插值（人工值不进转录）。
3. **人工环节沿用本步 `timeoutMs`**（**不单列 `humanTimeoutMs`**）：`enterStep` 在 `awaitExternal` 步**照常布防计时器**（现在是"不布防"）；等人工期间计时器照跑，到点 = 该步超时 → 流程失败收束。`answer.timeoutMs = 180_000` = 图片有效期，等人工与答错重来共用这一份预算；**不需要 `Config.humanWaitMs`**。
4. **`retry` 定稿** `{ attempts, on?, action? }`：`attempts` = **总尝试次数（含首次）**；`on` 缺省 `['driver']`（旧行为一字不变，全仓没有流程用过它，无迁移负担）；命中 `on` 里的判据时**在原步内重试** —— 投 `action`（缺省 = 重发本步动作）、清空本步 `awaitExternal` 的槽值、把命中行原文写进 `{lastFail}`、重新挂起等人工，**不重置本步计时器**；`attempts` 用尽才算失败。
5. **流程路径的人工环节三处**（§19.3）：① `awaitExternal` 的动作**先挂起不投递**（现在帧内路径会先把字面 `fullme {captcha}` 发出去）；② `exitHumanWait` 调 `flow.resumeHuman()`（现在是死代码 → 永久挂死）：回到 `awaiting-result`，**计时器继续跑、不重布防**；③ 等人工期间**行判据不结算**本步。
6. **`mud_captcha` 工具**（新注册，所有档位可见）：地址围栏（只允许 pkuxkx.net）→ 抓 `robot.php` → 取 `<img src>` → 归一为绝对地址 → 推前台弹窗（payload 带 `note` = 失败原文）→ **ask-human：在途挂起等人工提交**（v0.7.3；中止/兜底超时 = `ok:false`）→ 返回 `{ok, note 含码}`（无新依赖，复用 `services/network/captcha.ts`）。
7. **退役**：`fullme:request`/`fullme:prompt`/`fullme:done` 三条规则（§16）；取图职责从运行时 `sink.captcha` 迁到 `mud_captcha`；随之 `Config.captchaPatterns` / `extractCaptchaUrl` 若无其它使用者一并退役；`runtime-captcha.spec.ts` 整篇改写为流程用例、`rule-coverage.spec.ts` 三条 fullme 样本移走、`runtime-direct-action.spec.ts` 的样本替换；`index.ts` 系统命令集里那截 `fullme:*` 过滤删除（`flowCommands(defaultFlows)` 已覆盖 `fullme`/`halt`/`fullme {captcha}`/`fullme 1`）。
8. **判据文案 `why?`**（小项）：`FlowMatch` 可带 `why`，只影响日志/决策文案 —— 让 `stale` 的收束写成"放弃上一轮 → 本轮作废"而不是"命中失败判据 GA"。

## 人工环节与取图职责

- **ask-human 同回合提问**（v0.7.3 重定稿，对齐官方 `ApprovalService.request` 语义；机制全文见 §19.3）：`prompt` 步的 `mud_captcha` 推图后**工具不返回**（在途挂起 → 回合保持打开），人工提交的码作为**工具结果**回管线 → `answer` 动作随该工具结果 defer 进**同一回合**（不再"人工等待收束回合、回填开新回合"）。弹窗**只收图片里的码**（§19.3 人工只负责提供值；`halt`/`fullme` 序列仍归流程动作声明）。**不做 OCR**（pkuxkx 明确要求人工）。
- **fail-closed 三出口**（工具结果 `ok:false` → 所在步失败收束，不悬挂）：① 弹窗"中止" → `captchaAbort` RPC → waiter 直接失败结束；② 每次提问的等待兜底 `CAPTCHA_WAIT_MS = 175_000`（`session.ts` 常量，**不给模型看、非 Config 字段**，先于步预算结算；步预算 180s 仍是硬上界）；③ 流程结束 / 断线 / 会话释放（等待作废）。
- **取图职责分界**：**工具** `mud_captcha` 负责"出站围栏 + 抓 `robot.php` + 取 `<img src>` + 归一为绝对地址 + 推弹窗 + 在途等人工提交"（`services/network/captcha.ts` 的 `resolveCaptchaImage`），提交/中止/超时都体现为工具结果 `{ok, note 含码}`/`{ok:false}`；**宿主**（WebUI）负责弹窗交互（输入码 / 刷新 / 中止）并登记 `robotUrl → imageUrl`（供 `/mud/captcha/refresh` 刷新）。运行时只管"判据结算 + 槽插值 + 计时"。
