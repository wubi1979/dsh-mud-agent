# T18 会话上下文「进程级收口」——surfaceOp 遮蔽 spike（已执行 2026-10-06）

> **状态（2026-10-06）**：**spike 已完成，三问全部有实测证据**（用户授权直接做 spike）。结论：宿主提供的「表面替换」（`surfaceOp: { op:'replace' }`）可以在**不换会话身份**的前提下把"本进程之前的 model-visible 历史"从对话请求里彻底移除，且该遮蔽**持久**（下一进程重放后仍生效）。同时实测出一条**硬不变量**：在会话 `system/message` head 就位之前追加任何 message 事件，append 当场成功、日志照写，但**下一次进程重放直接判 corrupt**（`system/message requires a protected first surface head`）——会话被写坏。
> **可复现资产**：[`spike/surface-spike.mjs`](../../spike/surface-spike.mjs)（零依赖插件）、[`spike/surface-spike.patch.yml`](../../spike/surface-spike.patch.yml)、临时宿主家目录 `D:\code\_spike\dshhome`（可删）。

## 1. 做法

- 临时 `DSH_HOME=D:\code\_spike\dshhome`（`profiles/node_modules` 用 junction 指向真实宿主安装，手工写 headless profile 清单）⇒ **不污染真实宿主**的 sessions / storages / workspace。
- spike 插件经 `--patch` 以绝对 `file://` 路径加载（与 mud-core3 同机制），**零 import**（只用 `ctx` 与 Session 公开成员），因此在临时家里也能解析。
- 观察点：插件自身的 `append`/`surface` 读数 + 一个 `{ prepend: true }` 的 `llm/stream` 监听器（**必须先于适配器**，适配器是终止监听器）打印真实组装出的对话请求里的四个标记。
- 全流程走宿主真实组合（`dsh headless`，base bundle 含 `compaction-basic` + `compaction-tool-result-pruner` + `compaction-image-offload`，宿主 invariants 在册），无 API key ⇒ 请求组装后适配器报 `MISSING_CREDENTIAL`（正好证明捕获发生在真实调用之前）。

## 2. 实测证据（原样摘录）

**RUN B** —— 恢复一个「有历史」的会话，在 `agent/pre-step` 遮蔽：

```
agent/created mode=replace session=session-5253e84a-… seq=20 nodes=[7,8,9,10,11] touched=false
composition compaction=true tokenMeter=true llm=true
MUTATED mode=replace head=7 nodesBefore=[7,8,9,10,11] old=[23,24] reset=25 keep=26 nodesAfter=[7,8,9,10,11,25,26] replaceGeneration=1
req#1 request bytes=73996 roles=[system,user,user,user,user,user,user,user] RESET=true OLD1=false OLD2=false KEEP=true
req#1 per-message system[-] user[-] user[-] user[-] user[-] user[RESET] user[KEEP] user[-]
req#1 ASSERT-PASS 历史已遮蔽且新消息在场
```

**RUN C** —— 再一次进程恢复同一会话（重放 + 跨进程请求）：

```
agent/created … seq=34 nodes=[7,8,9,10,11,25,26,28] touched=true
replay head=7 nodes=[7,8,9,10,11,25,26,28] oldSeqs=[23,24] oldStillVisible=[] replaceGeneration=1
ASSERT-DURABLE 重放后旧历史仍被遮蔽
req#1 request bytes=74134 … RESET=true OLD1=false OLD2=false KEEP=true
req#1 ASSERT-PASS 历史已遮蔽且新消息在场
```

**RUN B2（对照组：只追加、不替换）** —— 证明捕获敏感、且追加的消息平时**确实**会进模型：

```
MUTATED mode=control head=7 nodesBefore=[7,8,9,10,11] old=[23,24] reset=n/a keep=25 nodesAfter=[7,8,9,10,11,23,24,25] replaceGeneration=0
req#1 … RESET=false OLD1=true OLD2=true KEEP=true
req#1 per-message … user[OLD-1] user[OLD-2] user[KEEP] user[-]
req#1 ASSERT-CONTROL 历史在场（对照组预期）
```

**第一次尝试（错误顺序）留下的硬证据** —— 在 head 就位前追加：

