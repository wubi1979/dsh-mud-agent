# mud-core v6 重构记录

> 状态：**已实施**（2026-09-08 会话）。
> 依据：用户逐条确认的 v6 决定（历史记录）。
> 实施结果：build EXIT=0；8 spec / 71 用例全绿（ansi / captcha / execution /
> multiline / telnet / tools / world / ws）；`src/perception/` 与
> `trigger-llm/{marker,router}.ts` 已删除。

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

## 一、结构与文件变更

| 变更 | 文件 |
|---|---|
| 移动 | `src/perception/ansi.ts` → `src/preprocess/ansi.ts` |
| 新增 | `src/preprocess/index.ts`（薄入口: re-export ansi + `textOfLines`） |
| 重建 | `src/trigger-llm/{types,service,adapter,index}.ts`（v6 语义） |
| 精简 | `src/world/state.ts`（GMCP-only；删事件总线/感知订阅） |
| 删除 | `src/perception/` 整目录、`trigger-llm/{marker,router}.ts`、`tests/{perception,trigger-lite}.spec.ts` |
| 更新 | `index.ts`、`service.ts`、`network/telnet.ts`、`config/trigger-rules.ts`、`agent/{agent-bridge,tools}.ts`、`tests/{ansi,multiline}.spec.ts` |

## 二、核心设计

### 触发器模型（trigger-llm/types.ts）
- `PerceptionRule` = 捕获字段（contains/regex/color/guard/extract，语义不变）
  + **`action?: ActionSpec`**（确定性动作）。
- `ActionSpec { output: string; tool?: { name, args }; send?: 直连 }`。
- `PerceptHit` 新增可选 `action?: ActionSpec`（命中时由 Perceptor 携带规则动作）。
- 无事件、无组、无进程状态机（多行状态机保留，Mudlet 逐条件模型）。

### 触发服务（trigger-llm/service.ts）
- `Perceptor`：从 `perception/triggers.ts` 迁入，匹配器逻辑不变。
- `TriggerService`（`ctx.mud.trigger`）：净化版
  - 无事件总线、无 publish；
  - `matchText(text)`：整批文本入口 → 拆临时行（单调 abs，无 style）→ 匹配；
  - 纯匹配器不负责去重（去重在 adapter 层，内容级）。

### 级联适配层（trigger-llm/adapter.ts + agent-bridge.ts）
- `TriggerLlmAdapter extends LlmAdapter`：`stream()` 分支
  1. aborted → 直接结束；
  2. `mimicEnabled()` 为 false → 直接 `forward`（T1 完全跳过）；
  3. 提取尾部 user 文本（排除 tool-result）→ 与 `lastMatchedText` 相同
     （内容级去重）→ 空 finish(stop)；
  4. `matchLines(text)` 命中 → 渲染全部动作（逐条 text 块 + tool-call 块），
     多工具 finish 'tool-calls'，否则 'stop'；
  5. 未命中且 `realAllowed()` → `forward`；否则空 finish(stop)；
  6. 未命中且 realAllowed → `forward(options)`。
- `registerCascadeProvider(ctx, { trigger, world, mimicEnabled, realAllowed, log })`：
  - 幂等（`cascadeRegistration` 单例保存 disposer）；
  - `ctx.llm.registerAdapter(['mud-cascade'], adapter)`；
  - `forward`：读 `agentDefaultModel.currentSelection()` → `ctx.llm.prepareCall({provider, model})` → spread 重建 options 替换真实 provider/model → `prepared.stream(rebuilt)`。

### 装配（agent-bridge.ts createMudAgent）
- `agentOptions = { provider: 'mud-cascade', model: 'cascade-v1' }`（固定）。
- **不再 `installModelSelection`**（级联 adapter 自行转发真实模型）。

### 状态捕获（world/state.ts）
- 删：`mud/percept` 订阅、`patchForPercept`、`MudGmcpEvent`/`makeGmcpEvent`/
  `mud/gmcp` 声明、`publishGmcp`、`bus`。
- 保留：`StateService(StateServiceOptions{world, onChanged})` + `onGmcp` 直连。

### 宿主装配（index.ts）
- 删除：`PerceptionBuffer`/`PerceptionDriver`/`MAX_PENDING_LINES`/`TriggerRouter`
  inject 块/`mud/percept` 订阅。
- `feedParsed(lines)`：`resetDeadAir()` + `pushToAgent(textOfLines(lines))`。
- `pushToAgent`：移除登录守卫（v6 全部文本统一进 agent）。
- `mimic` config（默认 true）；`ctx.mud.setMimicEnabled()` 运行时切换。
- `ctx.inject(['llm'])` 内注册级联 provider（幂等），卸载时 `disposeCascadeProvider()`。

### 工具（agent/tools.ts）
- 新增 `world_patch`：`patch` 对象 → `applyPatch(world, patch)` → 返回变更字段。
- 构建时注入 `world`（index.ts 传入）。

### 配置规则（config/trigger-rules.ts）
- 状态类规则（combat:start/end、death）action → `world_patch`；
- `save:prompt` action → `mud_send save`；
- `room:busy` 无 action（观察类，命中不动作）。

## 三、明确不做（后续）
- **send 防御直连**：ActionSpec.send 字段保留但 adapter 不消费，agent-bridge
  后续再议。
- **颜色规则**：`matchText` 临时行无 style，颜色条件在纯文本输入下不满足
  （v6 配置无颜色规则在用；带 style 的显式 `Perceptor.match` 路径保留）。
- **断流计时登录守卫**：armDeadAir 保留 `!world.flags.logged_in` 抑制（登录期
  不自动唤醒做额外动作）。

## 四、回归
1. `pnpm --filter @deepseek-ai/dsh-mud-core build` → EXIT=0
2. 全量 vitest（8 spec）→ 全绿（71 用例）
3. 核对：src/tests 无 `perception/` 导入残留（仅注释内提及历史路径）；
   `trigger-llm/{marker,router}.ts` 已删除。