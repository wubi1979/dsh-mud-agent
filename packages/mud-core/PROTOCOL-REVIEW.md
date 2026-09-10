# dsh-mud 协议层 vs Mudlet ctelnet：数据流失归纳

范围：`packages/mud-core/src/network/telnet.ts`（入站解码/协商/MCCP2）+ `packages/mud-core/src/preprocess/ansi.ts`（行/ANSI）。
参照物：`Mudlet/src/ctelnet.cpp`（`processSocketData` / `decompressBuffer` / `processTelnetCommand`）。
验证手段：`tests/probe-client.mjs` 对真实服务器 `mud.pkuxkx.net:8081` 的抓包（会话日志 `.log` + 原始字节 `.bin`）。

---

## 1. 结论先行

**正常 pkuxkx 登录路径不丢字节。** 抓包证据（3463B 横幅 + 协商，3 个 TCP 块）：

- telnet.ts 三层流水线（字节解码 → AnsiStreamParser 行切分 → 300ms 静默/GA 刷出）在真实流量下工作正常；
- 登录横幅 `\r\n` 逐行产出；无换行的名字提示行由 300ms 静默定时器刷成完整行（模拟实验中 0.4s 内可见）；
- 协商（TTYPE/NAWS/CHARSET/MSSP/GMCP）全部按预期应答，CHARSET 回 ACCEPTED UTF-8。

**存在 4 个与 Mudlet 的行为差异，其中 2 个在"服务器发异常协议流"时会真正丢数据**，另 1 个是登录层（非协议层）的真实阻断 bug。

---

## 1b. 真实全流程登录抓包补充 (2026-09-10, 两次 90s 会话: 59 块/10092B + 82 块/37471B)

`probe-2026-09-10T01-26-41-842Z.log`/`.bin`（简化模式）+ `probe-2026-09-10T01-52-46-052Z.log`/`.bin`（完整模式）真实账号全流程验证，协议层表现全部正常，另发现两个**登录层问题**：

- **名字提示长短两版**：横幅给出长版 `您的英文名字（要注册新人物请输入new。）：`；选完编码（回 `2`）后服务器改为短版 `您的英文名字：`（实测 hex 证据），且此前会插入 `编码已改为UTF-8。` 与两条 MushClient 提示。原 `login:name` 规则只匹配长版 → 正式登录卡死。**已修复**：规则放宽为长短版双正则。
- **fullme 简化模式**：账号长期未 fullme 时，服务器把房间输出降为"最简化信息"——`look`/`w` 只有房间名+区域+NPC 列表，**无房间描述、无 exits 文本**；GMCP 仅 `System`（`site`）与 `Move`（`dir`+`short`）两类。对协议层无影响（字节完整到达），但会显著削弱感知/规则样本质量（`room.desc`/`room.exits` 均缺失）。
- 另确认：登录期 GA 存在（名字/密码提示后各一）——telnet.ts 注释已修正；服务器有 MXP 检测流程（发 `<SUPPORT>` 等 5s，无响应自动降级普通文本模式），dsh-mud 不支持 MXP 会同样降级，无碍；密码输入期间 ECHO 协商（WILL→DO→WONT）工作正常。

**第二次完整会话 (2026-09-10 09:52, 90s, 82 块 / 37471B；.log 见仓库根 `probe-2026-09-10T01-52-46-052Z.log`)** —— fullme 解封后的完整信息 + 命令序列 17 条节奏验证。新增协议证据：

