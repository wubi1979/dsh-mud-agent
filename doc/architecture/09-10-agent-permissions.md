---
sections: [9, 10]
status: active
deps: ["§1", "§3"]
impl: packages/mud-core/src/agents/preset.ts + services/gate/
---

## §9 agent 装配面：preset 化（旁路 A）

**目标**：MUD 工具 / 人设 / 技能由**官方 agent preset** 机制挂载，而不是宿主插件在 `agent/created` 里往别人的 agent ctx 上注册。

**机制事实**（已逐行核对 deepseek-harness）：

- `SessionCreateRequest.agentPreset` **host 侧已支持**（`api/session-controller/src/types.ts`、`commands.ts`），但浏览器 client 三层（contract / service / manager）未透传 → 需补 3 处（**harness 侧改动**）。
- 重启后 resume/adopt 按**会话内存储的 preset** 重新挂载；`assertPresetUnchanged` 仅在"请求 ≠ 存储"时抛冲突。
- preset 的 `agent.cordis.yml` 里"只注册工具/section、不 provide 服务"的行**无需 isolate realm**，且可 `ctx.get` 宿主服务。
- `agentPresets.composedPreset(agent.ctx)` 可用于判断该 agent 是否 mud preset → **L3 门控的官方判据**。
- preset 行支持 `file:///` 绝对路径；`agent-presets.Config.roots` 按 id 在 profile patch 覆盖追加。

**设计**：

1. `agents/preset.ts`（agent 平面插件行）：从 `ctx.get('mud').agentKit()` 取工具/人设/命令/skills，
   `ctx.tools.register(...)` + `systemPrompt.section(...)`；技能目录变化用**动态文本提供者**
   （`text: () => kit.skillsText()`，v8 已采用）而非 dispose/重注册。
2. `presets/mud-player/`：`preset.yml` + `agent.cordis.yml`（单行指向 `lib/agents/preset.js`）。
3. `package.json`：`exports` 增 `./preset-agent`；`files` 增 `presets`。
4. 页面：`sessions.create({ agentPreset: 'mud-player' })`（依赖 harness client 透传）。
5. profile patch：`agent-presets` 行追加 `roots: [{path: 'file:///…/mud-core/presets', trust: user}]`。

**迁移与风险**：

- 旧 MUD 用户（会话无存储 preset）→ `ApiSessionPresetConflict`；迁移方式：**删除旧用户后重新添加**。
- preset 行用绝对路径（与现有 bundle 行同一取舍）。
- 若 harness client 透传未就绪，W1/W2 可先用 v8 的宿主侧装配（`agent/created` + `agent.ctx` 注册）并保留 L3 回退门，preset 作为 W3 的替换。

**已实现（v0.3，方案 A1：部署根 + host 侧 `select`）**：

第 4 条（页面 `sessions.create({agentPreset})`）**不需要了** —— 官方 host 侧另有 `ctx.agentPresets.select(agent, id)`（`preset/agent-presets/src/index.ts` 的 `select` → `swap`），约束只是"会话尚未开过回合"（`agent-preset/locked`）。MUD 会话正好满足：页面 `sessions.create` → `POST /mud/bind` → agent materialize 时还没有任何投递。

