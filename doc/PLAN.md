---
sections: []
status: active
note: 计划起草区 + 待办池；不承载已落地事实（落地后同步正式章节并清空）
---

# PLAN.md · 计划起草区与待办池

> **文件角色**：本文件是**新计划的临时起草区**，不是长期设计事实源。
>
> **纪律**：
> 1. 任何大型计划**先在此起草成型**，再实施；实施完成后同步到 `doc/architecture/` 的**归属章节**，在 `doc/CHANGELOG.md` 登记一行，然后**删除本文件中对应内容**（不留档）。
> 2. 本文件自身小节写 `1.1` / `第 3 章`，**不使用 `§` 符号**（`§N` 专属于正式章节，§0.2 规则 3）。
> 3. 引用现行设计一律写**现役 `§N`**；引用归档写 `v1 §N` / `v2 §N`。
> 4. 切片统一用 `T*` 编号，顺序增加；**只有落地后才写进正式章节的切片表**。
> 5. 例数、计数、规模**以当次实测为准**，不硬编码历史值。
> 6. 交付切片模板：大型计划六章（元信息与范围 / 背景与核心决策 / 机制与契约 / 源码变更清单 / 实施切片与验收 / 未决与完成定义）；中小型可压成四节（目标与决策 / 契约与变更 / 实施与验收 / 未决与收尾）。
> 7. 本文件的内容**不被任何设计文档引用**；要引用先同步到正式章节。

**当前状态**：一律以 §16（验收与完成定义）与 §17（演进与后置）为准；本页不维护状态摘要。

---

## 一、待办池（取材清单）

> 用途：编制新计划的取材方向，编号 `T*`。条目**仅作启动方向提示**，起草时必须回正式章节复核现行口径。
> 立项后在此标注「已立项 → 见本文件某计划」；落地后**从本表删除**并同步 §17。

