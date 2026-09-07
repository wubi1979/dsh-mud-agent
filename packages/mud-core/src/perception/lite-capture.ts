/**
 * dsh-mud-core — 感知 lite 捕获器 (LiteCapture), host half.
 *
 * v5 架构的「捕获 → lite 发送链」: 感知事件 (mud/percept) 命中确定性动作时,
 * 不直接调工具, 而是构造一个 lite marker, 经 `sendLite` 交给触发器 LLM 通道
 * (TriggerRouter) — 借道官方 agent 工具管道 (mud_send) 执行。
 *
 * 与旧 decision-rules 的 action:"tool" 的区别:
 *   - 旧: dispatcher 在 host 侧直接调 mudTools 执行 (旁路 agent);
 *   - 新: 捕获 → lite marker → agent 会话 → 确定性 adapter → 官方工具管道。
 *   工具执行路径统一为 agent 视角, 触发器的动作可被 agent 上下文追溯。
 *
 * 支持两类动作:
 *   - 抢占 (interrupt): 战斗等"等不起 LLM 延时"的高优先级反射 — 调用方先
 *     cancel(keepInbox) 打断当前回合, 再 send lite;
 *   - 普通 (next-turn): 低优先级的确定性跟随 (如战斗结束 look 刷新)。
 *
 * 依赖注入 (host 装配时提供), 使本模块可在纯桩下独立单测:
 *   bus       cordis ctx (订阅 mud/percept);
 *   actions   事件类型 → lite 动作表;
 *   guard     发送守卫 (如 world.flags.logged_in + agent 就绪);
 *   sendLite  实际发送 (index.ts 里装配成 interrupt + agent.send)。
 *
 * @module @deepseek-ai/dsh-mud-core/perception/lite-capture
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MudPerceptEvent } from '../events.ts'
import type { LiteMarker } from '../trigger-llm/types.ts'

/** 一个确定性 lite 动作的定义 (触发同一事件即发起)。 */
export interface LiteActionDef {
  /** 动作名 (显示用)。 */
  label: string
  /** 要执行的工具调用列表。 */
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
  /** 是否抢占 (interrupt): 先 cancel(keepInbox) 打断当前回合再发。 */
  interrupt?: boolean
  /** 同类事件去重窗口 (ms); 默认 LITE_CAPTURE_DEDUP_MS。 */
  dedupMs?: number
}

/** LiteCapture 构造参数。 */
export interface LiteCaptureOptions {
  /** 事件总线 (订阅 mud/percept)。 */
  bus: Pick<Context, 'events'>
  /** 事件类型 (mud/percept type) → lite 动作。 */
  actions: Record<string, LiteActionDef>
  /** 发送守卫: 返回 false 则本次捕获丢弃 (如未登录 / agent 未就绪)。 */
  guard?: () => boolean
  /** 实际发送 lite 消息 (host 装配)。 */
  sendLite: (marker: LiteMarker) => void
}

/** 同类事件短时去重默认窗口 (ms)。 */
export const LITE_CAPTURE_DEDUP_MS = 1500

/**
 * 感知 lite 捕获器: 订阅感知事件 → 命中动作表 → 构造 lite marker → sendLite。
 * 独立于 agent 生命周期; host 通过 guard/sendLite 注入运行时上下文。
 */
export class LiteCapture {
  private readonly actions: Record<string, LiteActionDef>
  private readonly guard: () => boolean
  private readonly sendLite: (marker: LiteMarker) => void
  /** 去重: eventType → 上次发送时间戳。 */
  private readonly lastSent = new Map<string, number>()
  private readonly disposeListener: () => void
  /** 计数器 (测试/诊断)。 */
  captures = 0

  constructor({ bus, actions, guard = () => true, sendLite }: LiteCaptureOptions) {
    this.actions = actions
    this.guard = guard
    this.sendLite = sendLite
    this.disposeListener = bus.events.on('mud/percept', (e: MudPerceptEvent) => {
      this.onPercept(e)
    })
  }

  /** 感知事件 → 命中动作 → 构造 marker → sendLite (带守卫与去重)。 */
  private onPercept(event: MudPerceptEvent): void {
    const def = this.actions[event.type]
    if (def === undefined) return
    if (!this.guard()) return
    const dedupMs = def.dedupMs ?? LITE_CAPTURE_DEDUP_MS
    const last = this.lastSent.get(event.type) ?? 0
    const now = Date.now()
    if (now - last < dedupMs) return // 同类事件短时去重
    this.lastSent.set(event.type, now)

    const capturedText = typeof event.data?.line === 'string'
      ? String(event.data.line)
      : ''
    const marker: LiteMarker = {
      kind: 'lite',
      entryId: `lite-${event.type}-${now.toString(36)}`,
      groupId: event.type,
      capturedText: capturedText !== '' ? [capturedText] : [],
      actionTemplate: def.toolCalls.map(t => t.name).join('+'),
      renderedCmd: def.label,
      toolCalls: def.toolCalls,
    }
    this.captures += 1
    this.sendLite(marker)
  }

  /** 是否该事件需要抢占 (interrupt)。 */
  requiresInterrupt(eventType: string): boolean {
    return (this.actions[eventType]?.interrupt ?? false) === true
  }

  dispose(): void {
    this.disposeListener()
    this.lastSent.clear()
  }
}