| 项 | 落点 |
|---|---|
| preset 行（能力面） | `agents/preset.ts`：无 `inject`（宿主服务一律 `ctx.get`，挂载审计友好）；组装期注册全部工具声明 + **三段提示**（skills/tier/commands） |
| 会话人设（两条路径共有，**在 agent 作用域替换官方人设槽**） | `agents/mount.ts#attachMudPersona`：往 `deployment:persona-prefix` 写 MUD 人设、把 `deployment:persona-suffix` 置空，由宿主在 `attachPolicy` 里调用。**为什么不放 preset 行**：会话人设已有主人（部署 `personaPrefix` 与 standard 的 `persona` 行），自建区段只会并列（模型同时被告知"你是编码 agent"和"你是 MUD 玩家"），而**同名**替换在 preset 作用域会与 standard 行撞名抛错 —— 官方 `systemPrompt` 的作用域链是"最近作用域胜出"，per-agent 覆盖只能经 `agent.ctx` 注册。`tests/mud-persona.spec.ts` 用真实注册表复现 preset → agent 两级作用域并断言渲染结果里只剩 MUD 人设 |
| 组合文件 | `presets/mud-player/agent.cordis.yml`：**整份 `standard` 组装 + 我们的 `mud-agent` 行**（该行 `name: '../../lib/agents/preset.js'` —— **相对路径**，以 `.` 开头按 preset 目录解析）；`preset.yml`（展示名/描述） |
| 包出口 | `package.json`：`exports["./preset-agent"]` + `files` 增 `presets` |
| 会话侧数据源 | `ctx.mud.agentKit()`：`{ prompt, tools(sessionId), tierNote(sessionId), noteToolCall(sessionId,…) }` —— 共享组装与 per-session 状态（队列/桥/world/凭据）之间的唯一接法：工具声明共享，执行体按调用方 `agent.id` 解析 |
| 宿主装配路径 | `Config.agentPreset` 非空 = preset 路径：`attachToAgent` 只装**策略面**（选路 + 权限闸门 + 人设槽覆盖），能力面交给 preset；装配失败（服务缺失 / `agent-preset/not-found` / 会话已锁定）→ 日志留痕 + **回落宿主侧装配**（`mountHostCapability`：按档注册工具 + 提示区段） |
| 投递就绪门（关键） | `MudRuntimeSink.agentReady`：preset 模式下"agent 存在"≠"可以投递"。旧组装上跑第一批输出，既没有 MUD 工具、又让会话产出内容而**永久锁定 preset**。`settle()` 因此把"装配未就绪"与"无 live agent"同等对待（留待决，等冲刷）。就绪由**每会话标志** `capabilityReady` 判定 —— **preset 挂载成功**与**回落宿主侧装配完成**都会置位；只看 `composedPreset` 会在回落路径上永远判未就绪（实测：登录文本一直不投递，直到登录看门狗唤醒 agent）。新 agent 实例接入时先撤标志、装配落地后再置位 |
| 部署 | 两处都在本包 patch（见下方片段）：`agent-presets.roots` + `Config.agentPreset`；**profile patch 保持 `[]`** |

**preset = 整个组装（踩过的坑，务必先读）**：从 preset 组装的会话**只**运行该 `agent.cordis.yml` 列出的行 —— 宿主与其它 preset 的工具不会继承。第一版只写了我们那一行，于是被切过去的会话丢掉全部标准工具（fs/shell/web…），表现成"工具不可见，连 DSH 本身都受影响"。因此本 preset 是 `standard` 的**整份副本 + 一行增量**（harness 自带的 `cordis`/`code` preset 也是这么做的）。

**副本必须机械生成、并逐行比对**：手抄会漏掉**必填 config** —— 实测把 `standard` 的 `plan-mode` 行抄成了 `- id: plan-mode / name: …`（漏了 `config.section` 那段 2340 字符的块标量），挂载直接失败：`PlanModeConfig needs a non-empty 'section'`。生成方式：取 standard 中 `# ── identity` 起的**全部内容（含注释）** → 前置本文件头注释 → 末尾追加 `mud-agent` 行。`tests/preset-agent.spec.ts` 在 harness 检出存在时**逐行比对 standard**（缺行/改行都红），这是官方 README 明列的"副本会漂移"这一已知限制的对策；升级 harness 后按同一方式重新生成。

**部署（全部写在本包 patch，profile patch 保持 `[]`）**：patch 分层是 `组合包 → profile patch → home → --patch overlay`。

- `mud-core` 行由 `--patch` overlay（`packages/mud-core/cordis.patch.yml`）**最后**插入 —— 写进 profile patch 的 `- id: mud-core / config:` 在该层根本不存在目标行。
- `agent-presets` 行来自 web-app 组合包：两层都在它之后，但**放本包 patch 里**才能让部署自洽（用户不需要维护 profile patch）。一条 patch 会**替换目标行整份 config**，所以必填的 `default` 必须带上（`includeShippedRoot`/`includeUserRoot` 有 schema 默认值，会保留 true）。
- 若某天还要维护别的 preset root，把它们一并写进这一条 roots（否则会被覆盖）。

