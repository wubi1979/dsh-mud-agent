---
sections: [11]
status: active
deps: ["§19", "§1", "§7", "§8", "§10"]
impl: packages/mud-core/src/agent/flow/flows/fullme.ts
note: fullme 流程声明的设计事实源；实现跟随 agent/flow/flows/fullme.ts 的 FULLME_FLOW，机制见 §19
---

# fullme 流程（声明）

fullme（防机器人验证）= 流程表 `fullme`（v0.4.0；v0.11.0 起收口/分类分离、形态 C）。**入口不是定时器**：人物经验值过 **5M**（五百万）之后长时间不使用 fullme 会被系统判定为机器人，服务端届时打出提醒。**实录提醒原文：`5M后长时间不使用fullme，会被系统判定为机器人。`**，判据就是这一串本身（不加容错变体）。步骤：

```
fullme                                       priority = 100（可被打断：interrupts > 100 的战斗类事件）
  when        world.flags.logged_in === true
  entry       request
  timeoutMs   30_000                          （流程级缺省步预算）
  failPolicy  { notify: 'none' }               （只留痕：冷却/答错/超时都是人工或系统问题，T2 补不了）

  request  driver   5M后长时间不使用fullme，会被系统判定为机器人。
           action   mud_send { cmd:'fullme' }
           settle   { mode:'stream', fallback:{ms:30_000} }
           classify { fail: [/^你刚刚用过这个命令不久，还要[^。]*才能再用。/] }
                    （时长动态：`还有 3 分 20 秒` / `还有 45 秒`，总计 15 分钟 → 通配符吃下两种形态）
           next     ['stale','prompt']       （两条条件分支，互斥）
           ※ **无 ok 分类**：本步结果 = 下一步的新文本；fail 命中即中止（无兜底、无"直接成功"路径）
  stale    driver   （实录）你之前请求的fullme还没有完成。……
           action   mud_send { cmds:['fullme 1','fullme 1','fullme 1'] }   ← **必须三连发**才能放弃
           settle   { mode:'stream', on:{kind:'ga',count:3}, fallback:{ms:5_000} }
           classify { onSettle: 'fail' }     ← 声明才计 GA：第 3 个 GA 关窗；关窗而分类未命中 → 按失败收场
           （无 next：以**失败收束**收场 → 复位到空闲、只留入口）
  prompt   driver   /^https?:\/\/[^\s]*robot\.php\?filename=[^\s]+/
           captures [ /(?<captchaUrl>https?:\/\/[^\s`]*robot\.php\?filename=[^\s`]+)/ ]
                    （命名捕获组即槽名；进入本步时从命中行抽出）
           action   mud_captcha { url:'{captchaUrl}', note:'{lastFail}' }
                    ← **ask-human**：推图后工具**在途挂起**等人工（回合不收束）；
                      人工提交码 = 工具结果 ok（note 含码）；中止 / 175s 兜底超时 = ok:false
           settle   { mode:'inline' }        ← **工具结果即收口**（不开行流窗口）：工具 ok→ok / error→fail
           next     ['answer']               ← 顺序兜底（answer 无 driver）
           timeoutMs 180_000                 ← 含等人工（175s 兜底先结算）
  answer   driver   （无：由 prompt 顺序兜底进入；**答错重试不换步**）
           action   mud_send { cmds:['halt','fullme {captcha}'] }
           awaitExternal ['captcha']         ← 兜底声明：ask-human 首次回码后码已随工具结果就位、
                                               动作即投；答错重试时槽值被清空 → 本步动作再次等拍 2
           settle   { mode:'stream', fallback:{ms:180_000} }
                    ← **本步总预算**：发答案 + 答错重来 + 收结果都算在内 = 图片有效期 3 分钟
           classify { ok:['你突然感到精神一振，浑身似乎又充满了力量！'],
                      fail:['好像什么都没有发生，但是又好像有什么事情做错了。再来一次试试！'] }
           retry    { attempts:3, on:['fail'],
                      action: mud_captcha { url:'{captchaUrl}', note:'{lastFail}' } }
                    （重试动作 = 重新取图 + 弹窗带失败原文；随后本步动作经**拍 2**发出）
           next     ['success']
  success  action   mud_send { cmd:'hpbrief' }    ← 补状态（fullme 不只防挂机）
           settle   { mode:'stream', on:{kind:'ga',count:1}, fallback:{ms:5_000} }
           （next 空 = 终态：hpbrief 被接受即流程成功结束）
```

- **`request` 的判据只有一份**：`stale` 与 `prompt` 的 driver 就是它的两种结果（§19.2）—— 成功句不在这里声明：**必须正确回码才能通过**。
- **四种收场都让服务端停在当前轮次**（作者实测）：取图失败 / 人工中止 / 3 次答错 / 3 分钟预算耗尽（人工没填或没填完）→ 下一轮 `fullme` 必然先撞 `stale`（先三连 `fullme 1` 放弃上一轮）。**答错 3 次是例外**：错码与 `fullme 1` 等价，三次错码本身就把上一轮放弃了 ⇒ 下一轮**不进** `stale`（`attempts:3` 正好等于"三连放弃"）。
- **冷却期不自己计时**：`fullme 1` 放弃后有冷却期；冷却未完时下一轮 `request.fail` 会把剩余时间原样报出来（再一次失败收束），冷却结束自然跑通 —— 不需要额外的"等 N 分钟"机制。
- **`answer` 的时间预算是"一步总计"**（不引入 `humanTimeoutMs`/`humanWaitMs` 字段）：`settle.fallback.ms = 180_000` 从**首次进入本步**起算，覆盖"发答案 + 答错重来 ×3（每次重来**再问一次、再等一次人工**）+ 收结果"全部动作；**重试不重置**（这是它与"每步各自计时"的唯一差别）。3 分钟正好等于图片有效期 —— 到点即本步超时 → 本轮失败收束；**首次等人工在 `prompt` 步**（ask-human 工具在途，其预算同为 180s，175s 兜底先结算）。
- **答错重试在步内自环**（不换步、**两拍**）：命中 fail 分类 → `{lastFail}` ← 答错句原文 → 清空 `{captcha}` 槽（**旧码作废**，`clearExternal`）→ **拍 1** 发布 `retry.action`（`mud_captcha` 再抓同一个 `robot.php`，页面自动刷新出新图、弹窗带失败原文）→ 其结果显示后**拍 2** 发布本步动作 → 新码提交后动作发出。三次提问 = 三次挂起-解挂，回合始终开着。`attempts:3` = 总尝试次数（含首次）；用尽 → 本轮失败收束。工具结果失败（取图失败/发送失败）命中 fail → 立即失败，不必等到预算耗尽。
- **重试动作的结果同样按本步判据结算**：所以"重试时图片也解析不出来"会当场失败收束，而不是让人对着坏图等到 3 分钟。
- **`hpbrief`**：终态步发 `hpbrief`，以 GA 判定"命令被接受"即收束；把它的应答**折叠进 world 的 state 规则后续一起加**（现行先只发命令，§18 未决 #5）。

## 现行 `FlowSpec`（作者面声明；引擎消费形见 §19.1）

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
      driver: { kind: 'text', includes: [FULLME_REMINDER_TEXT] },
      action: { tool: 'mud_send', args: { cmd: 'fullme' } },
      settle: { mode: 'stream', fallback: { ms: 30_000 } },
      classify: { fail: [FULLME_COOLDOWN_PATTERN] },   // 无 ok：本步结果 = 下一步的新文本
      next: ['stale', 'prompt'],                       // 两条条件分支；fail 命中即中止
    },
    {
      id: 'stale',
      driver: { kind: 'text', includes: [FULLME_STALE_TEXT] },
      action: { tool: 'mud_send', args: { cmds: ['fullme 1', 'fullme 1', 'fullme 1'] } },
      settle: { mode: 'stream', on: { kind: 'ga', count: 3 }, fallback: { ms: 5_000 } },
      classify: { onSettle: 'fail' },                  // GA 关窗而分类未命中 → 本轮作废
    },
    {
      id: 'prompt',
      driver: { kind: 'regex', patterns: [FULLME_URL_PATTERN] },
      captures: [FULLME_URL_CAPTURE],                  // 命名捕获组 captchaUrl 即槽名
      action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      settle: { mode: 'inline' },                      // 工具结果即收口（工具 ok→ok / error→fail）
      next: ['answer'],                                // 顺序兜底
      timeoutMs: 180_000,                              // 含等人工（175s 兜底先结算）
    },
    {
      id: 'answer',
      action: { tool: 'mud_send', args: { cmds: ['halt', 'fullme {captcha}'] } },
      awaitExternal: ['captcha'],                      // 兜底声明：重试清槽后本步动作再等拍 2
      settle: { mode: 'stream', fallback: { ms: 180_000 } },   // 本步总预算 = 图片有效期
      classify: { ok: [FULLME_OK_TEXT], fail: [FULLME_WRONG_TEXT] },
      retry: {
        attempts: 3,                                   // 总尝试次数（含首次）
        on: ['fail'],
        action: { tool: 'mud_captcha', args: { url: '{captchaUrl}', note: '{lastFail}' } },
      },
      next: ['success'],
    },
    {
      id: 'success',
      action: { tool: 'mud_send', args: { cmd: 'hpbrief' } },
      settle: { mode: 'stream', on: { kind: 'ga', count: 1 }, fallback: { ms: 5_000 } },
    },
  ],
}
```

## 落地要点（v0.11.0 现状）

1. **收口与分类分离**：`stale` 用 `on:{kind:'ga',count:3}` 收口 + `classify.onSettle:'fail'` 分类（**声明才计 GA**）；`prompt` 用 `mode:'inline'`（工具结果即收口，天然无判据可分类）；`answer` 用纯计时窗 + 自填正则分类；`success` 用 GA 收口。**GA/tool 都不是分类 kind**。
2. **流程槽 + 抽取**：`captures` 的命名捕获组就是槽名（`captchaUrl`），进入本步时从命中行抽出；内建 `{lastFail}` = 本流程最近一次 `fail` 命中行原文。流程槽在**发布槽/投递前**填实，`{captcha}` 留到**发送瞬间**插值（人工值不进转录）。
3. **人工环节沿用本步预算**（**不单列 `humanTimeoutMs`**）：进入 `awaitExternal` 步即置 `awaiting-human` —— 行判据**不结算本步**、投递暂停、看门狗不插手，但**计时器照跑**；`mud_captcha` 的工具结果回来后壳侧 `resumeHuman()` 回到 `awaiting-result`（计时器继续、不重布防）并发布**拍 2**。
4. **`retry` 定稿** `{ attempts, on?, action? }`：`attempts` = **总尝试次数（含首次）**；`on` 缺省 `['driver']`（fullme 显式写 `['fail']` —— "答错重来"）；命中 `on` 里的判据时**在原步内重试** —— 投 `action`（缺省重发本步动作）、清空本步 `awaitExternal` 的槽值、把命中行原文写进 `{lastFail}`，**不重置本步预算**；`attempts` 用尽才算失败。**重试来源有 driver 与 fail 两种**（§19.2 类序 ①/②）。
5. **两拍发布**：槽一次只放**一条真能发的调用** —— 拍 1 = `retry.action`（重新取图），其结果回来时发布拍 2 = 本步动作；无前置且等人工的步由壳在外部值就位时发布拍 2。
6. **`mud_captcha` 工具**（所有档位可见）：地址围栏（只允许 pkuxkx.net）→ 抓 `robot.php` → 取 `<img src>` → 归一为绝对地址 → 推前台弹窗（payload 带 `note` = 失败原文）→ **ask-human：在途挂起等人工提交**（中止/兜底超时 = `ok:false`）→ 返回 `{ok, note 含码}`（复用 `network/captcha.ts`）。
7. **退役**：`fullme:request`/`fullme:prompt`/`fullme:done` 三条规则（§16）；取图职责从运行时 `sink.captcha` 迁到 `mud_captcha`；`Config.captchaPatterns` / `extractCaptchaUrl` 一并退役。
8. **判据文案 `why?`**（小项）：`FlowMatch` 可带 `why`，只影响日志/决策文案 —— 让 `stale` 的收束写成"放弃上一轮 → 本轮作废"而不是"命中失败判据 GA"。

## 人工环节与取图职责

- **ask-human 同回合提问**（对齐官方 `ApprovalService.request` 语义；机制全文见 §19.3）：`prompt` 步的 `mud_captcha` 推图后**工具不返回**（在途挂起 → 回合保持打开），人工提交的码作为**工具结果**回管线 → `answer` 动作随该结果进入**同一回合**（不再"人工等待收束回合、回填开新回合"）。弹窗**只收图片里的码**（§19.3 人工只负责提供值；`halt`/`fullme` 序列仍归流程动作声明）。**不做 OCR**（pkuxkx 明确要求人工）。
- **fail-closed 三出口**（工具结果 `ok:false` → 所在步失败收束，不悬挂）：① 弹窗"中止" → `captchaAbort` RPC → waiter 直接失败结束；② 每次提问的等待兜底 `CAPTCHA_WAIT_MS = 175_000`（`session.ts` 常量，**不给模型看、非 Config 字段**，先于步预算结算；步预算 180s 仍是硬上界）；③ 流程结束 / 断线 / 会话释放（等待作废）。
- **取图职责分界**：**工具** `mud_captcha` 负责"出站围栏 + 抓 `robot.php` + 取 `<img src>` + 归一为绝对地址 + 推弹窗 + 在途等人工提交"（`network/captcha.ts` 的 `resolveCaptchaImage`），提交/中止/超时都体现为工具结果 `{ok, note 含码}`/`{ok:false}`；**宿主**（WebUI）负责弹窗交互（输入码 / 刷新 / 中止）并登记 `robotUrl → imageUrl`（供 `/mud/captcha/refresh` 刷新）。运行时只管"收口 + 复判 + 槽插值 + 计时"。
- **测试**：`tests/flow-fullme.spec.ts`（声明面/校验/入口翻转，12 例）+ `tests/runtime-captcha.spec.ts`（真链路端到端：提醒行 → 取图 → 人工 → `halt` + `fullme <码>`）。