```
dsh: stored session "session-52e1b7f7-…" is corrupt: SessionFormatError:
     system/message requires a protected first surface head
```

## 3. 三问结论

| # | 问题 | 结论 | 依据 |
|---|---|---|---|
| ① | 外部插件能否追加 `surfaceOp` 替换、让 model-visible 表面真的收缩 | **能**。`nodesBefore=[7,8,9,10,11] → nodesAfter=[7,8,9,10,11,25,26]`，`replaceGeneration=1`，head（seq 7，`system/message`）保留 | RUN B |
| ② | 对话请求里是否真的不再含被遮蔽的历史 | **是**。同进程请求 `RESET=true OLD=false KEEP=true`；跨进程同样；对照组证明 `OLD` 平时可见（`OLD1=true OLD2=true`） | RUN B/C/B2 |
| ③ | 与宿主 compaction 共存 | **组合层成立**：同一组合内 `compaction=true`、`tokenMeter=true`、`llm=true`，宿主 invariants 未报错；替换之后仍可继续 `append`（`keep=26`）；替换是宿主 compaction 用的**同一** `surfaceOp.replace` 语义与 fold 校验 | 五次 run |

③ 的**边界**：全程没有 API key，模型调用都在适配器处失败，因此"真 token 压力下 compaction 被触发后与遮蔽叠加"这一路径**未实测**（留 T18 未决）。

## 4. 硬纪律（必须写进实现，否则会把会话写坏）

1. **绝不在 `system/message` head 就位之前追加任何 message 事件**。判定：`surface.nodes[0]` 必须等于日志里 `system/message` 的 seq；否则 skip（实测：违反 ⇒ 该会话在下一进程被判 corrupt，不可恢复）。
2. **替换范围不含 node 0**（head 受保护）：`startSeq = nodes[1]`，`endSeq = nodes[last]`。
3. **`sourceEventSeqs` 必须覆盖全部被遮蔽节点**（宿主 append 校验的硬要求）。
4. **绝不能只靠进程内断言**：遮蔽的合法性只在**重放/折叠**时才最终判定 ⇒ 必须有"写盘 → 新进程/新 reader 折叠"的重放级用例。
5. 无 node 1+（只有 head，或表面为空）⇒ **skip，不 append**（否则每个新会话都留一条垃圾标记）。
6. 替换体只能用 `user/message`（`assistant/message` 不允许带 `sourceEventSeqs`）；`append` 的数据形状 = `{ id, role:'user', content:[{type:'text',text}], source:{kind:'user'} }`。

## 5. 由 spike 得到的其它事实（写入 §2.1/§2.5 候选）

- **公开面**：`Session.surface`（只读 `nodes` / `replaceGeneration` / `contentGeneration`）与 `Session.append(type, data, { surfaceOp, sourceEventSeqs })`；`SurfaceOp.replace` 的文档原话是「Used by compaction; **any surface-replacing producer may use it**」(`core/session/src/types.ts:455-460`)。
- **合法缝**：`agent/pre-step` 是宿主 compaction 做替换的同一缝（`compaction-basic/src/index.ts:158`），在此处 append 会进入**本次**请求。在 `session/event`（append 发布期）里同步 append 会被拒（`session append cannot reenter while another append is being published`），且监听器异常被吞 ⇒ 表现成"什么都没发生"。
- **head 只在首个 step 期间出现**：新建会话首个 `pre-step` 时表面为空（`SKIP 表面未就绪`），head 在首个 step 组装期追加 ⇒ **遮蔽只对"已经跑过至少一步"的会话可用**——正是"冷启动恢复的旧会话"这一目标场景。
- **辅助请求读日志、不读表面**：`session-title-first-prompt-llm` 发出
  `Generate the session title from this JSON array of human messages: [{"seq":3,"text":"SPIKE-OLD-1 …"}]`
  —— 即"旧历史不进模型"只对**对话请求**成立；标题这类从日志直接取料的调用仍能看到被遮蔽内容（MUD 场景下该内容是插件自产的任务书/行批次，且标题成功一次后不再重试）。
- `session.seq` 含非表面事件（建会话即 seq=3），故 `seq > 0` 只能当"可能有 history"的保守判据。
- 遮蔽标记是一条**未被 claim** 的 `user/message`，不会自行触发回合/步骤（RUN C 只出现一次请求）。