| # | 事项 | 启动方向 | 主要依据 |
|---|---|---|---|
| **T6** | **第五期：进阶机制（各自独立，不批量规划）** | 投递策略化（token 账目恶化）· 规则层（`swallow` 吞行动作）· 流程扩展（`args` 占位符）· 子级 deadline 预算 interrupt · `ask` 超时 · 计数账目 · 禁词表 Config 化 · 画面后置项（~~规则层 `danger` 危险判据 + 战斗系统~~ **已落地交付**，T21，结论见 §16.5 切片表 / §5.2 / §6.3 / §8.6 / §10.3 / 附录 A.8 / CHANGELOG） | §17.3 |
| **T7** | **归档资产再评估** | v1/v2 归档中未迁移但有参考价值的设计（五层心智、T2 闭环与三唤醒源、预算与释放阀门、记忆三分、成本与计数口径、P1 预案档、不变量 I1–I16、五站消费链、形态 C + B3、看门狗表、权限三档、人工环节、loop-sim 账目纪律）**按例证逐条**评估 | §17.3、`doc/archive/README.md` §5/§6 |
| **T8** | **宿主换代整批复核** | 宿主换代后按 §2.5 整批重新核对 §2.1 锚点与 API 形态，输出写回 §2.1/相关章节 | §2.5、§0.7 |
| **T9** | **宿主会话面缺口跟踪** | ① 插件拿不到 `AgentHandle.dispose`、`ctx.sessionController` 无 delete ⇒ 删账号后会话仍在宿主内（**已核实归档面可缓解但非删除**，跟踪宿主补删除面）；② **子会话无清退/归档面**：`ctx.subagents` 只有 `drainContinuableChildren` / `drainContinuableDescendants`（释放驻留 Activation）与 `listChildren` / `listDescendants`（列举），**没有删除会话或归档目录条目的动词** ⇒ 每次派发留下的子会话记录与父会话目录条目永久保留（本仓派发现已为一次性前台：只读留存、不再可续；目录读取成本随累计派发数线性增长）。跟踪宿主是否补面（会话删除 / 目录清退归档） | §2.4、§16.6 #8、§7.6 |
| **T10** | **装配层加载冒烟可执行化** | **已落地工件面 e2e**（`test/plugin-load.e2e.ts`，加载 `lib/` 产物 + 断言 remote 命名空间在册，见 §16.1/§16.2）；**剩余** = 真宿主组合冒烟（Loader + `--patch` 启动 → 断言无 `1 entry did not activate` 且 `mud/*` 动词在册） | §16.1、§2.2 |
| **T20** | **匹配编译入口单点化（候选，2026-10-06；2026-10-08 裁定延后）** | 三处正则编译入口（`classify.ts` 规则编译 / `tools.ts` `compileRegexes` / `tracker.ts` 规则表内联）可合并为统一 `compilePattern`（非法正则 fail-loud 语义一致、正则字符串统一登记实录出处）；**触发例证已出现（2026-10-08）**：T23 导航判据与 T23.6 位置感知本会共用同两条原文（`^当前区域的系统内建路径出发点在：` / `你决定开始前往`）——**用户裁定延后**，本仓暂按"各消费者各自持有判据常量"推进；下次再出现跨消费者重复时再立项 | §6.3、§8.7、§10.3 |
| **T22** | **webui 底部状态栏聚焦修复（未实施，2026-10-08 讨论记录）** | 底部状态栏跟踪的「当前会话」只随手动连接（`connectUser`）设置 `conn.sessionId`：① agent 自动建连的会话（新账号接入路径）`conn.sessionId=null` ⇒ watchStatus 推帧 focus 落空、状态栏恒「未连接」且刷新救不回；② 点账号行 `openUserSession` 不调 `setActive`（该方法存在但从未被调用）⇒ 切换会话后状态栏挂旧会话状态。修复方向：底部状态栏语义钉死为「当前打开账号会话的连接态」——`openUserSession` 接线 `setActive` + `setActive` 同步 `conn.sessionId`（推帧即时更新，消除「已接入但状态栏未变」的滞后感） | `mud-webui/src/client/mud-state.ts`（`applyStatusRows` focus 回退 / `setActive`）、`index.ts`（`openUserSession`）；§9.4/§9.5（webui 状态呈现） |
| **T27** | **任务专用命令机制（2026-10-12 用户裁定方向，未立项）** | 命令总表第六分组 `commands/task.ts`（骨架已建，`TASK_COMMANDS = []`）：条目带任务标记（如 `task: 'zhenfa'`），**只在执行特定任务时有效**——生效判定 = **会话谱系标记**（任务派发时在 session 写入任务类型标记，缝侧沿 parentSession 上溯命中即启用）；语义边界 = **只做收窗判据**（任务中先查任务条目再查全局表，同名任务条目优先；任务外不命中 = 未登记不收窗只等超时 DEC-4，**不拦发送**）。实施面：① 条目契约加任务标记字段；② 派发面任务标记写入点（kickoff/子 agent 生成，§7.4）；③ `resolveAwaitPlan` 任务上下文参数 + 装配器任务条目分离（不进全局 `matchCommandProfile`）；④ 测试与 §8.7/§8.10 文档。首用例 = 武当阵法（`zhenfa`/`zouwei`，语料与特性见附录 A.10——走位是决策型任务，适合 agent 决策 + 任务判据收窗），判据原句待实录（A.10 挂账），实录前不接机制 | 附录 A.10、§8.7、§8.4（不拦发送）、§7.4（派发面） |
| **T28** | **mud-core3 包拆分重组（2026-10-13 立项，已起草 → 见本文件三）** | 按宿主官方插件组织规则（`packages/AGENTS.md` + `docs/cookbook/adding-a-package.md` 实证）将 mud-core3（48 src 文件）拆为 `packages/mud/` 组 + 8 包：`mud`（会话引擎核心）/ `mud-link` / `mud-sense` / `mud-commands` / `mud-combat` / `mud-nav` / `mud-flows` / `tool-mud`（组合根 + 唯一 bundle）。核心裁定：组=纯容器、包=最小职责单元；命名 role-first（tool-mud 非 mud-tool）；`dsh.bundle.patch` 唯一归属 tool-mud；mud-commands 为库直接 import 不做 service；纯层零工具运行时依赖；timer 生命周期归注册方 ctx.effect。域切分与运行时行为零变更，纯组织重构 | 2026-10-13 会话调研（本计划三）；官方 `goal`/`shell`/`terminal` 家族形态；§2.2（宿主接缝）、§16.2（用例账目重分账依据） |

