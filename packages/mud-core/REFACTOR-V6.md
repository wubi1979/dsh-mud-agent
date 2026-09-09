# mud-core v6 重构记录

> 状态：**已实施**（2026-09-08 会话）。
> 依据：用户逐条确认的 v6 决定（历史记录）。
> 实施结果：build EXIT=0；9 spec / 81 用例全绿（ansi / captcha / cascade /
> execution / multiline / telnet / tools / world / ws）；`src/perception/` 与
> `trigger-llm/{marker,router}.ts` 已删除。

## V6.2 追加变更（本会话）

在 v6 单路径级联之上，将匹配功能抽离为独立服务（按用户 v6.2 设计确认）：

- **AnsiStreamParser 自分配行号**：`write()/flush()` 现在产出 `MudLine[]`
  （携带自分配递增 `abs`），不再由装配/适配层另行分配。行号游标归属解析器。
- **匹配服务分桶**：`TriggerService` → `TriggerMatchService`（独立实例）。
  `registerCascadeProvider` 按 `lane` 创建 state / event 两个实例：
  - `stateMatchService`：预匹配折叠（状态/观察 → world），命中行移除（不进 agent）；
  - `eventMatchService`：agent 内 T1 渲染（事件/决策 → 确定性动作），并缓存行供 T1 转发。
- **运行态与规则分离**：`MatchContext`（`multiStates` / `multiLastAbs`）从
  `NormalizedTriggerRule` 中拆出，由 `Perceptor.match(lines, ctx)` 传入；
  每个 TriggerMatchService 实例持有独立 `MatchContext`。
- **T1 输入改为标准行**：`TriggerLlmAdapterHooks.matchLines(lines: MudLine[])`；
  adapter 经 `getRecentLines()` 获取预处理层缓存的行；未命中转发时用
  `.map(l => l.text).join('\n')` 重建尾部 user 文本块（保留其余消息历史）。
- **预匹配折叠接线（index.ts feedParsed）**：
  1. `stateMatchService.match(lines)` → extract 产物 `applyPatch` 落库；
  2. 命中行按 `abs` 从行集移除（折叠：不进 agent）；
  3. 剩余行 `eventMatchService.feedLines(lines)` 缓存 + 整批文本进 agent。
- **规则配置不变**：state 通道规则（hp/score/look）action 保留（静默处理，
  后续可能有连带操作）；event 通道规则照旧。

改动文件：`preprocess/ansi.ts`、`trigger-llm/{types,service,adapter,index}.ts`、
`agent/agent-bridge.ts`、`index.ts`、`service.ts`、`config/trigger-rules.ts`（注释）、
`tests/{ansi,multiline,cascade}.spec.ts`；新增 `tests/match-service.spec.ts`
（双桶规则隔离 / feedLines 缓存 / 多行上下文独立 / resetContext）。

### v6.2 数据流

```
游戏输出 (telnet) → AnsiStreamParser (自分配 abs) → MudLine[]
  → feedParsed:
      stateMatchService.match(lines) → 命中 extract 落库 applyPatch → 命中行移除
      → eventMatchService.feedLines(剩余行)
      → pushToAgent(textOfLines(剩余行))   // 文本进 agent
  → agent → mud-cascade (T1? → 确定性动作; 未命中 → T2 用剩余行 .text 拼接转发)
```

### v6.2 已知未接线（与本会话决策相关）

- **stateMatchService.feedLines()**：暂整体注释未接（state 在 feedParsed 同步消费，
  无后续查找需求）。若未来 state 通道需要跨批上下文再补。
- **颜色折叠联动**：state 命中行折叠移除后，颜色类 state 规则（无文本模式）命中行
  同样移除（`abs` 是唯一判据），行为归一并在此记录。

## 目标架构（v6）

**单路径级联**：游戏文本统一进 agent，不再有"路径 A / 路径 B"双路径。

```
游戏输出 (telnet) → AnsiStreamParser 切完整逻辑行
  → 处理器: 断流计时复位 + 整批文本 (textOfLines) 提交 agent
  → agent → mud-cascade 级联 provider:
       T1 (确定性): trigger-llm 命中规则 → 渲染动作 (文本 + tool-call),
                     不调用真实 LLM (mimic 开关控制; 命中即幂等渲染)
       T2 (真实 LLM): 未命中 → 转发 agentDefaultModel 的真实 provider/model
  → 工具调用 (mud_move / mud_look / mud_status / mud_send / world_patch) → 游戏
GMCP 直连 (StateService.onGmcp) → 权威同步 world (置信度 1.0)
文本语义 → agent 用 world_patch 工具落库 (置信度 0.7, GMCP 优先)
```