## 6. 官方文档核对（2026-10-06，`reference/subsystems/session` + `.../compaction`）

**一致（文档确认，非仅实测）**
- `SurfaceOp.replace` 的文档原话仍是「Used by compaction; **any surface-replacing producer may use it**」；`sourceEventSeqs` 要求「完整、非空的已知较早事件集合」。
- **node 0 保护是官方语义**：「surface 折叠**拒绝任何其他覆盖第 0 号节点 `system/message` 的替换**，而**后续系统节点是普通历史，压缩替换可以遮蔽它**」——与第 4 节的硬纪律同源（我的失败样本是"node 0 根本不是 system/message"，属同一不变量的另一端：日志被格式检查拒绝）。
- **`agent/pre-step` 是官方指定的替换缝**：「压力压缩在 `agent/pre-step` waterfall 中运行，**先于请求推导**」——与本机制"在 pre-step 遮蔽、本次请求即读到新表面"完全一致。
- `Session.surface` 只读（`nodes`/`replaceGeneration`/`contentGeneration`）；`session.snapshotEvents()` 与后端可持久化内容一致；`ctx.sessions.get(id)` 仅 live；`SessionStore` 无删除动词（`create`/`prepare`/`enter`/`announce`/`flush`/`get`/`list`/`fork` + `registerMessageProjection`）。
- `session/event` 是"提交后火并忘"的 emit，「observer 失败被记录并吞掉」——解释了第一次尝试里 `turn/end` 内的 append 报错没有任何输出的现象。

**文档补充的 4 处精确语义（已折进 T18）**
1. **端点语义 = surface 位置跨度，不是数值区间**：`shadowedRange` 的 `start`/`end` 是"被替换范围的**首/末 surface 节点** seq"；一次替换之后，新节点（高 seq）可能落在旧范围的位置上，因此**`start` 可以大于 `end`**。⇒ 计划里明令：按 surface 顺序取端点，**不得假设 seq 单调**；端点必须早于替换事件（surface 顺序）。
2. **`registerMessageProjection` 是另一条可用机制**：插件可注册纯投影处理器改写既有消息内容（`compaction-image-offload` 用它做图片省略）。但它让**会话与插件在场强绑定**——「缺少处理器时拒绝操作，包括恢复和独立折叠，卸载已经使用过的处理器后也会拒绝读取缓存」。⇒ 已评估不采用（本机制只要一条宿主已知事件的 append，不引入"插件缺席即拒读"的耦合）。
3. **不得声明新事件类型**：`SessionEventMap` 的未知**非 ignorable** 事件会让读取器「拒绝重建整条日志」。⇒ 只追加宿主已知的 `user/message`，不新增事件类型（诊断信息写在标记正文里）。
4. **工具对边界**：`compactRegion` 要求两端「balanced so assistant tool calls remain paired with their results」（`toolPairingBalancedBefore/After` 是其公开判定）。⇒ 若遮蔽跨度内含**未配对**的 `tool/call`（其结果将来才落盘），遮蔽会留下悬挂的 `tool/result`；实机缝是 pre-step（回合内步骤已闭合，正常无在飞调用），但仍要显式检查 + 用例覆盖。

**其它相关事实**
- `compaction/summary` 会把 `shadowedSeqs`/`shadowedRange` 写进日志（压缩自有的记账事件）；本机制**不需要**伴生记账事件——替换自身带 `surfaceOp` + `sourceEventSeqs`，可自解释。
- token 计价读当前 surface（`ctx.tokenMeter.measure(session)`）⇒ 被遮蔽节点自动不再计价，无需 shadow-price 伴生事件（pruner 的 shadow-price 是给"纯消费方"用的）。
- 持久化时点：loop 不在回合边界 await flush，`dsh-session-checkpoint-policy` 拥有每次请求的持久化检查点 ⇒ 遮蔽的落盘由宿主检查点保证（spike 已用一次冷启动往返验证）。

## 7. 与 T18 的关系