> - T1（T4b 实机验收）已于 2026-10-02 全项通过并从本表删除，结论见 §16.4。
> - T4（C5.2 行打标与画面分屏）已于 2026-10-03 立项执行完毕并从本表删除，结论见 §17.4 与 `doc/likely/c5.2-line-tagging-split-screen.md`。
> - T2（T5 收尾：StatusRow 窄面 + webui 状态呈现）已随 T11 交付（v0.0.24–v0.0.26）并从本表删除，结论见 §16.6 #7 / §9.4 / §9.5。
> - T3（文档—实现一致性清理）已于 2026-10-03 复核关闭：#1–#5 在文档重写期已修毕，src 注释无归档编号残留，结论见 §16.6。
> - T14（流程捕获槽与 fullme 触发时捕获改造）已于 2026-10-05 落地交付（v0.0.39）并从本文件删除，结论见 §16.5 切片表 / §16.3 断言行 / CHANGELOG。
> - T15（读窗命中信息下沉：core3 独占匹配）已于 2026-10-05 落地交付（v0.0.43）并从本文件删除，结论见 §16.5 切片表 / §16.2 用例账目 / §5.2 / §8.13 / CHANGELOG。
> - T16（流程存储演进与变更账本）已于 2026-10-05 落地交付（v0.0.44）并从本文件删除，结论见 §16.5 切片表 / §16.2 用例账目 / §8.11 / §14.3 / CHANGELOG。
> - T17（宿主接缝漂移防御）已于 2026-10-05 落地交付（v0.0.45）并从本文件删除，结论见 §16.5 切片表 / §16.2 用例账目 / §8.2 / CHANGELOG。
> - T18（会话上下文的进程级收口：表面遮蔽）已于 2026-10-06 落地交付（v0.0.46）并从本文件删除，结论见 §16.5 切片表 / §16.4 #8 / §16.2 用例账目 / §2.1 事实 14–16 / §11.2 / CHANGELOG；实测证据见 `doc/likely/t18-surface-elision-spike.md`。
> - T19（状态追踪：游戏文本 → World 结构化状态）已于 2026-10-06 落地交付（v0.0.51）并从本文件删除，结论见 §16.5 切片表 / §10.3 / §8.7 / 附录 A.7 / CHANGELOG；skills/id/i/sc 判据待完整实录校准（A.7.3）。
> - T21（战斗自主：状态驱动规则 + 危险抢占 + 行流接管 + combatAuto 总开关）已于 2026-10-07 落地交付（v0.0.52）并从本文件删除，结论见 §16.5 切片表 / §5.2 / §6.3 / §8.6 / §10.3 / §17.3 / 附录 A.8 / CHANGELOG；真机冒烟与 A.8.5 推断值（胜利/脱战/干预行文等）待实测。
> - T23（mud_walk 导航：判据 / 位置感知 / 意图面 / 精力闸 / 行走知识图与 `mudNav` 服务 / JSON 持久化 / 遇敌中断 / 阻断档案）已于 2026-10-08 **整体交付**（v0.0.59）并从本文件删除，结论见 §16.5 切片表 / §16.2 用例账目 / §8.6 / §8.7 / §10.3 / §15.2 / §15.5（Config #28） / 附录 A.9 / CHANGELOG；`node` 解禁与图持久化优化见 §17.3，`-p` 节流已裁不做。
> - T24（短期优先目标：DSH goal 接入）已于 2026-10-09 **交付**（v0.0.60）并从本文件删除，结论见 §16.5 切片表（T24 行）/ §7.4（三触发点 + goal 节选与源分派）/ §15.3（dsh-goal 服务行与权限面收敛）/ §17.3（goal blocked 自标通道后置项）/ CHANGELOG；实机验收与 D4 无守卫交互待重启宿主后实测。
> - T25（MUD 知识库：wiki 全量接入 skill 体系）已于 2026-10-09 **交付**（v0.0.61）并从本文件删除，结论见 §16.5 切片表（T25 行）/ §7.1（知识库资产面）/ §15.3（preset 行 + T25 资产面）/ §17.3（知识库增补机制后置项）/ CHANGELOG；实机验收（目录可见 / mud-basics 首步加载 / 攻略按需加载 / 子级可达 / 热更）待重启宿主后实测。
> - T26（全局命令表：命令 → 收窗判据与结果分类）已于 2026-10-12 **交付**（v0.0.69）并从本文件删除，结论见 §16.5 切片表（T26 行）/ §16.2、§16.3（用例账目与断言行）/ §8.7（命令总表与 resolveAwaitPlan 解析单点）/ §8.10–§8.15（契约模式词汇表 / 保存门与告警 / 解释器语义 / 缝执行序 / login·fullme 步表）/ §5.2（ReadMachine 三形态）/ §13、§14（留痕与结构化失败改两级路由口径）/ 附录 A.3、A.9 勘误注 / CHANGELOG；实机验收与判据实录挂账（A.3/A.9）待重启宿主后实测。

## 二、计划模板（复制使用）

