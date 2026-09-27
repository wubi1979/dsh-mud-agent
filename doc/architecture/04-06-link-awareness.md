# 存在层与意识层（§4–§6）

> 宿主能力出处（`file:line`）相对 DSH 源码 `D:\Code\deepseek-harness`；查不到写 **NOT FOUND** → 自建或待实测。

---

## §4 存在层：连接与行流（link/）

文件：`link/mud.ts`（连接、行流分发、持有者、read 竞速机）、`link/telnet.ts`（telnet 协议层 IAC/MCCP2/GA/EOR → 边界事件）、`link/ansi.ts`（流式行解析，含跨块终止符与序列缓冲上限）、`link/corpus.ts`（行流 JSONL + log-only 事件，§16）。纯 TS、零宿主依赖，可独立回放测试。

```ts
class Mud {
  private conn: TelnetClient                // 自建出站（telnet.ts）
  private parser: AnsiStreamParser          // ansi.ts
  private buffer: MudLine[] = []            // 有界缓冲（512 行 / 64KB，超限丢最旧记错）
  private reading: WaitState | null = null  // 会话级持有者：唯一占行流的等待状态
  private holder: 'root' | `child:${string}` | null = null  // 持有者身份（fail-loud 用）

  onLine: (line: MudLine) => void           // 装配时注入 awareness.observe（永续）
  onBoundary: (kind: 'ga' | 'eor') => void
  send(cmd: string): void                   // 直发：反射/流程共用；不占行流
  read(o: WaitOpts): Promise<ReadResult>    // 竞速机（§5）
}
```

- socket → telnet.decode → ansi.write → 逐行 `onLine`（推送式，不新建循环）；
- GA/EOR 由 telnet 提取为 `onBoundary`（协议边界唯一出口）；frame boundary 由 GA/EOR（80% 置信）与声明判据（100% 置信）两类标记共同确定，静默与超时**不是**边界；
- **行分发顺序**：每行先意识层（`onLine` 永远执行，与谁在等无关），再归 wait（若 `reading` 非空）——意识层永远看得见行流，"永续供给"的实现；
- `send` 不占行流：反射永不被持有者阻塞；**直发对宿主不可见**（不经 `tools` 管线，无 `pre-execute`、无留痕）——留痕靠 `corpus.ts` 自记；
- **持有者是会话级的**：根与子级都持有全套工具，若并发 read 会各拿半截行 ⇒ `mud_send`/`mud_flow` 入口检查 `holder`，冲突即 fail loud（不做队列）；
- **send 帧格式**：缺省发送字节 + 自动补 `\r\n`；翻页空命令的精确字节 **待实测核对**（§19）；
- **断线** = socket close 事件（非行）：在途 read 以 `reason:'disconnected'` 收束、流程结束、经危险 latch 醒根、登录标志复位；重连缺省为下次 `mud_send` 隐式建连 + login，策略 **§19 待实测校准**（宿主 resume 只恢复历史不恢复 socket，`NOT FOUND`；超时按放弃处理、不按结算，回放记录只进诊断日志）。

**禁令**：不解释语义、不做危险判断（判据在 danger，§6）。

---

## §5 行等待竞速（mud.ts 内部实现细节）

```
read(o):
  1. 持有者检查：本会话已有持有者 → 抛错（fail-loud，不做队列）
  2. 先消费 buffer（rest 同帧移交：本次 send 之前的到达行先结算）
  3. 建竞速状态 { opts, acc, lines, gaSeen, quietTimer, timeoutTimer, signal }
  4. 判定序（写死）：danger > failOn > until > gaCount > quietMs > timeoutMs > maxLines
     - danger：行到达钩子同步测（与意识层同一份 danger.ts，§6）
     - failOn / until：在 acc（累积文本）上测——**完成句可跨批命中**（实录语料事实）
     - gaCount：onBoundary 钩子计数
     - quiet / timeout：计时器；maxLines：行数兜底（帧记忆阀门 256 行，OOM 保护）
     - **signal：`exec.signal` 中止 → 立即以 reason:'aborted' 收束并释放持有者**（释放阀门，I7）
  5. resolve → ReadResult{lines, reason, rest?}；持有者置空
```

- **`timeoutMs` 必须显式给出或由工具注入缺省**：绝不无界等待（否则子级永不到达 quiescence，占着激活槽）；
- 声明了 `until` 却以 `quiet`/`timeout` 收场 → 记 error（判据失配要吵，语料可见）；
- 危险命中 → 以 `reason:'danger'` 返回，流程按 §13 危险出口结束；
- **直发输出：反射类"吞触发行、留结果"**（§6）——反射的**触发那一行**不进模型面，其应答照常进并参与判据；
- `ask` 不在此处：等人发生在根侧工具结果回流之后，不存在跨会话挂起。