## 一、结构与文件变更（v6）

| 变更 | 文件 |
|---|---|
| 移动 | `src/perception/ansi.ts` → `src/preprocess/ansi.ts` |
| 新增 | `src/preprocess/index.ts`（薄入口: re-export ansi + `textOfLines`） |
| 重建 | `src/trigger-llm/{types,service,adapter,index}.ts`（v6 → v6.2 语义） |
| 精简 | `src/world/state.ts`（GMCP-only；删事件总线/感知订阅） |
| 删除 | `src/perception/` 整目录、`trigger-llm/{marker,router}.ts`、`tests/{perception,trigger-lite}.spec.ts` |
| 更新 | `index.ts`、`service.ts`、`network/telnet.ts`、`config/trigger-rules.ts`、`agent/{agent-bridge,tools}.ts`、`tests/{ansi,multiline,cascade}.spec.ts` |

## 二、核心设计（v6 → v6.2）

### 触发器模型（trigger-llm/types.ts）
- `PerceptionRule` = 捕获字段（contains/regex/color/guard/extract，语义不变）
  + `action?: ActionSpec`（确定性动作）。
- `ActionSpec { output: string; tool?: { name, args }; send?: 直连 }`。
- `PerceptHit` 新增可选 `action?: ActionSpec`。
- 新增 `MatchContext`（多行运行态）+ `MultiMatchState`（v6.2；自 rules 拆出）。
- 无事件、无组、无进程状态机（多行状态机保留，谓词为逐条件模型）。

### 匹配服务（trigger-llm/service.ts）
- `Perceptor`：纯匹配器，`match(lines, ctx)`（v6.2 起运行态由 ctx 承载）。
- `TriggerMatchService`（v6.2）：独立实例，持有规则集 + `MatchContext` +
  `recentLines` 缓存；`feedLines(lines)` / `getRecentLines()`；
  入口 `match(lines)`（不带 ctx，内部自管）。`ctx.mud.{stateTrigger,eventTrigger}`。

### 级联适配层（trigger-llm/adapter.ts + agent-bridge.ts）
- `TriggerLlmAdapter extends LlmAdapter` 为**阶段行走器**（v6.3 瀑布数组）：
  每次调用重读 `stages()`（无热拔插），逐级：
  1. aborted → 直接结束；
  2. `trigger` 级：`getRecentLines()` 为空 → 交下一级；内容级去重
     （`linesToText` vs `lastMatchedText`）→ 重复即空 finish(stop)；`matchLines(lines)`
     命中 → 渲染全部动作并返回；未命中 → 交下一级；
  3. `model` 级（显式 provider/model）：`prepareCall` 拒绝，或首块为
     `finish{error|aborted}`（硬失败）→ 关迭代器交下一级；其余首块（含空 stop）
     commit 转发整流；空流（无 finish）→ 空 stop 提交防悬挂；
  4. 数组耗尽 → **尾部默认级**：`agentDefaultModel.currentSelection()`
     （DSH 默认配置），无选择 → 空 finish(stop)。
- 每个 model 级调用前重建尾部文本：最近行 `.text` 拼接替换最后一个文本承载 user
  消息（`replaceTailUserText` 内聚在 adapter，保留其余消息历史；无行时不重建）。
- `registerCascadeProvider(ctx, { stateRules, eventRules, world, log })`（v6.3 签名）：
  - 创建 state / event 两个 `TriggerMatchService`（不变）；
  - `ctx.llm.registerAdapter(['mud-cascade'], adapter)`（幂等，不变）；
  - hooks：`{ matchLines, getRecentLines, stages, llm, defaultSelection, onLog, onRender }`。
- 瀑布配置容器 = agent-bridge 模块级 `cascadeStages`（默认 `[{t1 trigger}]` + 尾部
  隐式 DSH 默认）；`setCascadeStages()` / `getCascadeStages()` 外部注入/重读。
- `stateMatchService` / `eventMatchService` 模块级导出（index.ts 访问做预匹配）。

### 装配（agent-bridge.ts createMudAgent）
- `agentOptions = { provider: 'mud-cascade', model: 'cascade-v1' }`（固定，不变）。
- 不再 `installModelSelection`（尾部默认级自行转发真实模型）。

