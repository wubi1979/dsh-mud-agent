# mud-core2 计划起草区

> **文件角色**：mud-core2 的新计划在此起草；不作为长期事实来源。计划落地后同步到 `doc/architecture/` 对应章节文件并登记 `CHANGELOG`（基线完成前不登记），随后删除本文件中对应内容。
>
> 编号约定：本文件自身小节写 `1.1` / `第 3 章`；引用现行设计一律写 `§N`（§号属于 `doc/ARCHITECTURE.md` 章节地图）。交付切片暂用 `P*` 编号。

***

## P2 修订 v2：装配绑定改走官方 preset 通道（现行宿主机制）

> **状态：已冻结（2026-09-27）——可作实施依据**。已裁决：① 完全采用现行官方 preset 机制（不保留旧装配代码）；② v1 `packages/mud-core` 退役、`dev:web` 下线，mud-core2 为唯一生产路径；③ 新会话默认 `mud-player`。第 3 章核实项全部核销（含 3 项现场实测），无遗留待实测。
> 取材：2026-09-27 对现行宿主检出的机制核对与实测（见 1.1、第 3 章），取代 `doc/DISCUSS.md` 的 P2 D1/D6。

### 第 1 章 背景与决策

#### 1.1 背景（全部为实测事实）

1. **绑定不可用**：官方 WebUI「新建会话」不指定 sessionId，宿主自造 `session-<uuid>`（`api/session-controller/src/commands.ts:109`）；P2 D1 的 `rootSessionId` 硬绑定导致官方 UI 流程永远造不出被装配的会话。
2. **宿主 preset 机制已换代**（实测：`cd D:/Code/deepseek-harness; pnpm dsh web --dump-config`，即 `dev:core2` 的同一入口）：
   - registry 行 `id: agent-preset-registry`（`name: '@deepseek-ai/dsh-agent-preset-registry'`），config 仅 `{default, selectedDefault}`，**无 `roots` 字段**（`packages/preset/agent-preset-registry/src/index.ts:53-56`）；
   - preset 由行内联声明：`id: preset-<name>` / `name: '@deepseek-ai/dsh-agent-preset'` / `config.{id,name,description,order,plugins}`（`packages/bundle/web-app/presets/*.patch.yml`、`packages/preset/agent-preset/src/index.ts:16-29`）；
   - 旧机制（`@deepseek-ai/dsh-agent-presets` 包、`roots` + `trust`、`presets/<id>/preset.yml`、`agent.cordis.yml` 目录发现）在现检出中**不存在**。
   - 注意：`pnpm exec dsh` 会命中**全局已发布的 dsh**（仍是旧机制），不代表部署真相；必须用 `pnpm dsh`（= `node --import tsx/esm apps/cli/src/bin.ts`）。
3. **子级继承有官方保障**：`agentPresets.composeFrom(childCtx, parent.ctx)`（`packages/preset/agent-preset-registry/src/index.ts:273`）把子级挂到父级同一 preset 代际（`packages/subagent/subagent/src/child-agent.ts:205`）；子级读到继承 preset（`registry.spec.ts:92-99`）。
4. **工具与 persona 的官方承载 = preset 的 `config.plugins` 行**（出厂 preset 的 standard/ptc/minimal/cordis 一律如此）。preset 作用域每个 revision 只挂载一次、全 preset 共享（`agent-preset-registry/src/index.ts:102-118`、`mount.ts:26-29`），且子级加入同一代际 ⇒ **preset 里注册的工具与 section 对根与子级同样可见**。
5. **到期 interrupt 的参数源**：宿主对 `{kind:'user', parentSessionId}` 的校验正是子级 `session.header.parentSession`（`subagent/src/continuation-activation.ts:306-312`、`types.ts:65-67`）——取"子级自己的直接父会话"即合法，无需配置根。

#### 1.2 决策修订（P2 D1–D6 → v2）

