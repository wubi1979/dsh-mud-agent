# mud-core v5 清理计划（待实施）

> 状态：**仅记录，未实施**（用户指令：先不实施，计划落盘到 core 根目录）。
> 记录日期：2026-09-07 会话。
> 依据：用户逐条确认的决定（见文末「已确认决定」）。

## 目标架构（清理后）

- **路径 A（标准 LLM）**：DSH agent 会话。MUD 信息以 user/message 直接提交（`sendGameOutput`），全程标准 agent 流程。`agent-bridge.ts` + `tools.ts` + `execution.ts` 保留。
- **路径 B（触发器模拟 LLM）**：感知触发器命中 → lite marker → `mud-trigger` 假 provider → 官方工具管道。`trigger-llm/*` 五文件**完整保留**。
- **感知层**：`ansi.ts`（迁入）+ `perception.ts` + `triggers.ts` + `config/trigger-rules.ts` 保留；`transcript.ts` / `lite-capture.ts` 删除。
- **删除全部"第三条路径"**：dispatcher / decision / flow / decision-rules / flows 及其 spec。
- login 重建为"触发器 → lite 假 LLM"：**实现留待清理完成后另议**。

## 一、目录与文件迁移

1. `src/net/` → `src/network/`：`telnet.ts`、`ws.ts`、`captcha.ts` 移入 `src/network/`
2. `ansi.ts` → `src/perception/ansi.ts`（预处理层归位）
3. 全部 import 更新（src + tests）：`../net/ansi.ts` → `../perception/ansi.ts` 等；package.json `./src/*` 通配导出自动覆盖，无额外改动
4. **类型归位**（因 events.ts / shell-bridge.ts 删除）：
   - `MudPerceptEvent` + `makePerceptEvent` + `mud/percept` 通道声明 → `perception/triggers.ts`（触发器即发布者）
   - `MudGmcpEvent` + `makeGmcpEvent` → `world/state.ts`（GMCP 归属；**保留** mud/gmcp 发射——"GMCP 走类触发器通道、后续统一 llm 通道"方向）
   - `MudWorldSnapshot` → `client/wire.ts`（wire 已 re-export 它；ws/index/service 改 import 源）
   - `MudSystemEvent` / `makeSystemEvent` / `mud/system` 通道 → **删除**（login 重建为 lite 后无系统事件驱动）

## 二、删除文件

| 文件 | 理由 |
|---|---|
| `src/perception/transcript.ts` | 废弃（折叠注入机制，非标准 agent 流程） |
| `src/perception/lite-capture.ts` | 删除，触发器直接进 B 路径（触发机制重构下一阶段做） |
| `src/events.ts` | 类型归位后删除 |
| `src/shell-bridge.ts` | MudWorldSnapshot 迁出后删除（TUI 事件类型废弃） |
| `src/agent/dispatcher.ts` | 第三条路径（规则路由） |
| `src/agent/decision.ts` | 规则引擎 |
| `src/agent/flow.ts` | 流程状态机 |
| `src/config/decision-rules.ts` | 规则表 |
| `src/config/flows.ts` | login/fullme 流程定义（login 重建为 lite） |
| `src/config/commands.ts` 中 `getCommand()` / `commandsTextList()` | 零引用死导出 |
| `src/index.ts` 中 `ocrCaptcha` 赝品 | no-op 赝品 |
| `src/invariant.ts` 英文注释 → 中文 | 已确认（`./invariant` 导出保留） |

**同步删除 spec**（16 spec → 剩 10）：
`transcript.spec.ts`、`lite-capture.spec.ts`、`lite-capture-e2e.spec.ts`、`dispatcher.spec.ts`、`decision.spec.ts`、`flow.spec.ts`
保留：`ansi / captcha / execution / multiline / perception / telnet / tools / trigger-lite / world / ws`

## 三、index.ts 重组（宿主装配）

**删除/移除**：
- transcript 注入链：`injector` / `injectTimer` / `INJECT_IDLE_MS` / `TRANSCRIPT_MIN_LINES` import、`feedParsed` 注入分支、`handleInjection`、忙时合并桶（`agentBusy` / `pendingInjection` / `pumpPendingInjection`）
- dispatcher 装配（`DecisionCenter` / `executeRule` / `emitRuleDecision` / `onRoute` / `ruleDedupMs`）+ `mud/percept` → center 订阅改为纯触发管道 + `mud/system` 订阅与发射（login:required）
- flow 装配（`FlowService` / `defaultFlows` / `flow.start` / `flow.abort('login')` / `loginHost` / `fullmeHost`）
- `LiteCapture` + `sendLite` 装配（`ctx.inject(['llm'])` 内**保留** `TriggerRouter` 装配；战斗 halt / 战后 look 反射暂悬空，待触发机制重构）
- `ocrCaptcha` + `void ocrCaptcha(...)` 调用
- `MudSystemEvent` / `makeSystemEvent` import