### 状态捕获（world/state.ts）
- 删：`mud/percept` 订阅、`patchForPercept`、`MudGmcpEvent`/`makeGmcpEvent`/
  `mud/gmcp` 声明、`publishGmcp`、`bus`。
- 保留：`StateService(StateServiceOptions{world, onChanged})` + `onGmcp` 直连。

### 宿主装配（index.ts）
- 删除：`PerceptionBuffer`/`PerceptionDriver`/`MAX_PENDING_LINES`/`TriggerRouter`
  inject 块/`mud/percept` 订阅。
- `feedParsed(lines)`（v6.2）：state 预匹配折叠 + 命中行移除 + event 缓存 + 整批进 agent。
- `pushToAgent`：全部文本统一进 agent（登录期不作守卫）。
- `mimic` config 与 `ctx.mud.setMimicEnabled()` **已删除**（v6.3）；T1 开关改由瀑布
  数组的 `enabled` 表达，`config.cascade` 传入 `setCascadeStages()` 覆盖默认瀑布；
  完全不用真实 LLM = `agentEnabled:false`。
- `ctx.inject(['llm'])` 内注册级联 provider（幂等），卸载时 `disposeCascadeProvider()`。
  - v6.3 回归：tests/cascade.spec.ts 重写为阶段行走器用例（17 例）+ 其余 74 例，
    共 10 spec / 91 用例全绿；`pnpm -r build` 全绿。

### 工具（agent/tools.ts）
- 新增 `world_patch`：`patch` 对象 → `applyPatch(world, patch)` → 返回变更字段。
- 构建时注入 `world`（index.ts 传入）。

### 配置规则（config/trigger-rules.ts）
- 状态类规则（combat:start/end、death）action → `world_patch`；
- `save:prompt` action → `mud_send save`；
- `room:busy` 无 action（观察类，命中不动作）。
- v6.2：`lane: 'state'` 规则被预匹配折叠消费（action 暂保留，静默处理）。

## 二点五、v6.4 登录 T1（确定性登录 + 会话凭据插值）
- **凭据归属**：登录凭据与会话绑定（用户即会话）——`agent-bridge` 模块级
  `sessionCredentials: Map<sessionId, {name, pass}>`；`setSessionCredentials(sid, creds)`
  在 `connect({name, pass})` 时写入（index.ts），`getSessionCredentials(sid)` 读取，
  切换用户互不泄漏。不使用全局单项变量，也不落 world 点分键。
- **插值通道**：adapter 新增可选 `resolveToolArgs(args, sessionId)` 钩子（渲染 tool-call
  前解析）；bridge 注入 `interpolateCredentials()`，按 `options.sessionId` 取会话凭据替换
  `{name}`/`{pass}` 占位符；缺省（无钩子/无凭据）原样下发。adapter 保持不感知 world。
- **登录规则**（trigger-rules.ts，event 桶）：`login:name`（英文名字提示 → mud_send
  `{name}`）/ `login:replace-confirm`（同名覆盖 `(y/n)` → `y`）/ `login:pass`
  （请输入密码 → mud_send `{pass}`）/ `login:done`（欢迎横幅 → world_patch
  `logged_in:true`）。
- **中止语义**（对齐 DSH）：不新增限次/中止机制——T1 死局交棒尾部真实 LLM 后，
  失败终态由 DSH 自行兜底（`agent/request-error` 无接管者 → failure 终态、step 报错
  关 turn；真中止入口为 `agent.cancel({kind:'hook'})`，本轮不用）。
- 回归：`pnpm -r build` 全绿；vitest **10 spec / 93 用例**全绿（+2：resolveToolArgs
  插值 / 无钩子原样下发）。

## 二点六、v6.5 锚定整行正则 + 捕获组提取（准入/提取重构）
- **动机**：MUD 文本随处是聊天/帮助内容，宽松 `contains` 子串匹配极易误触发——
  把 `contains` 从准入语义中移除，匹配判据唯一收敛于 `regex`（作者自写首尾锚定
  `^…$`；行尾空白/变体由作者改正则，引擎不替文本归一）。