| 决策 | 修订 | 说明 |
|---|---|---|
| D1 会话绑定 | **废弃 → preset 绑定** | 「用了 `mud-player` preset」即归属门：`ctx.get('agentPresets')?.composedPreset(agent.ctx) === 'mud-player'`（`agent-preset-registry/src/index.ts:290`）；config 删 `rootSessionId` |
| D2 depthOf | 不变 | `session.header.delegationDepth` 权威，`options.subagentDepth` 兜底；根 ⇔ depth === 0 |
| D3 到期 interrupt | **参数源变更** | `parentSessionId` 取自子级 `session.header.parentSession`（即 1.1-5 的合法形态） |
| D4 构建产物加载 | 不变（路径改写） | patch 行 `name` 一律用**绝对** `file:///D:/Code/dsh-mud-agent/packages/mud-core2/lib/*.js`；相对名会按 **patch 文件所在目录**解析（`packages/boot/app-boot/src/config-schema/document.ts:14`），`../../lib/**` 会指到包外 |
| D5 唤醒署名 | 不变 | `kind:'plugin', plugin:'mud-core2'` |
| D6 persona 承载 | **改为 preset 行注册** | 官方位置与 `@deepseek-ai/dsh-persona` 同层；**子级同样可见**（1.1-4），身份纠正由官方 `subagent:delegation` 运行时上下文承担（`child-agent.ts:172-176, 206-210`）。原「只进根」理由作废，§9.2 同步改写 |
| **D7（新增）单根守卫** | 新增 | `default: mud-player` 之下所有新会话都是候选根，而连接/Wake/预算是单例（`src/index.ts:74-76, 80-81, 141-152`）。首个命中根独占；后续命中根 **fail-loud 留痕**，其工具调用返回可读拒绝（不静默、不抢占） |
| **D8（新增）工具注册面** | 新增 | 三工具由 preset 行在 **preset 作用域**注册一次；`holder` 改为**调用期**由 `exec.agent` 推出（宿主 `ToolExecutionInput.agent`，`core/tools/src/index.ts:339`） |

**非目标**：不做"建用户时自动创建指定 sessionId"的会话 provisioning（本轮只走 preset 绑定）；不做 v1 `mud-core` 的功能迁移（退役，见第 5 章）；不做深度 ≥2 的专门拓扑；不动 P1（预案档）。

### 第 2 章 改动清单

1. **`packages/mud-core2/cordis.patch.yml`**（全部为顶层条目，覆盖 + 插入；引擎行在前，保证服务先就绪）
   - 覆盖 registry 行（**不覆盖则新会话仍是 standard**）：
     ```yaml
     - id: agent-preset-registry
       config: { default: mud-player }
     ```
   - 插入 preset 行：`- id: preset-mud-player` / `name: '@deepseek-ai/dsh-agent-preset'` / `config.{id: mud-player, name: MUD 玩家, description: …, order: 40, plugins: [...]}`；`plugins` = `packages/bundle/web-app/presets/standard.patch.yml` 的 `config.plugins` **逐条副本** + 末尾追加本包工具行（`name: 'file:///D:/Code/dsh-mud-agent/packages/mud-core2/lib/preset.js'`）。
   - 插入引擎行：`- id: mud-core2`（保留全局作用域），config 删 `rootSessionId`，其余（connect/creds/corpusPath/缺省刻度）不变。
2. **新增 `src/preset.ts`（产物 `lib/preset.js`）**：preset 行 apply（`inject: ['tools', 'systemPrompt']`）——
   - 注册三工具（preset 作用域；执行期按 `exec.agent` 解析 holder，见 D8 与第 2 章第 4 条）；
   - 注册 `mud:persona` section（段名/段序沿用 `persona.ts`，与 `deployment:persona-prefix/suffix` 不冲突）；
   - **不**在注册期依赖引擎：执行期 `ctx.get('mudCore2')`（可选服务）取单例；引擎缺席时注册照常、执行给可读拒绝（v1 同款先例，`mud-core/tests/preset-agent.spec.ts:205-213`；满足 I9——拒绝理由可读，不是必然失败的桩）。