```yaml
# packages/mud-core/cordis.patch.yml —— 两条部署声明都在这里，profile patch 留 []
- id: agent-presets
  config:
    default: standard
    roots:
      - path: D:/Code/dsh-mud-agent/packages/mud-core/presets
        trust: system

- insert:
    - id: mud-core
      name: 'file:///D:/Code/dsh-mud-agent/packages/mud-core/dist/index.js'
      config:
        agentPreset: mud-player     # 留空 = 宿主侧装配（回退门）
        # …其余部署值不变
```

**不要往 profile patch 里加东西（实测事故）**：本机 profile 是 `patchReload: live` —— profile patch 的改动会**热应用**到正在运行的树上。实测两次：写入 `agent-presets` 的 config 覆盖（并带上一条目标不存在的 `mud-core`）后，**所有 preset 组装出来的工具当场消失**（MUD 会话的工具、连宿主会话自己的工具都没了，表现为"影响 DSH 本身"）；把 profile patch 改回 `[]` 后**不重启即恢复**。机理：热应用替换 `agent-presets` 的配置会重建它的常驻挂载，而各会话的工具正挂在那些常驻挂载下。因此：**插件自己的部署声明写插件的 patch（启动期一层，无热应用风险）；profile patch 留空；改配置用重启而不是热改。**

**与 §10 的交互（preset 模式下可见性层退化）**：preset 作用域共享一套工具，无法再"按会话档位注册不同工具集"，因此 preset 模式下档位只剩两层 —— 强制层（`tools/pre-execute` 闸门，逐次按会话档位判定）与提示说明（`mud-tier` 区段）。需要"模型视图严格等于档位能力"的部署应把 `agentPreset` 留空，走宿主侧装配（每条会话一个 agent 实例，可精确重挂）。见 §18.9。

**官方 preset 机制的既有约束（落地时必须知道）**：只有空白会话能切 preset（首个回合后固定，**坏的组装会把该会话永久锁死** —— 只能删用户重建）；preset 行不得 provide 服务到根 realm、也不得等待组装与宿主都不提供的服务（挂载审计）；组装加载失败会在**会话创建时**回滚并指名坏行；世代以 `agent.cordis.yml` 的 stamp 为键（旁边 skill/资产改动要等组装文件变动或重启才生效），被替换的世代不回收；设置页的"默认模式"是**进程级全局默认**（影响此后创建的每个会话），不是我们按 MUD 会话开关 preset 的杠杆。

---

## §10 权限档位（原 V9 并入）

**三档**：`observe`（只读）/ `operate`（读写）/ `full`（完全）。

**被约束的 actor 是 `agent`**：

| actor | 含义 | 受档位约束 |
|---|---|---|
| `agent` | 模型回合内的 `mud_*` 工具调用（T1 与 T2 **同权**） | ✅ |
| `system` | 连接/断开/重连、**登录流程**（凭据命令） | ❌（受连接开关约束） |
| `user` | 游戏页手打命令（`/mud/command`） | ❌ |

**只读必须配零发送信息通路**：`mud_look`/`mud_status` 本身就是发命令 → 新增 `mud_state`（读 world 快照 + 最近输出，不碰 socket）。

**「完全」= 读写 + 外围能力（显式列举）**：`connection:connect|disconnect`、`wake:dead-air`（v0.4.0 起不再有 `wake:login-stall`，见 §11）、`catalog:skills|rules`、`captcha:refresh`。

**双层执法**（可见性 ≠ 强制）：

| 层 | 机制 | 作用 |
|---|---|---|
| 可见性 | 按档只注册该档工具到 agent ctx | 模型看到的 capability 正确 |
| **强制** | `agent.ctx.on('tools/pre-execute')` → `allow / deny{reason} / ask{reason}` | **唯一算数处**；T1 渲染的动作走同一管道 → 权限对 T1 同样生效 |

**状态与查询**：`mud/capability` 会话事件（log-only）+ `mudCapabilities` 投影 + `Config.defaultTier`；读取侧 `ctx.mud.capability.{current,set,names,resolve,optionOf,defaultTier}`（对齐 `permissionPresets` 形状）。**agent 永不自提权**，只能 `ask`。

