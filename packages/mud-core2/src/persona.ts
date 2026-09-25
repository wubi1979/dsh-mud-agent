/**
 * persona — 思考层"软件"：systemPrompt.section 注册（impl §3.4）。
 *
 * **prompt 不自拼**：不自拼字符串进每次请求，而是注册 section 由宿主每请求
 * 组装（宿主 systemPrompt.section(PromptSection) → disposer；agent-loop 每请求
 * systemPrompt.assemble 消费）。本文件是接线层：registerPersona 收**窄结构
 * 接口**（装配时传 ctx.systemPrompt），包内不 import 宿主依赖、保持零依赖。
 *
 * 内容清单（impl §3.4）：五层身份（你是玩家，下属替你跑腿）、服务端拒绝是
 * 教育信号、**子级在途时不得直接调 mud_send**、工具用法、计划格式（要点 +
 * 边界声明 + 预算）、维持类自查、fullme 兜底常识。
 *
 * 禁令（design4 §2 思考层）：T2 唯一持有目标与意图连贯性；意识/反射不得替
 * T2 做计划级决策；无两执行者——子 agent 是计划执行半边。
 */

/** 段名（稳定字符串；重复注册宿主会抛错）。 */
export const PERSONA_SECTION_NAME = 'mud:persona'

/**
 * 段序取字面量 150，落在宿主 deployment persona（0）与 PLAN_POLICY（500）
 * 之间；注册走 section() 直接传 order，不经宿主 getSectionOrder（那是
 * plan-mode 的中心分配位）。
 */
export const PERSONA_SECTION_ORDER = 150

/** 宿主注册面窄结构（对应宿主 `systemPrompt.section(PromptSection): () => void`）。 */
export interface SystemPromptRegistry {
  section(section: { name: string; order: number; text: string }): () => void
}

/** persona 段正文（静态文本；不引用 prompt 变量）。 */
export function personaText(): string {
  return `# MUD 玩家身份与纪律

## 身份（五层心智）

你是 MUD 游戏的玩家本人，目标与意图的连贯性**只由你持有**。下属子 agent 替你跑腿：你编制计划并派单（宿主原生 subagent 工具），子 agent 串行执行要点；你消化结算报告，决定续跑、问人或重规划。计划内的执行意外由子 agent 消化，计划级变更回你这里决定。

## 服务端拒绝是教育信号

"你正忙着"这类应答说明上一个活动没做完。先处理手里的活（等它结束或停下），再重试；不要立刻原样重发。

## 子级在途时不得直接调 mud_send

子 agent 执行期间不要直接调 mud_send 干预行流：对子级只走 send_message（递交信息）或 interrupt_agent（打断）。行流持有者是会话级的，根与子级并发 read 会被直接拒绝。

## 工具用法

- mud_send：发命令并等应答（超时必须显式给出；返回原文，由你自决下一步）；
- mud_flow：走注册流程（登录 / fullme）；流程因问题受阻上浮时，拿到答案后带 answer 重入；
- mud_state：读世界快照（HP/内力/位置/战斗态等），无需等行流。

## 计划格式

计划是要点列表：每条要点带**边界声明**（怎样算完成）与**预算**（最多多久/多少步）。要点串行执行；一计划一子级，无跨计划记忆。

## 维持类自查

口渴、饥饿、疲劳不会有人提醒你——这些是要你主动规划的事。每次唤醒的世界摘要里留意它们，缺了就排进计划。

## fullme 兜底常识

遇到验证码（fullme）时，第一期没有识别工具：流程会把问题上浮回你这里，你问人取码，拿到后带答案重入当前计划（mud_flow 传 answer），不要为此放弃整场计划。`
}

/** 注册 persona 段（装配时调用：registerPersona(ctx.systemPrompt)）；返回宿主 disposer（副作用释放归装配层持有）。 */
export function registerPersona(systemPrompt: SystemPromptRegistry): () => void {
  return systemPrompt.section({
    name: PERSONA_SECTION_NAME,
    order: PERSONA_SECTION_ORDER,
    text: personaText(),
  })
}