3. **`src/index.ts` 改造**
   - 删 `belongs` / `rootSessionId`；归属门改 `composedPreset(...) === 'mud-player'`；
   - 根判定 = `depthOf(agent) === 0`，Wake/persona 换绑逻辑保持（persona 注册点移出，见第 2 条）；
   - 新增 D7 单根守卫与留痕；
   - `interruptAgent` 的 `parentSessionId` 取子级 `session.header.parentSession`；
   - `session/disposed` 断连判据从 `cfg.rootSessionId` 改为「根 agent 会话」（Wake owner / 根登记），避免删字段后失承载（§19「连接随会话」）；
   - `ctx.provide('mudCore2', …)` 暴露 preset 行需要的窄面（单例 + gate/budget 句柄）。
4. **`src/tools/tools.ts`**：`MudToolDeps.holder` → `holderOf(agent): Holder`；`execute(args, exec)` 窄面补 `agent?`；禁发表判据（现 `:288-291`）与 `holder` 透传（现 `:354`）改调用期解析。`src/subagent/subagent.ts` 的 `handleCreated` 相应拆分为「preset 侧工具注册」与「引擎侧预算登记」，注册完整性自检（现 `:226-236`）迁到 preset 侧。
5. **`src/config.ts`**：删 `rootSessionId` 校验；其余不变（fail-loud 纪律保持）。
6. **测试**：`test/index.spec.ts` 判定改造（composedPreset / 单根守卫 / session-disposed）；新增 `test/preset.spec.ts`（preset 行注册三工具、调用期 holder：根放行 / 子级拒 `suicide`·`quit` 类、引擎缺席可读拒绝）；新增 interrupt 参数源用例。
7. **漂移守卫**：比对「本包 patch 里 `preset-mud-player.config.plugins`」与「`D:/code/deepseek-harness/packages/bundle/web-app/presets/standard.patch.yml` 的 `config.plugins`」逐条一致、只多本包一行；**路径不存在即失败**（不得沿用 v1 的 `skipIf(!existsSync)` 空跑守卫）。
8. **设计文档同步**（按 §号逐条，不是只改新增段）：
   - §3.3（`00-core.md:119-158`）：文件映射加 `src/preset.ts`；承载表"思考"行 persona 措辞；
   - §9.2（`07-09-t2-wake.md:85-96`）：persona 可见面 = preset 作用域，子级同见；
   - §10.4（`10-13:31-35`）：工具承载 = preset 行 + 调用期 holder；§11（`:45`）预算登记保留但补"归属门 = preset"；§12.1（`:56-72`）holder 判据来源；
   - **悬空引用**：`agent.cordis.yml:180-186`（`00-core.md:96`、`10-13:17`）改指 `packages/bundle/web-app/presets/standard.patch.yml` 的 delegation 段；
   - §17/§18/§19（`17-19:18, 43-47, 49-58, 100`）：工具可见面验收口径、开工前置 2、步 5/6 依赖列、连接生命周期 + 单根守卫；
   - §0 增一条"宿主引用随 harness 换代整批复核"（已证 `agent-loop/agent.ts:631`、`continuation-activation.ts:881` 投递词两处漂移）；
   - §2 术语表补"归属门 / 单根"（可选）；
   - 基线完成前 CHANGELOG 不登记；本文件内容在落地后删除。
9. **注释与文件头同步**（C7：本轮改动的每个文件逐句对表）：`src/index.ts:1-25, 106, 126-127, 164-165`；`src/subagent/subagent.ts:21-24, 184-197, 226-236`；`src/tools/tools.ts:47-49`；`cordis.patch.yml:1-10` 头注释（现仍写"同 v1 mud-core 的 dev 启动方式"）。
10. **依赖与版本**：`package.json` 增 type-only 依赖 `@deepseek-ai/dsh-agent-preset-registry`（提供 `ctx.agentPresets` 的声明合并）；peer 版本按部署宿主抬齐（现 `^0.1.5-rc.2` vs 宿主 **0.1.7-rc.2**）。
11. **测试入口**：根 `package.json` 的 `test`（现只 `--filter @deepseek-ai/dsh-mud-core`）改为覆盖 mud-core2（v1 退役后 core2 是唯一生产路径）。

### 第 3 章 待核实（实施第一步）

**全部核销（2026-09-27）——无遗留待实测。**