- **GA = 命令回复边界**：17 条命令（look/w/w/check/e/e/id/give/up/enter/dazuo/hp/score/sk/lm/sleep/dz）的每条回复末尾都收到 1 个 `IAC GA`（共 20 个 GA = 登录 3 + 命令 17），多数紧随 `\x1b[2;37;0m> ` 提示符。
- **被动推送无 GA**：`dz` 打坐的 44 条经脉渐进输出（1 条/秒、每条 131-134B、`\x1b[1;35m` 色 + `\x1b[2;37;0m` 复位、无 `> ` 无 GA）**全程无一 GA**。→ 靠 GA 触发动作无法覆盖被动推送，**400ms 空闲刷出是切分这类输出唯一可靠手段**（探针即靠 armIdle 正确逐行切分）。
- **地図分页界面**：`lm` 输出 88% 评价地图后停在 `== 未完继续 88% == (q 离开，b 前一页，其他继续下一页)`；此时发送任意命令（探针的 `sleep`）会**被当翻页输入吞掉**（实测：sleep 未执行，仅翻到图例页）。分页界面下 GA/prompt 照发。→ 客户端必须实现自动翻页（检测 `== 未完继续` 后交回车/空格），否则命令在分页处全部失真——**对 dsh-mud 是新的 P1 需求**。
- **完整房间信息确认（fullme 解封后）**：`look`/`w` 返回 = ASCII 地图（彩色、`1;32/1;31/1;36` 标记当前/相邻/区域）+ 房间名/区域行 + 2-3 段描述 + `「初夏」` 时辰行 + `这里明显的出口有…` + NPC 列表；GMCP.Move 的 `dir` 与 exits 文本一致。
- **表格类输出**：`hp`/`score`/`sk`/`lm` 均为 ANSI 色 + 全角框线（┌─┐│└┘）表格，ANSI 剥离后列对齐成立。TELNET 协商事件 30 起全部正确应答，协议层保持零丢字节（TXT 文本与 .bin 逐块核对无缺失、无半截 UTF-8）。

**第三次完整会话 (2026-09-10 11:44, 180s, 93 块 / 39130B；`probe-2026-09-10T03-44-46-144Z.log`)** —— 探针自带分页翻页后重取完整样本（无凭据记录如下命令）：
- **分页翻页生效**：`lm` 的 `== 未完继续 88% ==` 命中即发空格（02.265），图例页随之刷出、命令不被吞；后续 `sleep` 正常执行。→ `pager:continue` 探针版与产品版行为一致。
- **sleep 真实周期 ≈ 13.5s**：`你往床上一躺，开始睡觉。→ 不一会儿，你就进入了梦乡。`（03:45:03.087 GA）→ `你一觉醒来，精神抖擞地活动了几下手脚。`（03:45:16.547，自躺下约 13.5s）。> 28s 等待绰绰有余（此前"28s 未醒"来自 sleep 被吞作翻页的那一轮，属误判）。自动化 sleep 任务等 20s 即够。
- **dz 完整周期 ≈ 55.8s**（03:45:41.046 发起 → 03:46:36.880 完结）：发起时 1 个 GA（`你在膝下盘膝坐下，默运太极神功，一股内息自丹田引出……`），随后 **57 条经脉渐进推送（1 条/秒，125-137B，均 `\x1b[1;35m` 亮紫 + `\x1b[2;37;0m` 复位，无 `> ` 无 GA）**，期间混入公频推送（`【自创剧情】……`，37B 橙色 `[36m`）。
- **dz 完结句**：`你将运转于全身经脉间的内息收回丹田，深深吸了口气，站了起来。` —— `\x1b[1;32m` 亮绿，与推送的亮紫截然区分；**该句是 dz 完成唯一信号（无 GA、无提示符）** → agent 打坐任务以此句判定结束。
- 协议层依旧零丢字节：93 块全部命中 RX 计数，文本与 .bin 一致。

---

## 2. 逐点对比

### 2.1 子协商内出现"裸 IAC + 非 SE/IAC 字节" —— **会吞文本**

服务端若在 `IAC SB <选项> ...` 载荷里混入一个孤立的 `IAC X`（X ≠ IAC/SE），两类客户端进入不同恢复路径：

| | Mudlet | dsh-mud 现状 |
|---|---|---|
| 处理 | SB 内 `iac=true` 后遇到非 SE/IAC 字节：弹出该字节、**就地补一个 IAC SE 结束本次子协商**，把当前字节按"IAC 命令"回放，之后**立即恢复为普通文本解析**，并告警 `#4385`（ctelnet.cpp:5749-5769） | `findSubnegEnd` 把 `IAC X` 当转义对 `i += 2` 跳过，**继续向后续文本里找 IAC SE**（telnet.ts:253-264） |
| 后果 | 恢复快，最多丢一两个字节 | `IAC SB ... IAC X <这里之后的全部屏幕文本> ... IAC SE` 中间的所有文本被吞进子协商载荷，**从显示/感知层消失**；若服务器一直不发 IAC SE，则永久吞到断流 |
| 风险评估 | — | pkuxkx 当前不发病例；但 GMCP 大包/编码错位等场景存在理论触发面 |