```markdown
#  <计划标题>

> 状态：起草中 / 已冻结（日期） · 取材：<来源> · 编号：本计划占一个交付编号 T，下设切片 T.1…

## 第 1 章 元信息与范围
1.1 已落地基线（仅登记，不重复实施）｜1.2 目标｜1.3 非目标

## 第 2 章 背景与核心决策
（决策表：编号 / 决策 / 理由或证据）

## 第 3 章 机制与契约
（接口、状态机、配置校验、归属、验收口径、需裁决点）

## 第 4 章 源码变更清单
（切片 × 文件粒度：修改 / 新增 / 删除）

## 第 5 章 实施切片与测试验收
（每切片：内容 / 验收断言 / 是否先红后绿）

## 第 6 章 未决、待实测与完成定义
（未决项 / 待实测项 / 完成定义 = 同步 §16.5）
```


---

# 三、计划

# T28 · mud-core3 包拆分重组（对齐宿主官方插件组织规则）

> 状态：起草中（2026-10-13 立项起草；**同日审阅修订**：切片按依赖拓扑重排为 T28.1–T28.6，D9 依赖矩阵按 import 实证改写） · 取材：2026-10-13 会话调研（DSH 官方插件划分规则实证 + DeepSeek 建议六条核实） · 编号：本计划占 **T28**，下设切片 T28.1–T28.6

## 第 1 章 元信息与范围

**1.1 已落地基线（仅登记，不重复实施）**：mud-core3 现为单包 48 个 src 文件 + 35 个测试文件（2026-10-13 复核实测，与 §16.2 口径一致）；用例账目以当次实测为准（起草时基线：core3 485 绿 + wake 2 例 v0.0.66 登记历史遗留、workflow 96 全绿、两包 typecheck 零错，见 §16.2）；v0.0.71 勘误后代码与文档一致。

**1.2 目标**：将 mud-core3 按 `packages/mud/` **组 + 8 包**重组，包边界 = 官方「角色三分」（定义 / Provider / Consumer）；依赖单向、命名 role-first、包内扁平；运行时行为与判据语义**零变更**。

**1.3 非目标**：不改 mud-workflow；不引入新运行时机制（无模块挂接接口）；不动 webui 功能面（仅同步其依赖引用）；不做 `dsh plugin add` 流程切换（维持 `--patch` 启动，切换作为待实测项，见第 6 章）。

## 第 2 章 背景与核心决策

| 编号 | 决策 | 理由或证据 |
|---|---|---|
| D1 | 组=纯容器（无 package.json/源码），包=最小职责单元，包恰在组下一层 | 官方 `packages/AGENTS.md` + `adding-a-package.md` 成文纪律；约 30 个组实证 |
| D2 | 按角色三分拆包：能力定义 / Provider / Consumer；单一职责不硬拆 | 官方钦定模板 = shell 家族（shell 定义、bash-local Provider、tool-bash 消费面）；goal/terminal 同型 |
| D3 | 命名 role-first：**`tool-mud`** 而非 mud-tool；领域件用 `mud-*` 前缀 | "name the role that exists"；官方 `tool-terminal`/`tool-goal`/`command-goal` 全部 role-first |
| D4 | 包内扁平：`src/` 极浅、`src/types.ts` 只放类型、测试在包级 `tests/`、每包 README | cookbook 成文不变量；官方 llm-deepseek 约 20 文件仍平铺 |
| D5 | **mud 组内唯一可安装 bundle = tool-mud**：组内 `dsh.bundle.patch` 只此一份；patch 插入行 id 全局唯一，同一 patch 层不得应用两次。`mud-webui/cordis.patch.yml` 是 webui 插件自持面，**不在本裁定内**（归属不变，T28.6 收口时明示） | plugin-manager 按 manifest `dsh.bundle` 识别 bundle；现 cordis.patch.yml 头注释自证重复应用插重复 id 行 |
| D6 | mud-commands 为**库（直接 import）**，不做 cordis service | 官方 goal 核心运行时依赖仅 schemastery+zod，被 tool-goal devDep 消费；判据总表无生命周期/Config，无服务化理由 |
| D7 | captcha **纯件**（captcha.ts，零 import 实证）内部化到 mud-flows（不暴露独立服务）；**captcha 状态面（captchaWaits/emitCaptcha/resolveCaptcha）留在 mud 的 service**——io.awaitCaptcha 闭包在 workflowIoFor 构造（service.ts 实证），mud 经编排边导入 fetchCaptchaImage | fullme 专用机制，无第二消费者 |
| D8 | wake 等 timer 生命周期归**注册方**，用 `ctx.effect` 启停管理 | 宿主 plugin-manager ctx.effect 纪律实证 |
| D9 | 依赖单向**且无环**（TS references 不容环；逐边 import 实证见 3.2）：**providers（combat/nav/flows）零 mud 依赖**——窄面类型自持（controller 只吃 link/line + read + world 类型，实证不 import runtime/service）；mud 是唯一编排引用 providers 的包；「特性包 → mud 引擎接口」**不成立、禁止**（照做即包环）；纯层（mud-sense / mud-commands / mud-link）运行时零宿主/工具运行时依赖 | combat/controller.ts、flows/login.ts、captcha.ts 的 import 面核对（2026-10-13 审阅）；官方依赖按角色单向 |
| D10 | `MudLine` 归 mud-link（生产者所有），mud 核心经 re-export 下发，下游不绕过 | link/line.ts 现为定义处；生产者所有原则 |