源码/结构类：
- [x] registry 行 id 与 config schema（1.1-2）；`roots` 字段不存在。
- [x] 子级组合继承（1.1-3，`composeFrom` + `child-agent.ts:205`）。
- [x] `mud:persona` 与 `@deepseek-ai/dsh-persona` 段名不冲突（`deployment:persona-prefix` / `deployment:persona-suffix`）。
- [x] patch 内 preset 行的语法合法性（探针 overlay 经 `--dump-config-schema` 被列为一等 entry，宿主接受 `preset-mud-player` 行）。

现场实测（宿主检出；`pnpm exec vitest run <file>`）：
- [x] **`composedPreset(agent.ctx)` 在 `agent/created` 时刻可读**——在宿主平面注册的 `agent/created` 监听器内读到 `'mud-player'`（临时探针 spec，2/2 通过；跑完即删，宿主检出无残留）。
- [x] **preset 行在 apply 期与 execute 期都能读到宿主平面服务**——同一探针里 `ctx.get('probeHost')` 两期均命中（`apply:host/exec:host`）⇒ 引擎侧 `ctx.provide('mudCore2', …)` + preset 行执行期 `ctx.get` 的通路成立。
- [x] **子级继承 preset 注册的工具与 section**——宿主持有测试 `packages/subagent/subagent-in-process-driver/tests/preset-inheritance.spec.ts` 5/5 通过：子级 `system/message` 含 preset 行注册的 section、工具面 = preset 工具、子级 header 记录 `agentPreset`。

结论：1.1-4 的推论（preset 注册的 section 对子级同样可见）被实测证实；`mud:persona` 的子级可见性属既定裁决（D6），其**行为层**影响并入第 4 章闸门 4 的实连观察项，不作阻塞。

### 第 4 章 验证闸门

1. `pnpm exec tsc -p tsconfig.test.json --noEmit` + `pnpm exec vitest run test` 全绿（基线：16 文件 / 196 例）；
2. `pnpm --filter mud-core2 build` 出 `lib/index.js` 与 `lib/preset.js`；
3. **装配结构闸门（可先于实现跑）**：`cd D:/Code/deepseek-harness; pnpm dsh web --dump-config --patch D:/Code/dsh-mud-agent/packages/mud-core2/cordis.patch.yml` → 断言 `agent-preset-registry.config.default: mud-player` 与 `preset-mud-player` 行存在，且无 `patch: entry not found` 警告（禁用 `pnpm exec dsh`，见 1.1-2）；
4. 实连复验：`pnpm dev:core2` 起 WebUI → 新建会话（默认即 mud-player）→ 三工具 + persona 可见面 → 非 mud 会话对照 → 派子级确认继承、静态禁发表命中、结算回根；**并观察子级 persona 的实际影响**（D6 的行为层验证，不阻塞）。
5. **退役面自检**：`grep -rn "dev:web\|agent-presets\|rootSessionId" packages doc README.md package.json` 只应命中退役/历史说明文本，不应命中任何可执行路径。

### 第 5 章 退役与收尾（v1 / 仓面 / 计划自身）

1. **v1 `packages/mud-core` 退役**：代码留存不删、停止维护；`packages/mud-core/cordis.patch.yml`（`agent-presets` 覆盖）与 `presets/` 不再作为部署路径——该行在现宿主不存在，patch 只会得到 `patch: entry not found`；
2. **清掉空跑守卫**：`packages/mud-core/tests/preset-agent.spec.ts:293` 的 `HARNESS_STANDARD` 路径已不存在、配 `skipIf` 后恒为绿，须删除或改为显式退役标记（不允许"看起来在守、实际没跑"）；
3. **脚本与门面**：根 `package.json` 的 `dev:web` 下线；`dev:core2` 升为唯一入口；仓根 `README.md` 的 v1 部署段（`:32-33`、`:65`）改为"mud-core 已退役 → mud-core2"薄指针；
4. **`doc/DISCUSS.md`**：P2 标 `superseded by doc/PLAN.md「P2 修订 v2」`（D1/D6 及 `rootSessionId` 相关条目作废）；P1（预案档）保持原状、不动；
5. **本文件**：实施完成后删除本 P2 修订内容；`CHANGELOG` 在基线（§18 八步）完成前不登记。