建议：`findSubnegEnd` 遇到 `IAC + (非 IAC/SE)` 时对齐 Mudlet —— 就地截断并回放当前字节（或至少同样加长度上限，见 2.2，避免无界吞文本）。

### 2.2 永不终止的子协商（无 IAC SE 洪水）—— **内存无界增长**

- Mudlet：`command.size() > MAX_TELNET_SUBNEGOTIATION_LENGTH` 时置 `mDiscardingOversizedSubnegotiation`，**丢弃到下一个 IAC SE**，随后恢复（ctelnet.cpp:5727-5739）。内存有界、可自愈、有告警。
- dsh-mud：`findSubnegEnd` 对整块 buffer 线性扫描，无长度上限 → 服务器异常持续灌 `IAC SB` 时，`this.buffer` 无限膨胀，其间所有文本全部不可见，直到 SE 或断连。
- 影响：MCCP2 裸 deflate 切换失败等异常路径叠加时，存在内存耗尽/感知黑屏风险。建议加子协商长度上限（±64KB）并按 Mudlet 丢弃至下一个 SE。

### 2.3 MCCP2 中间块损坏 —— **会话后半程永久静默（最严重）**

MCCP2 在连接建立时只发一次 `IAC SB COMPRESS2 IAC SE` 标记，之后整条流持续压缩。中间某块 zlib 数据损坏时：

| | Mudlet | dsh-mud 现状 |
|---|---|---|
| 处理 | `inflate()` 返回 Z_DATA_ERROR 等：**关压缩**（inflateEnd + `mNeedDecompression=false`）、向服务器发 `IAC DONT COMPRESS2`、`initStreamDecompressor()` 重新布防等下一个标记、并把**未消费的尾部按明文重放**（ctelnet.cpp:5245-5263, 5576-5584）。最多显示乱码，连接继续可用 | 一次 `inf.on('error')` 只打日志 "本块尾部已丢弃"，随后 **`mccp2` 仍为 true、`inflate` 仍是坏对象**，此后每个后续块都喂给坏 inflate → 全部丢弃，且没有下一个标记来"重启新块"（telnet.ts:436-447, 451-458） |
| 后果 | 显示乱码但可恢复 | **从损坏点起，会话剩余全部数据静默丢失**（黑屏/感知空白），且不告知服务器停压缩 |

建议：解压错误且已 `inflateReady` 时对齐 Mudlet —— `mccp2=false; inflate=null`（丢弃坏流）、发 `DONT COMPRESS2`、把剩余字节按明文重放。至少保证连接不残废。

### 2.4 EOR(239) 提交标志 —— **提示符不及时**

- Mudlet：GA **与 EOR 等价地** 触发提交（`case TN_GA: case TN_EOR: recvdGA=true` → `gotPrompt`，ctelnet.cpp:3025-3030）；且会 `DO EOR` 协商（3052-3056）。
- dsh-mud：`processBuffer` 只处理 GA（telnet.ts:239-246），EOR 落入 "skip two bytes" 分支；且 ACCEPT 集合不含 EOR → 服务器 WILL EOR 时回 DONT。
- pkuxkx 实测（完整会话 82 块/37471B）：**登录期即有 GA**（编码选择后、名字提示、密码提示各一次），且每条命令回复末尾必有 1 个 GA；但被动推送（dz 打坐经脉逐条输出，44 条）**无 GA**。GA 是"命令已处理完"的边界，不是"所有输出"的边界——dsh-mud 靠 GA 触发动作之外，仍需 400ms 空闲刷出兜底（现已具备）。EOR 至今在 mccp2 关闭的前提下未见服务器使用；低成本建议仍有效：把 EOR 也当 GA 处理。

### 2.5 附录性差异（当前无实际影响）