> **规范出处锚点（审阅修订 B1，2026-10-13 落定；取材自宿主仓 `D:/Code/deepseek-harness`，本仓无此二文件）**：
>
> **① 组/包结构**（`docs/cookbook/adding-a-package.md` §1 原文）：`packages/<group>/<pkg>/`——「Choose an existing group when one matches the package's role… A new group is allowed, but it is a pure container: no `package.json`, no source files, and packages still sit exactly one level below it.」
>
> **② package.json 不变量**（cookbook §1 原文摘录，宿主由 `pnpm run constraints` 脚本强制）：`private: true`、`version` 与根一致、`type: module`、`main: "lib/index.js"`、`exports["."].types/.default` 双入口、cordis 同时进 peer+dev（同范围）、`files` 恰好含产物清单、不发布 src/declaration maps。本仓差异声明：本仓包不用宿主 scope（`mud-link` 裸名）、tsconfig 例外（见 D4 本仓形态）。
>
> **③ 命名纪律**（cookbook §3 "Name the role that exists" 原文）：「Name the stable current responsibility. Do not name the first implementation, a possible future expansion, or the Cordis base class.」+ 角色词表（Controller/Store/Provider/Consumer/Registry/Runtime…）；单数 ctx key = 单引擎，复数 = registry。
>
> **④ 目录形态**（`packages/AGENTS.md` Naming rules 原文）：包内 `src/types.ts` 只放类型（no runtime code）；「Tests live at package level under `tests/`, not `src/__tests__/`」；包内相对 import 用显式 `.ts` 说明符，编译期重写为 `.js`；README 随行为同 commit 更新 + `## Known Limitations and Deferred Work` 节。
>
> **⑤ 组名清单（59 组实证，2026-10-13 `ls packages/`）**：acp · api · attachment · boot · browser-use · bundle · client · code-runtime · compaction · computer-use · context · core · credentials · deliverables · document · e2b · examples · experimental · extensions · feedback · fs · goal · guard · hooks · host · identity · interaction · jobs · llm · lsp · mcp · plan · preset · ptc-runtime · runtime-diagnostics · sandbox · schedule · sdk · session · session-query · settings · shell · skill · spill · ssh · storage · subagent · subprocess · telemetry · terminal · test-support · todo · typert · util · web · webhook · workflow · workspace（去 AGENTS.md/CLAUDE.md/README*/tsdown.worker.ts 五个非目录项；`goal`=goal+tool-goal+command-goal+goal-round-driver 四包、`shell`=shell+bash-local+bash-sandbox+pwsh-local+pwsh-sandbox+tool-bash 等多包组为「组内多包」直接例证）

## 第 3 章 机制与契约

**3.1 最终结构（组 + 8 包）**：

```
packages/mud/            # 组：纯容器（仅组 README）
├── mud/                 # 会话引擎核心：service · runtime · accounts · store · roster · deliver ·
│                        #   llm-gate · log.ts(←log/log-service) · screen.ts(←view/screen) ·
│                        #   types.ts · typert 归属见 3.4（动词面在 tool-mud，B5 复核）
├── mud-link/            # 连接 Provider：line(MudLine) · telnet · mud · keepalive · corpus
├── mud-sense/           # 感知纯层（无 socket）：read · classify · elide · tracker · world · wake
├── mud-commands/        # 判据总表（库）：define · assembler(←command-profiles) ·
│                        #   std/skill/usr/stunt/profession/task 扁平化 · types.ts
├── mud-combat/          # 战斗 Provider：state · rules · controller · danger · report
├── mud-nav/             # 导航 Provider：graph · route · blocker · stamina · service · json-store
├── mud-flows/           # 流程 Provider：login · fullme · captcha（D7 内部化）
└── tool-mud/            # 组合根 + 工具面 Consumer：index(装配接线) · tools · preset ·
                         #   types(MudToolDeps 窄面) · cordis.patch.yml（D5 唯一归属）
```

**3.2 依赖方向（单向无环；逐边有 import 实证，2026-10-13 审阅核对）**