- 采用本机制后：**会话 id / 账号 id 不变** ⇒ 无 webui 重绑、无名册 schema 变更（`activated` 位不再需要）、无归档、无 `handled` 内存集、无轮换事务与回滚。
- 原「接入瞬间轮换」方案（含"先连接后接入会拆掉刚建的连接"缺陷）随之作废；遮蔽与 `connect`/`admit` 解耦，改由 `agent/pre-step` 触发。
- 唯一需要保留的独立项：宿主无会话删除面（§2.4 缺口①）——本机制**不**消解它，删除面跟踪照旧。

## 8. T18.2 生产接线实机冒烟（2026-10-06）

**资产**：`spike/smoke-probe.mjs`（零依赖探针）+ `spike/smoke.patch.yml`（probe + 真实 `packages/mud-core3/lib/index.js`）。
**做法**：临时 `DSH_HOME=D:\code\_spike\smoke\dshhome`（`profiles/web` 从真实家目录复制 4 个配置文件 + `profiles/node_modules` junction + `<profile>/node_modules/{mud-core3,mud-workflow}` junction 以满足宿主 peer 拦截），`dsh web --patch ... --port 3083 --no-open`；探针用**真实动词**建服务器/账号（`ctx.get('mudRemote').addServer/addAccount`），用 `ctx.get('sessionController').prompt` 驱动回合，用 `{prepend:true}` 的 `llm/stream` 捕获真实组装出的请求。真实家目录 `~/.dsh` 零写入。

**证据（phase 1：新会话，生产接线）**
```
agent/created session=session-385da2bc-… nodes=[] seq=3
req#1 bytes=50643 MARK=false OLD=true            ← 第 1 轮：表面空 ⇒ 预期 skip 且**不阻断**（请求照发）
turn1 end reason={"kind":"completed"}
after turn1 nodes=[7,8,9,14]
req#3 bytes=49737 MARK=true OLD=false NEW=true   ← 第 2 轮：遮蔽生效，旧文本消失、新文本在场
after turn2 nodes=[7,20,22,24] replaceGeneration=1
turn2 request: MARK=true OLD=false NEW=true ⇒ ASSERT-PASS ①
```

**证据（phase 2：新进程 create 同 id ⇒ 重放 + 再遮蔽）**
```
phase2 adopt ok session=session-385da2bc-…        ← 重放未判 corrupt（②-a）
phase2 nodes=[7,20,22,24] oldSeqs=[3,8,13] stillVisible=[]   ← 旧节点仍不在表面（②-b）
pre-step nodes=[7,20,22,24]                       ← 本节拍：接线读到的表面
event user/message#31                             ← 本进程新增的起点标记
event request/header#35
req#1 bytes=50817 MARK=true OLD=false NEW=false
phase2 after turn3 nodes=[7,31,33,34,36] replaceGeneration=2   ← 每进程恰好一次替换
phase2 本进程 epoch 标记在请求中=true（marks=[1791255139394] 本进程≈1791255139394）
turn3 request: MARK=true OLD=false THIRD=true ⇒ ASSERT-PASS ②-c
```
（`marks` 里的 epoch 与本进程 `Math.round(Date.now()-process.uptime()*1000)` 相同 ⇒ 请求里的标记是**本进程**写入的，不是上一进程的遗留。）

**对照与覆盖边界（诚实口径）**
- ③ 对照组（只追加不替换 ⇒ 旧文本仍在请求里）：由本文第 2 节的 spike RUN B2 覆盖（生产接线只做 replace，无对照分支）。
- ④「跨度含已配对 tool call/result」、⑤「后续 system 节点 / 未配对 tool/call ⇒ 保守 skip」：由纯层用例覆盖（`test/elide.spec.ts` ⑪/⑤/⑥/⑦）；端到端未复现——冒烟里模型调用被本插件自己的未接入闸门拦成空回合，故不产生 assistant/tool 事件。
- ⑥「遮蔽失败 ⇒ 阻断本步」：宿主 reject 语义由源码与宿主自测核实（`agent-loop/src/agent.ts:317-319`、`interception.spec.ts:250`），失败分支由适配层用例覆盖（`applyElision` ⑱–㉑）；未在真宿主里注入失败。
- 冒烟配方注意：探针**必须在退出前 `ctx.get('sessions').flush(session)`**——首次实现直接 `process.exit` 把日志截在半个回合，之后 resume 的进程不再起回合（表现为"prompt 无请求、无 turn/end"），且该会话状态不可自愈。

> AI生成