- SB 内 `IAC IAC` 转义：Mudlet 在载荷中保留一个字面 IAC（pop_back 去掉第二个，ctelnet.cpp:5746-5748）；dsh-mud 跳过对不保留。GMCP/MSSP/CHARSET 载荷均为 ASCII，实践影响 ≈ 0；若未来做二进制子协商则需对齐。
- 编码：dsh-mud 硬编码 UTF-8（TextDecoder，主/子解码器分离 —— 这点处理正确，避免跨包多字节错位）；Mudlet 支持 GBK/Big5 等全字符集。8081 登录的编码选择为可选步骤（CHARSET ACCEPTED UTF-8 后无需回选），见 §3。
- 控制字符：Mudlet 在源上剥 `\r`/`\0`（ctelnet.cpp:5788-5789）；dsh-mud 保留在 `raw` 视图、仅 `text` 视图剔除 —— 属于设计选择，非丢失。

---

## 3. 登录层编码选择 —— 实测结论（三探针轮次往返，最终定论）

真实 pkuxkx（8081）登录序列文本：

```
Input 1 for GBK, 2 for UTF8, 3 for BIG5   ← 编码三选一提示
您的英文名字（要注册新人物请输入new。）：   ← 名字提示（无换行符，靠空闲刷出）
请输入密码：
```

- 前两轮探针收到 `Input 1 for GBK` 即回 `2`，**从未试过不回** → 当时误写成"必须先答 2，否则卡死"（§ 历史结论，已作废）。
- **第三轮（2026-09-10 11:20，`probe-2026-09-10T03-20-34-345Z.log`）加 `--no-select2` 实测：CHARSET ACCEPTED UTF-8 后不回 2，名字提示照常自动出现**（无"编码已改为UTF-8"确认），登录完整走通（密码→欢迎→命令序列全跑完）。
- **结论：8081 端口选编码是可选步骤，非阻断。** 前提是完成 CHARSET 协商（应 UTF-8）。`login:encoding` 规则已移除（2026-09-10）。名字提示/编码提示均无换行符 → 客户端的**空闲刷出**机制必须存在（dsh-mud scheduleFlush 已具备）。
- 教训：单轮"没试过不发/不答"不能当"必须如此"的结论——一切以覆盖到反证的实测为准。

---

## 4. 复现与产物

```pwsh
# 抓登录横幅（无凭据，≤20s 自动结束）
cd D:\Code\dsh-mud-agent\packages\mud-core
pnpm probe                       # node tests/probe-client.mjs
pnpm probe -- --user NAME --pass PASSWORD   # 完整登录：编码→名字→密码→命令序列
                                            # 默认命令序列(每秒1条, sleep后等28s):
                                            #   look,w,w,check,e,e,id,"give 2 silver to biao",
                                            #   up,enter,"dazuo 10",hp,score,sk,lm,sleep,dz
                                            # --send <命令> 可追加; --wait <ms> 调总时长
# 可选: --out 指定 .log/.bin 输出; --accept-compression 镜像 mud-core 的 MCCP2 路径
```

产物：`.log`（hex dump + TXT/PROMPT 文本视图 + TELNET 协商事件）、`.bin`（原始字节，可离线回放比对）。

---

## 5. 建议整改优先级

| # | 项 | 优先级 | 工作量 |
|---|---|---|---|
| R1 | ~~登录规则补"编码选择 → 2"~~ **已撤销**（§3 第三轮实测：选编码非阻断，rule 已移除） | — | — |
| R1b | `login:name` 同时匹配长短两版名字提示（§1b） | **已实现**（双正则，保留） | 极小 |
| R5 | 分页界面自动翻页：`== 未完继续 NN% ==`/(`-- more --`) 检测并交空格（§1b） | **已实现** (trigger-rules.ts `pager:continue`, 含 1s 节流) | 小 |
| R2 | 子协商长度上限 + 无界吞文本防护（§2.1/2.2） | P1 | 小 |
| R3 | MCCP2 出错后关压缩 + 明文重放（§2.3） | P1 | 中 |
| R4 | EOR 视同 GA（§2.4） | P2 | 极小 |