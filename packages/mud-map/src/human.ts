/**
 * dsh-mud-map — 人工交互 (Human).
 *
 * 处理算法不可解区域: 支持图位吻合、歧义消解、数据修正、围栏解锁。
 *
 * 触发场景:
 *   - agent 上线后首次定位 (初始对齐弹窗)
 *   - MHT 候选集无法收敛 (歧义消解弹窗)
 *   - ASCII 图解析需确认 (数据修正弹窗)
 *   - 围栏区域解锁
 *
 * 弹窗形式: WebUI modal dialog (参考 dsh 全局配置窗口样式)。
 * TUI 降级为终端交互。
 *
 * @module @deepseek-ai/dsh-mud-map/human
 */

import type { HumanInteraction } from './types.ts'

/**
 * 人工交互管理器.
 *
 * 当前为骨架实现: 弹窗渲染策略待接入 (WebUI modal / TUI 终端降级)。
 */
export class HumanInteractionManager {
  private readonly pending: number[] = []

  /**
   * 发布一个人工交互请求 (骨架: 记入待处理队列, 完整弹窗接入待实现).
   * @returns Promise, 解析为用户回答
   */
  request(interaction: HumanInteraction): Promise<unknown> {
    const id = this.pending.length
    this.pending.push(id)
    // TODO: 接入 WebUI modal dialog / TUI 终端降级
    // 骨架: 空选项时直接 resolve undefined
    const answer = interaction.options?.[0]?.value
    queueMicrotask(() => interaction.callback(answer))
    return Promise.resolve(answer)
  }
}