| 包 | 依赖 | 实证（现 mud-core3 src import 面） |
|---|---|---|
| mud-link | （叶子） | — |
| mud-sense | mud-link（MudLine）、mud-workflow（契约词汇） | read.ts：`mud-workflow/contract` + `./link/line.ts` |
| mud-commands | mud-workflow（契约词汇） | command-profiles.ts：`CLOSURE_KINDS` / `ClosureKind` / `FlowSlotsInfo` 等 |
| mud-combat / mud-nav / mud-flows | mud-sense / mud-link / mud-workflow（窄面类型）；**零 mud 依赖** | controller.ts 只 import 兄弟件 + link/line + read + world；login.ts 只 import `mud-workflow/contract`；captcha.ts 零 import |
| mud（引擎） | mud-link / mud-sense / mud-commands / **mud-combat / mud-flows** / mud-workflow（编排）；**不含 mud-nav**（service/runtime 不引 nav——nav 只被 tool-mud 消费：tools.ts 工具面 + index.ts 装配注册 NavService/json-store/stamina，2026-10-13 复核实证） | service.ts→runtime/deliver/classify/link/log/screen/world/combat 四件/captcha/command-profiles/read/mud-workflow；runtime.ts→link 三件/read/screen/world/classify/tracker/roster |
| tool-mud | 全部（**含 mud-sense**：ReadOpts/tracker 规则/读后投影；含 mud-workflow：waitSchema） | tools.ts import 面 |

**3.3 官方不变量（每包必做）**：package.json `private:true` + `main: lib/index.js` + `exports["."]` 双入口（types/default）；tsconfig extends 根 base、`rootDir: src`、`outDir: lib`、references 声明 workspace 依赖；cordis peer+dev；每包 README（API/config/events/Known Limitations）。

**3.4 typert 工件归属（2026-10-13 复核补登，B5）**：typert 是「动词面 + 生成工件 + 消费方」三方组合，**不能简单归 mud 一包**——实证：① `remote.mud` 动词命名空间定义在 index.ts（→tool-mud），service.ts 仅注释引用；② index.ts L1032 动态 `import('mud-core3/typert')` 自读工件，**模块名硬编码现包名**；③ `gen:typert` 是仓级脚本（`scripts/gen-typert.mjs`，分析输入面待核实），exports `./typert` 双工件（typert.host 插件自读 + typert.remote-client 外部消费）。处置：T28.1 落 B1 锚点时**同场核实 gen-typert.mjs 的分析输入**（扫描入口是否 = index.ts）；T28.5 迁移时模块名随动词面所在包同步（`'mud-core3/typert'` → 实际归属包名），exports `./typert` 归属与 webui 消费路径联动改写。

**3.5 需裁决点**：包 npm name 沿用裸名（现 `mud-core3` 无 scope，8 包命名 `mud` / `mud-link` / … / `tool-mud`）；若宿主对裸名 `mud` 有冲突再议 scope。

## 第 4 章 源码变更清单（切片 × 文件粒度）

