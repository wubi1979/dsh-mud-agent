/**
 * dsh-mud-core — 执行层 (Execution), host half.
 *
 * 只有一条执行路径: **工具调用**。规则 (轻量处理器) 和 DSH agent (重型
 * 处理器, LLM) 都通过同一个工具集向游戏发命令; 决策路由只决定"谁决定调用
 * 工具", 不另设执行机制 (无流程引擎 / 无状态机)。
 *
 * 命令队列: 最小间隔节流 (默认 400ms) + 优先级 (halt > high > normal > low),
 * 防止规则反射与 agent 连发命令时洪水游戏服务器。
 * @module @deepseek-ai/dsh-mud-core/execution
 */

/** 队列优先级: 数字越小越先发出。 */
export const QUEUE_PRIORITY = { halt: 0, high: 10, normal: 20, low: 30 } as const

/** 命令发送元数据。 */
export interface CommandMeta {
  priority?: keyof typeof QUEUE_PRIORITY
  source?: string
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
    this.queue.sort((a, b) => a.priority - b.priority || a.at - b.at)
    this.kick()
  }

  private kick(): void {
    if (this.pendingTimer) return
    const item = this.queue[0]
    if (!item) return
    const wait = Math.max(0, this.lastSentAt + this.minInterval - Date.now())
    this.pendingTimer = setTimeout(() => {
      this.pendingTimer = null
      const next = this.queue.shift()
      if (!next) return
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
  stats(): { queued: number; sent: number; lastSentAt: number } {
    return { queued: this.queue.length, sent: this.sentCount, lastSentAt: this.lastSentAt }
  }
}

/** 模板渲染: 把 {name}/{pass} 占位符替换为账户参数。 */
export function renderTemplate(template: string, params: Record<string, string> = {}): string {
  if (!template || !params) return template
  return String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (m, key: string) =>
    params[key] !== undefined ? String(params[key]) : m,
  )
}