**危险命令**：`FORBIDDEN_COMMANDS` 静态黑名单 → **档位策略表**（数据驱动、可配、可测）。

**已实现（v0.2）**：

| 项 | 落点 |
|---|---|
| 档位表（可见工具集 + 外围能力） | `services/gate/tiers.ts`：`MUD_TIER_SPECS`、`visibleTools`、`MUD_TIER_NAMES`（`observe`/`operate`/`full`），完全档外围能力 `FULL_CAPABILITIES` |
| 危险命令策略表 | `shared/commands.ts`：`DEFAULT_DANGEROUS_COMMANDS`（`deny`：suicide/passwd；`ask`：abandon/steal/kill/drop/quit）+ `commandHead`/`dangerousRuleFor`/`deniedCommands`；`Config.dangerousCommands` 整体替换 |
| 纯判定（强制层唯一判据） | `services/gate/policy.ts`：`evaluateToolCall`（非 MUD 工具放行 → 档位可见性 → 逐条命令：登录/人工流程豁免 → 危险表 deny/ask → 只读档 deny）、`commandsOfToolCall`（命令派生由 `services/gate/rules.ts` 的 `buildGateRules` 注入） |
| 强制执行点 | `services/gate/tool-gate.ts`：`installMudToolGate` 装官方 `tools/pre-execute`（不 `next()` 即短路）；带 agent 身份判据与 `[权限] …` 留痕 |
| 可见性层 | `agents/mount.ts` 的 `attachMudTools(..., visible)` 按档注册；档位切换时 `capability.onChange` → 先释放再重挂（模型看到的工具列表 = 该档能力） |
| 状态与查询 | `services/gate/capability.ts`：会话事件 `mud/capability`（log-only）+ 官方会话投影 `mudCapabilities`（host-only，`stateVersion: 1`）；API `ctx.mud.capability.{names,defaultTier,current,resolve,optionOf,options,capabilities,set,ensure,onChange}`（形状对齐 `permissionPresets`）；HTTP `GET/POST /mud/capability`；`/mud/status` 每行带 `tier` |
| 零发送通路 | 新工具 `mud_state`（world 快照 + 最近输出 + 连接态，不碰 socket）、`mud_recall`（尚未投递的输出）、`mud_help`（命令语法按需查询：不带 topic = 分类 + id 索引, topic = 分类/命令 id 给出完整语法）、`mud_captcha`（fullme 取图 + 推前台弹窗；出站围栏）；只读档工具集 = 这几个 + T1 动作通道（`mud_send`/`world_patch`，强制层约束）。**命令目录注入策略**：系统提示只放 `commandsIndexForAgent()` 的索引（分类 + 命令 id，约 10 行），70+ 条完整语法由 `mud_help` 按需取 |
| 模型可见的档位说明 | `services/gate/tiers.ts` 的 `mudTierNote(tier)` → 系统提示区段 `mud-tier`（动态提供者，档位切换即时生效；补偿偏差 1） |
| 页面入口 | 用户行 ⋯ 菜单三档选择（当前档带 `●`），右栏状态区显示 `权限: …` |

**两处与本文档原设计的偏差（已记入 §18）**：

1. **`mud_send` / `world_patch` / `mud_captcha` 在所有档位都注册**。前两者是 T1 通道本身（登录流程发名字/密码、登录完成/失败置位），只读档若把它们摘掉，登录动作会在官方 `tools/pre-execute` **之前**就被判 `UNKNOWN_TOOL`，强制层根本看不到该调用；`mud_captcha` 是 fullme 流程的解析工具（不发游戏命令，零发送）。因此只读档对 `mud_send` 的约束落在强制层（登录命令放行、其余 deny）。
2. **客户端读档位走 `/mud/status`（HTTP 每会话状态通道），不新增投影 wire 视图**。投影保持 host-only（`mudCapabilities` 状态表），因为当前唯一消费方是页面档位选择器，而它已经每 2.5s 轮询 `/mud/status`；加一个没有消费方的 wire 视图违反"每个抽象都要有当前消费方"。

**与官方正交**：不复用 `sandbox`（管 fs/shell）、不塞 `permissionPresets`（只有 sandbox+approval 两个 knob）。