| 切片 | 新增包 | src 迁入（← mud-core3 原路径） | tests 迁入 |
|---|---|---|---|
| T28.1 | 组 + `mud-link` | **先落 B1 规范锚点**（✅ 2026-10-13 已落第 2 章）；再建组（纯容器）+ mud-link←link/line·telnet·mud·keepalive·corpus·index→index（**叶子包最先建**，被后续全部切片依赖） | mud-link←link/ 五套；**helpers.ts 留 core3**（实施勘误：helpers 被 fullme/login/runtime/service/workflow 五个引擎 spec 使用，link spec 不用它——随 T28.4 归 mud/tests，第 4 章原「helpers 归 mud-link」系起草误判） |
| T28.2 | `mud-sense` + `mud-commands` | sense←read/classify/elide/tracker/world/wake；commands←commands/define + 五分组 + task（扁平）· command-profiles→assembler | sense←read·classify·elide·tracker·world·wake；commands←**新增装配单测**（解析单点/保留字/跨 kind 禁重名，现散在 tools.spec 的解析断言不迁、留 tool-mud 测工具面行为）**（✅ 2026-10-13 实施勘误：①sense 测试仅 elide·wake 两套随迁——read/classify/tracker/world 四套为引擎集成测试（引 SessionRuntime/Deliverer/service 接线），随迁即成 mud-sense→mud-core3 反向依赖违 A1，留 core3 随 T28.4 归 mud；wake 2 例 v0.0.66 登记历史遗留失败随文件同迁 mud-sense（同名同因，纯移动含遗留）；②assembler 导出面新增测试缝 `assembleProfiles(raw)`（生产 `COMMAND_PROFILES` 改经它装配，行为零变更）——保留字/跨 kind 重名/命令头冲突等 fail-loud 错误路径以受控 fixture 实证；③装配单测 17 例落 mud-commands/tests/assembler.spec.ts） |
| T28.3 | `mud-combat` + `mud-nav` + `mud-flows` | combat←combat/ 五件；nav←nav/ 六件；flows←flows/login·fullme + captcha（**纯件**入 flows；状态面 captchaWaits/emitCaptcha/resolveCaptcha 留 mud，D7） | combat←combat-* 五套 + combat.replay；nav←nav-* 五套；flows←login·fullme **（✅ 2026-10-13 实施勘误：①combat 五套全随迁（replay 引 mud-sense 的 StateTracker/World 真实类——mud-combat 本就依赖 mud-sense，合法）；②nav 仅 blocker/graph/route 三套随迁——nav-store.spec 引 SessionRuntime（引擎件），留 core3 随 T28.4；③flows 的 login/fullme 两套 E2E 为引擎集成测试，留 core3 随 T28.4——mud-flows tests 暂空，行为由 core3 E2E 覆盖；D9 断言实测：providers 三包 src 对 mud 零 import ✓） |
| T28.4 | `mud`（引擎） | mud←service/runtime/accounts/store/roster/deliver/llm-gate/log/log-service→log/view/screen→screen/types/**typert.d.ts（ambient 模块名暂保持 'mud-core3/typert' 不动，避免薄壳期 index.ts 动态 import 断链；T28.5 随包名同步，见 3.4/B5）**；**全包跨包深路径 import 改为包名导入**（审阅修订 B4：`./link/line` → `mud-link`、`./commands/…` → `mud-commands`、combat 四件 → `mud-combat`、`./read`/`./world` 等 → `mud-sense`） | mud←service·runtime·reconnect·accounts·deliver·store·llm-gate·screen·log/log-service·workflow（缝）·probe-heartbeat.mjs **（✅ 2026-10-13 实施勘误：①test/nav.spec（stamina 纯单测，零引擎依赖）系 T28.3 计划缺口，随本切片归 mud-nav/tests/nav-stamina.spec.ts（mud-nav 19→23 例）；②nav-store.spec 归 mud/tests 需 mud devDependencies 增 mud-nav（test-only——D9 矩阵指 src 面，service/runtime 对 nav 仍零 import）；③mud-flows vitest 加 passWithNoTests（login/fullme E2E 归 mud/tests 后本包无自有单测）；④typert.d.ts 迁 mud/src 后 ambient 模块名 'mud-core3/typert' 不变，core3 两个 tsconfig include 增 `../mud/mud/src/typert.d.ts` 保持 index.ts 动态 import 可查型；⑤core3 移除 @xterm 依赖（唯一使用点 view/screen 已迁 mud），zod 保留（gen-typert 工件运行时依赖））** |
| T28.5 | `tool-mud` | tool-mud←tools/preset + src/index.ts 的装配接线部分 + cordis.patch.yml；**删除 mud-core3 包**（薄壳职责终结）；typert 模块名与 exports `./typert` 归属按 3.4/B5 同步（动词面=index.ts 在 tool-mud，gen-typert 分析输入 T28.1 已核实）；mud-webui 与全仓引用面 `mud-core3` → 新包名同步；脚本/patch 路径更新 | tool-mud←tools·plugin-load.e2e（改从 tool-mud lib 加载）；§16.2 用例账目按新包分账 **（✅ 2026-10-13 实施勘误：①迁入清单补 src/types.ts 转发件（generator 要求 exports↔src 一一对应，`tool-mud/types` = `mud/types` 转发）与 vitest.config.ts（include 补 `*.e2e.ts`，core3 原配置随包删除）；②**patch 行 id 沿用** `mud-core3`/`mud-core3-tools`——宿主 profile 按 id 幂等替换，改名会插重复行；T28.6 grep 零残留准则对 patch 行 id 与 spike/ 历史实验层豁免；③**服务键 `ctx.mudCore3` 沿用**（workflow host CORE_ABSENT 判定 + e2e 消费该键；改名属破坏性 API 变更，随宿主换代按 §2.5 复核）——错误文案/插件 name/日志前缀/wake.goalBriefSource plugin 标识已同步 `tool-mud`（含 wake.spec 断言）；④ambient 模块名 `'mud-core3/typert'`→`'tool-mud/typert'`（typert.d.ts 归 tool-mud/src）；gen-typert PACKAGES→['tool-mud']；webui 引用面（dep + `tool-mud/remote`/`tool-mud/types` ×3 文件）与 root scripts/tsconfig.host.json 同步；⑤插件 tsc build 会清掉 gen-typert 工件——**构建序固定：tool-mud build → gen:typert**（root dev 脚本序已正确））** |
| T28.6 | — | 文档收口：§16.5 切片表 T28 行、§16.2 分账核对、§2.x/§8.x 路径锚点、CHANGELOG | — |

> **薄壳策略（审阅修订 A1，兼容期纪律，覆盖 T28.1–T28.4）**：mud-core3 每迁出一批文件，原路径替换为 `export * from '<新包>'` 薄壳——core3 的 lib 产物保持可加载，`plugin-load.e2e` 与 webui 引用在 T28.1–T28.4 期间零改动。两条纪律：① 薄壳**只 re-export 已迁模块**；② **禁止 core3 反向 import 新包中尚未迁移的模块**（跨包引用尚未建包的模块即编译失败，反向补齐又与薄壳对冲成环）。T28.5 删 mud-core3 时薄壳一并终结。

每包同时新增：package.json / tsconfig.json（references）/ tsconfig.test.json / README.md。

## 第 5 章 实施切片与测试验收

**每切片通用验收（先迁后验，红绿不适用——纯移动零行为变更）**：`pnpm --filter mud-workflow build` → 全 workspace typecheck 零错 → 全测绿（例数以当次实测为准；wake 2 例遗留口径不变）→ `plugin-load.e2e`（**T28.1–T28.4 工件面从 mud-core3 旧 lib 加载**——薄壳期宿主加载面不变；**T28.5 起改从 tool-mud lib 加载**）。

| 切片 | 内容 | 验收断言 |
|---|---|---|
| T28.1 | B1 锚点摘录落第 2 章；建组（纯容器）+ mud-link；core3 对应文件转薄壳 | workspace install/typecheck/全测全绿；MudLine 仅 mud-link 定义（core3 只 re-export）；`plugin-load.e2e` 从 core3 旧 lib 加载照常绿 |
| T28.2 | mud-sense + mud-commands（深路径 import 改动最大，测试路径全部改写） | 同上；mud-commands 装配单测新增并通过（resolveAwaitPlan 单点/保留字拒用/槽名跨 kind 禁重名） |
| T28.3 | 三特性包 combat/nav/flows（captcha 纯件入 flows，状态面留 mud）；core3 转薄壳 | 同上；providers 三包对 `mud` **零 import**（按 3.2 矩阵逐包 grep 断言） |
| T28.4 | mud 引擎最后建（依赖的包全部就位）；core3 深路径 import 改包名导入（B4）；core3 转薄壳 | 同上；`mud` 包 exports 非根子路径可被 typert 工件引用；**mud 对 link/sense/commands/providers 零相对路径跨包引用**（全部包名导入）；工件面仍从 core3 旧 lib 绿 |
| T28.5 | tool-mud（tools/preset/装配/cordis.patch.yml 迁入）+ 删除 mud-core3 + webui 与脚本引用同步 | 同上；cordis.patch.yml 从 tool-mud 唯一加载、patch 行 id 无重复；工件面 e2e 改从 tool-mud lib 加载 `mud/*` 动词在册；§16.2 按新包分账 |
| T28.6 | 文档与引用面收口：§16.5 切片表 T28 行、§2.x/§8.x 路径锚点、CHANGELOG | 全仓 grep `mud-core3` 零残留（doc/archive 与 CHANGELOG 历史条目除外）；宿主 `--patch` 启动冒烟无 `did not activate` |

## 第 6 章 未决、待实测与完成定义

**未决**：① 包 npm name 若与宿主生态冲突（裸名 `mud`）是否加 scope——T28.1 实装时裁决；② helpers.ts 若 T28.2+ 出现跨包测试复用需求，再评估 testkit 形态（官方 `*-testkit` 惯例），当前仅 link 域专用不预建。

**待实测**（需重启宿主）：① `dsh plugin add` 流程切换——tool-mud 加 `dsh.bundle` 声明、profile 去掉 `--patch`（同一 patch 层应用两次会插重复 id 行）；② profile `<node_modules>` junction 链接目标从 mud-core3 改 tool-mud；③ 宿主换代后按 §2.5 整批复核 API 锚点（与 T8 合并执行）。

**完成定义**：六切片全绿后同步正式章节——§16.5 切片表 T28 行、§16.2 用例账目按 8 包重新分账（以当次实测为准）、§2.1/§2.2 接缝锚点与 §8.x 路径更新、§17.3 登记遗留（webui 引用面等）、CHANGELOG 单行；随后**从本文件删除本计划**（不留档）。