- **两段式匹配**（service.ts）：
  - 预筛（候选集）：由锚定正则**字面前缀自动推导 ** seed——`^字面…` → `{prefix}`，
    否则必需字面段 → `{substring}`；无字面前缀（纯元字符开头）全量跑。预筛是纯性能
    路径（超集），命中判定永远由二级正则承载；不变式 `Pr(命中 | 预筛跳过)=0`。
  - 准入+提取：锚定正则 `.test` → **首个匹配正则的命名捕获组** → `map`
    （捕获组名→world 点分键）组装 `hit.data`，`numeric` 数值化（去千分位逗号；
    解析失败省略该键）。`extract` 降级为**逃生舱**（二次颜色等复杂提取；存在时
    覆盖捕获组结果；常规规则禁用）。
- **多行**：`buildMultiConds` 只认 `patterns` 或 `regex`（contains 来源删除）；
  每条件逐行测试（Mudlet 状态机不变）；命中后各条件命名捕获组合并 → map。
- `PerceptionRule` 变更：删 `contains`；新增 `map?: Record<组名,点分键>`、
  `numeric?: readonly 组名[]`；`extract` 注释改为逃生舱。`Perceptor` 删
  `keywordIndex`/`candidates()`，换 seed 表。
- **trigger-rules.ts 迁移**：login 4 条全锚定（`login:name` 已按真实文本精确锚定；
  pass/done/replace 留近似，作者依真实文本修正）；state:hp/score 拆为**每字段一条
  规则**（捕获组+map 替代 parseVitals/parseScore 的 JS 提取）；`state:look` 因多行
  复合提取保留 extract 逃生舱；event 其余（combat/busy/death/save）锚定化并删除
  extract。parseVitals/parseScore 函数删除。
- 回归：`tsc -p tsconfig.json` 全绿；vitest **10 spec / 100 用例**全绿（+7：锚定首尾
  拒绝聊天/帮助、纯字面正则保持、捕获组+map/numeric 组装、逃生舱覆盖、无 map 纯
  action data=null、multiline 捕获合并、预筛超集不变式）。

## 二点七、v6.7 准入语义修正（架构审查会话）

- **动机**：`ruleHit` 旧回退 `return rule.color !== null || !!rule.extract` 使
  color/extract 在**主判据未命中**时仍准入，与"准入唯一判据 = match"矛盾：
  - `state:look`（func+extract）对批内**每行**都命中并运行窗口 extract → 任意
    非空行可被解析成 room.name/desc 污染 world（折叠集为空, 行照常进 agent,
    但 patch 已写坏）;
  - 带 color 的规则在文本未命中时被颜色**单独触发** → "同词异色"区分失效
    （同正则异色两条规则会对任意带色行同时命中）。
- **变更**（trigger-llm/service.ts `ruleHit` 合取语义）：
  `命中 = 主判据(regex/text/func) 命中 ∧ color(声明时, 补充判定 AND) ∧ guard`。
  color 只做命中后的颜色区分, extract 只做准入后的程序化提取 —— **二者绝不
  单独准入**。`PerceptHit.data` 仍在准入后由 `extract ?? 捕获组+map` 组装, 不变。
- **纯颜色触发形态**：match 仍必填（准入唯一判据）；需要"整行颜色触发"
  （Mudlet 对齐）时用 `match: { kind: 'func', test: () => true }` + fg/bg 表达
  （显式准入, 每行判色）—— 现有 ansi/multiline spec 即此形态, 语义不受影响。
- **回归**：`pnpm --filter @deepseek-ai/dsh-mud-core build` → EXIT=0；vitest
  match-service.spec.ts **+5**（regex miss+extract 不命中 / func+extract 仅锚点
  命中 / 同词异色各命中自己颜色 / color 是补充 AND 不单独准入 / 纯颜色触发不受
  影响）→ 全量 **10 spec / 114 用例**全绿。

## 三、明确不做（后续）
- **send 防御直连**：`ActionSpec.send` 字段保留但 adapter 不消费，agent-bridge
  后续再议。
- **state 折叠 color 联动**：颜色触发行折叠移除引导依赖 `abs`，若需颜色专属折叠
  序列需再议。
- **断流计时登录守卫**：armDeadAir 保留 `!world.flags.logged_in` 抑制（登录期
  不自动唤醒做额外动作）。

## 四、回归
1. `pnpm --filter @deepseek-ai/dsh-mud-core build` → EXIT=0；整仓 `pnpm -r build` → 全绿
2. 全量 vitest（10 spec，v6.2 新增 match-service.spec.ts）→ 全绿（85 用例）
3. 核对：src/tests 无 `perception/` 导入残留（仅注释内提及历史路径）；
   `trigger-llm/{marker,router}.ts` 已删除。