**保留/调整**：
- `TriggerRouter` 装配（路径 B 核心，`ctx.inject(['llm'])` 延迟装配不变）
- `agent-bridge`（A 路径）+ `tools` / `execution`（`buildMudTools` / `CommandQueue` / `renderTemplate`）
- `PerceptionDriver` / `buffer` / `TriggerService` / `StateService` / `skillService` / WS / HTTP / 连接逻辑
- A 路径输入：游戏输出（解析行文本）直接经 `sendGameOutput` 以 user/message 提交（标准 agent 流程；守卫：agent 就绪 + logged_in + agentEnabled）。提交节奏（逐行/批量/登录期暂缓）**留待清理后确认**（可能并入 login 重建讨论）
- `requestAgent`（断流/登录失败主动唤醒）保留，简化为不经忙时桶的直接提交

## 四、service.ts 接口更新

`ctx.mud` 去掉 `dispatcher`、`flow` 成员；`trigger` / `state` / `skill` / `tools` / `connection` / `status` 保留。

## 五、注释与文档同步

- `tools.ts` / `execution.ts` / `perception.ts` 文件头提到"规则(轻量处理器)"、"转交 transcript.ts"的旧叙述 → 更新为 v5 后语义
- `agent-bridge.ts` 头注"规则系统先于 agent"提法 → 更新（无规则引擎了）
- README / cordis.patch.yml 中 dispatcher/flow/规则相关提法 → 同步（可选，最小改动）

## 六、回归

1. `pnpm --filter @deepseek-ai/dsh-mud-core build` → EXIT=0
2. 全量 vitest（10 spec）→ 全绿
3. 核对：src 无 `events.ts` / `shell-bridge.ts` / `transcript` / `lite-capture` / `dispatcher` / `flow` / `decision-rules` 引用残留；`network/` 与 `perception/ansi.ts` 存在

## 七、明确不做（后续阶段）

- **login 重建为"触发器 → lite 假 LLM"**：实现细节（触发器规则如何携带 lite 动作、登录触发规则接 B 路径、fullme 处理）清理完后再议
- **触发器携带 lite 动作的触发机制重构**（LiteCapture 删除后的替代接线）
- **skills 内容/文件拆分**（已确认保留，但"内容和文件拆分可能有问题" → 留后）
- **A 路径提交节奏细节**

---

## 已确认决定（用户逐条）

1. `net` 目录 → `network`；`ansi.ts` 属于**预处理层** → 移入 `src/perception/`
2. `transcript.ts` 废弃删除；感知只由触发器产生，触发器产生的直接进 **B 路径**
3. `perception/lite-capture.ts` → **删除**（意义不明；触发器直接进 B 路径，连同其 spec）
4. `trigger-llm` 组（router/adapter/marker/types/index）**完整保留，不动**
5. `agent/skills.ts` **保留**（预设 skill 加载 + 运行中沉淀动态 skill 的设计；内容/文件拆分可能有问题，留后）；`config/skills.ts` 同步保留
6. dispatcher/decision/decision-rules /**flow 及 config/flows** → 按建议删除（login 重建为 lite 后 flow 不再需要）
7. `events.ts`、`shell-bridge.ts` → **删除**（类型归位）
8. A 路径：**"不存在注入不注入，就是将 MUD 信息当作 user/message 提交，全程标准 agent 流程"** → transcript/折叠/忙时桶等特殊注入机制全部移除
9. login 重建为 **触发器 → lite 假 LLM**；若实现方法不确定，留待清理完成后提问
10. `invariant.ts`：保留输出，注释翻译为中文
11. `mud/gmcp`：保留通道（类似触发器通道，后续实现走统一 llm 通道）
12. 测试专用公共 API（`Perceptor`、`skills.register/list/get/unregister`、`CommandQueue.clear/stats`、`FlowService.status`）：保留但标注 test-only（注：`FlowService` 已随 flow 删除而删除；其余保留并标注）