**禁令**：竞速机不持有业务状态（不记世界、不做唤醒决策——danger 命中的唤醒由意识层/根侧结算处理）。

---

## §6 反射与意识（awareness/）

### 6.1 每行调度（observe.ts，薄）

```ts
observe(line):                                    // 每行执行，薄
  world.reduce(line)                              // 抓取：HP/内力/位置/战斗态
  const d = danger.match(line)
  if (d) {
    if (d.interrupt) mud.send('halt')             // 紧急中断当前活动（细则暂不设计，见 6.5）
    if (d.wake) wake.steer(d)                     // 连续谱：判据自带动作意图
    if (d.abortWait) reading?.abort('danger')     // 行等待中断（reason:'danger'）
  }
  for (const r of REFLEX) if (r.re.test(line.text)) { swallow(line); mud.send(r.cmd) }  // 吞触发行、留结果
  wake.armSilence()                              // 静默重置（重新武装锚点：新行到达）
```

**REFLEX 表**（反射：天然无后果的机械反应）：

```ts
const REFLEX = [                                  // 反射：天然无后果的机械反应
  { re: /系统将在.*分钟后存档|请及时存档/, cmd: 'save' },
  { re: /按回车继续| press enter/i,     cmd: '' },  // 翻页空命令
]
```

入选纪律：只放天然无后果动作；直发走 mud.send（宿主不可见，§4）。

### 6.2 危险判据：一份数据、字段化动作意图

`{ re, interrupt?, wake?, abortWait?, why }`——一张表同时服务紧急中断、等待中断、T2 唤醒，不许两处派生。危险唤醒的**去重 latch 挂世界状态、不挂行模式**：行模式（"遭攻击"逐行命中）会在战斗**每回合**重新武装 → 每回合唤醒根，与 I1 冲突。latch 用 `world` 字段（如 `inCombat`），一次战斗一条 latch，条件解除才重新武装。

### 6.3 反射与意识的分界（"知道为什么"）

分水岭是**"知道为什么"**：不需要知道为什么、后果也不管的动作放反射层（save、翻页——天然无后果，多发无害）；需要"知道为什么"的动作归意识层（如觉察到危险要中断当前活动）。误判后果：若把"要中断当前活动"这类判断放进反射层，就得写成"行文特征 → 命令"的映射表——危险形态每多一种就改一次表，且无法解释为什么发。

细则：

- **反射动作吞掉触发它的那一行**（提示文本对模型零信息量），但**保留命令的应答**（"存档失败"这类负面结果不能被静默吞掉）；语料与日志始终保留全部行——"吞"只作用于模型可见面；
- 意识层的动作**无输出特例**：照常进模型面、照常参与判据——它的必要性由输出自身揭示（需要的给信息、不需要的给无害噪声）。

### 6.4 越界不唤醒

HP 缓降、进入战斗等无行可警的越界只更新 `world`，随静默唤醒摘要上浮（§9）；行级可警（遭攻击/死亡/断线）仍立即——意识层因此**不长第四条计时链路**（§7）。

### 6.5 紧急响应：三级，单向升级

| 层级 | 场景 | 机制 |
|---|---|---|
| **意识**（0ms） | 遭袭 / 叫杀的第一反应 | 中断当前活动，使角色能接受后续指令（逃/战）；只中断不定向，去向由预案或 T2 决定；觉察后视判据级别同时唤醒 T2 |
| **子 agent**（执行智能） | 计划内的常见意外、可逆即时处置 | 预案动作，不上报；处置不了携现场上报 |
| **T2**（重规划） | 目标级变化、没见过的危险 | 携现场唤醒 |
| **硬底线** | 死亡 / 断线 / 凭据 | 意识层代码直接拦截，不依赖任何模型 |

**不存在"打断仲裁"**（I4）：没有两个执行者争控制权，只有单向的"处置不了就升级"。

**"中断当前活动"的具体用法暂不设计**：它本质是流程性、防御性的操作（切换活动前先中断手里的活），等真实场景需要区分对待时再补规则。当前只需知道一点：它会中止正在进行的活动、是有后果的动作，因此不许对有收益的活动主动发。

**禁令**：只感知与触发，不解释内容、不生成动作序列、不持有目标。
