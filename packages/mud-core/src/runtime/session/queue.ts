/**
 * dsh-mud-core — 执行层 (Execution), host half.
 *
 * 只有一条执行路径: **工具调用**。路径 A (标准 agent) 和路径 B (触发器 lite
 * 模拟 LLM) 都通过同一个工具集向游戏发命令; 决策路由只决定"谁决定调用
 * 工具", 不另设执行机制 (无流程引擎 / 无状态机)。
 *
 * 命令队列: 最小间隔节流 (默认 400ms) + 优先级 (halt > high > normal > low),
 * 防止规则动作与 agent 连发命令时洪水游戏服务器。
 * @module @deepseek-ai/dsh-mud-core/runtime/session/queue
 */

/** 队列优先级: 数字越小越先发出。 */
export const QUEUE_PRIORITY = { halt: 0, high: 10, normal: 20, low: 30 } as const

/** 命令发送元数据。 */
export interface CommandMeta {
  priority?: keyof typeof QUEUE_PRIORITY
  source?: string
  /** 回显归属 (R2-2): 工具/规则 → 'agent'; 手动/WebUI 命令 → 'user'。 */
  actor?: 'agent' | 'user' | 'system'
  /** 在途窗口 (§17 W7.2 取代命令-应答桥): 窗口 id。队列只透传不消费;
   *  onSend 时宿主据其实调 windows.confirmSent (真实写 socket 后武装)。 */
  replyId?: string
  /**
   * 直发延后豁免 (§2.8): 在途窗口自身命令置 true —— 窗口开启 (gate) 期间仍照常发送。
   * 非豁免命令在窗口开启期间被压住 (排序降到豁免命令之后), 窗口结算后放行,
   * 防止直发应答的 GA 污染窗口的 N-GA 计数。
   */
  noGate?: boolean
}

/** 一条排队命令。 */
interface QueueItem {
  cmd: string
  priority: number
  meta: CommandMeta
  at: number
}

/** 命令队列: 节流 + 优先级。send() 立即入队, 内部按最小间隔顺序发出。 */
export class CommandQueue {
  readonly minInterval: number
  private readonly onSend: ((cmd: string, meta: CommandMeta) => void) | null
  private queue: QueueItem[] = []
  private lastSentAt = 0
  private pendingTimer: ReturnType<typeof setTimeout> | null = null
  private sentCount = 0
  /** 直发延后 gate (§2.8): 在途窗口开启期间为 true (在途窗口表经宿主 setGate 接线)。 */
  private gateActive = false

  constructor({ minInterval = 400, onSend = null }: {
    minInterval?: number
    onSend?: ((cmd: string, meta: CommandMeta) => void) | null
  } = {}) {
    this.minInterval = minInterval
    this.onSend = onSend
  }

  /** 入队命令。 */
  send(cmd: string, meta: CommandMeta = {}): void {
    this.queue.push({
      cmd: String(cmd),
      priority: QUEUE_PRIORITY[meta.priority ?? 'normal'] ?? QUEUE_PRIORITY.normal,
      meta,
      at: Date.now(),
    })
    this.sortQueue()
    this.kick()
  }

  /**
   * 直发延后 gate (§2.8): 在途窗口开启期间, 非豁免命令 (非 `noGate` 且非 halt)
   * 挂住不发, 窗口结算后 (`setGate(false)`) 放行。排序规则: gate 激活时
   * halt > 窗口自身命令 (noGate) > 其余 (压底); gate 关闭时恢复纯优先级序。
   */
  setGate(active: boolean): void {
    if (this.gateActive === active) return
    this.gateActive = active
    this.sortQueue()
    this.kick()
  }

  /** gate 豁免级: 0 = 总是放行 (halt / gate 未激活), 1 = 窗口自身命令, 2 = 压底。 */
  private gateRank(item: QueueItem): number {
    if (!this.gateActive || item.priority === QUEUE_PRIORITY.halt) return 0
    return item.meta.noGate === true ? 1 : 2
  }

  /** 重排: gate 豁免级 → 优先级 → 到达序。 */
  private sortQueue(): void {
    this.queue.sort((a, b) =>
      this.gateRank(a) - this.gateRank(b) || a.priority - b.priority || a.at - b.at)
  }

  private kick(): void {
    if (this.pendingTimer) return
    const item = this.queue[0]
    if (!item) return
    const wait = Math.max(0, this.lastSentAt + this.minInterval - Date.now())
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const next = this.queue[0]
      if (!next) return
      // gate 复查 (定时器排队期间 gate 可能已激活): 非豁免队头挂住, 等 setGate(false) 再 kick。
      if (this.gateRank(next) === 2) return
      this.queue.shift()
      this.lastSentAt = Date.now()
      this.sentCount += 1
      if (this.onSend) this.onSend(next.cmd, next.meta)
      this.kick()
    }, wait)
  }

  /** 清空待发队列 (停止/重连时)。 */
  clear(): void {
    if (this.pendingTimer) {
      clearTimeout(this.pendingTimer)
      this.pendingTimer = null
    }
    this.queue = []
  }

  /** 队列统计。 */
  stats(): { queued: number; sent: number; lastSentAt: number; gate: boolean } {
    return { queued: this.queue.length, sent: this.sentCount, lastSentAt: this.lastSentAt, gate: this.gateActive }
  }
}

/** 模板渲染: 把 {name}/{pass} 占位符替换为账户参数。 */
export function renderTemplate(template: string, params: Record<string, string> = {}): string {
  if (!template || !params) return template
  return String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key: string) =>
    params[key] !== undefined ? String(params[key]) : m,
  )
}
