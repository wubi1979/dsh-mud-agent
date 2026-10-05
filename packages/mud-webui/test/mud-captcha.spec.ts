/**
 * dsh-mud-webui — 验证码弹窗控制器测试（T13.3，断言⑭）。
 *
 * 覆盖面（controller 层 = 弹窗呈现数据面；CaptchaDialog 只是快照的画笔）：
 * - 显示（挂起帧落地快照）/ 刷新页面恢复弹窗（重订阅 + 服务端首帧补推语义）
 * - 提交（trim 转发 captchaAnswer；提交后不清窗——收束由服务端清除帧驱动）
 * - 中止（转发 captchaAbort）
 * - 刷新重取（转发 captchaRefresh + 返回新图 + 配额置灰；行重现 = 新一轮恢复配额）
 * - 超时自动关闭（清除帧 → 快照清空关窗）
 * @module test/mud-captcha.spec
 */

import { describe, expect, it } from 'vitest'
import { MudCaptchaController, type CaptchaRemoteFace } from '../src/client/mud-captcha.ts'
import type { MudCaptchaFrame, MudCaptchaRow } from '../src/client/mud-remote.ts'

/** 挂起行样本（image = data URL 形态）。 */
function row(sessionId: string, image = 'data:image/png;base64,AAA'): MudCaptchaRow {
  return { sessionId, account: `acc-${sessionId}`, url: 'https://mud.example/robot.php?a=1', image }
}

/** 手动推帧的异步流（服务端 watchCaptcha 的假面）。 */
function manualStream(): {
  stream: AsyncIterable<MudCaptchaFrame>
  push: (frame: MudCaptchaFrame) => void
  close: () => void
} {
  const buffer: MudCaptchaFrame[] = []
  let notify: ((result: IteratorResult<MudCaptchaFrame>) => void) | null = null
  let closed = false
  const settle = (result: IteratorResult<MudCaptchaFrame>): void => {
    const waiter = notify
    notify = null
    waiter?.(result)
  }
  return {
    stream: {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<MudCaptchaFrame>> {
            if (buffer.length > 0) return Promise.resolve({ value: buffer.shift()!, done: false })
            if (closed) return Promise.resolve({ value: undefined, done: true })
            return new Promise(resolve => { notify = resolve })
          },
          return(): Promise<IteratorResult<MudCaptchaFrame>> {
            closed = true
            settle({ value: undefined, done: true })
            return Promise.resolve({ value: undefined, done: true })
          },
        }
      },
    },
    push(frame) {
      if (notify !== null) settle({ value: frame, done: false })
      else buffer.push(frame)
    },
    close() {
      closed = true
      settle({ value: undefined, done: true })
    },
  }
}

/** remote 假面：记录调用 + 可手动推帧；每次 watchCaptcha 订阅发一条新流。 */
class FakeRemote implements CaptchaRemoteFace {
  readonly calls: { method: string; args: unknown[] }[] = []
  private current: ReturnType<typeof manualStream> | null = null
  /** 下一帧 pending（重订阅场景测试手动预置：模拟服务端首帧补推）。 */
  firstFrame: MudCaptchaFrame | null = null

  watchCaptcha(_signal: AbortSignal): AsyncIterable<MudCaptchaFrame> {
    const stream = manualStream()
    this.current = stream
    if (this.firstFrame !== null) {
      stream.push(this.firstFrame)
      this.firstFrame = null
    }
    return stream.stream
  }

  captchaAnswer(sessionId: string, value: string): Promise<{ sessionId: string }> {
    this.calls.push({ method: 'captchaAnswer', args: [sessionId, value] })
    return Promise.resolve({ sessionId })
  }

  captchaAbort(sessionId: string): Promise<{ sessionId: string }> {
    this.calls.push({ method: 'captchaAbort', args: [sessionId] })
    return Promise.resolve({ sessionId })
  }

  captchaRefresh(sessionId: string): Promise<{ sessionId: string; image: string }> {
    this.calls.push({ method: 'captchaRefresh', args: [sessionId] })
    return Promise.resolve({ sessionId, image: 'data:image/png;base64,REFRESHED' })
  }

  /** 推帧到当前订阅（挂起帧 / 清除帧）。 */
  push(frame: MudCaptchaFrame): void {
    this.current?.push(frame)
  }

  called(method: string): { method: string; args: unknown[] } | undefined {
    return this.calls.filter(c => c.method === method).at(-1)
  }
}

/** 让 start() 的流消费循环跑起来。 */
const tick = (): Promise<void> => new Promise(resolve => { setTimeout(resolve, 0) })

describe('MudCaptchaController（T13.3 断言⑭）', () => {
  it('显示：挂起帧落地快照（弹窗呈现数据面）', async () => {
    const remote = new FakeRemote()
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    expect(controller.getSnapshot().pending).toHaveLength(0)
    remote.push({ pending: [row('s1')] })
    await tick()
    const snap = controller.getSnapshot()
    expect(snap.pending).toHaveLength(1)
    expect(snap.pending[0]).toMatchObject({ sessionId: 's1', account: 'acc-s1' })
    stop()
  })

  it('提交：trim 后转发 captchaAnswer，且提交后不清窗（等服务端清除帧）', async () => {
    const remote = new FakeRemote()
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    remote.push({ pending: [row('s1')] })
    await tick()
    await controller.submit('s1', '  ab12  ')
    expect(remote.called('captchaAnswer')?.args).toEqual(['s1', 'ab12'])
    expect(controller.getSnapshot().pending).toHaveLength(1)
    expect(controller.getSnapshot().busy.has('s1')).toBe(false)
    stop()
  })

  it('中止：转发 captchaAbort（aborted 出口由服务端收束）', async () => {
    const remote = new FakeRemote()
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    remote.push({ pending: [row('s1')] })
    await tick()
    await controller.abort('s1')
    expect(remote.called('captchaAbort')?.args).toEqual(['s1'])
    stop()
  })

  it('刷新重取：转发 captchaRefresh + 配额置灰 + 重复点击忽略 + 行重现恢复配额', async () => {
    const remote = new FakeRemote()
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    remote.push({ pending: [row('s1')] })
    await tick()
    await controller.refresh('s1')
    expect(remote.called('captchaRefresh')?.args).toEqual(['s1'])
    expect(controller.getSnapshot().refetched.has('s1')).toBe(true)
    // 本轮配额已用：再点不转发
    await controller.refresh('s1')
    expect(remote.calls.filter(c => c.method === 'captchaRefresh')).toHaveLength(1)
    // 同轮重推帧（服务端 refetch 落地新图）：配额保持置灰、快照更新
    remote.push({ pending: [row('s1', 'data:image/png;base64,REFRESHED')] })
    await tick()
    expect(controller.getSnapshot().pending[0]?.image).toBe('data:image/png;base64,REFRESHED')
    expect(controller.getSnapshot().refetched.has('s1')).toBe(true)
    // 清除帧（本轮收束）后再重现 = 新一轮：配额恢复
    remote.push({ pending: [] })
    await tick()
    remote.push({ pending: [row('s1')] })
    await tick()
    expect(controller.getSnapshot().refetched.has('s1')).toBe(false)
    stop()
  })

  it('超时自动关闭：清除帧（pending 空）→ 快照清空关窗', async () => {
    const remote = new FakeRemote()
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    remote.push({ pending: [row('s1')] })
    await tick()
    expect(controller.getSnapshot().pending).toHaveLength(1)
    remote.push({ pending: [] })
    await tick()
    expect(controller.getSnapshot().pending).toHaveLength(0)
    stop()
  })

  it('刷新页面恢复弹窗：重订阅 + 服务端首帧补推 → 快照恢复', async () => {
    const remote = new FakeRemote()
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    remote.push({ pending: [row('s1')] })
    await tick()
    // 页面刷新 = 组件卸载停流 + 重挂载重新订阅；服务端对新订阅首帧补推挂起态。
    stop()
    remote.firstFrame = { pending: [row('s1')] }
    const stop2 = controller.start()
    await tick()
    expect(controller.getSnapshot().pending).toHaveLength(1)
    expect(controller.getSnapshot().pending[0]?.sessionId).toBe('s1')
    stop2()
  })

  it('动作失败：可读错误进快照（提交面 error 行）', async () => {
    const remote = new FakeRemote()
    remote.captchaAnswer = () => Promise.reject(new Error('value 必填（验证码值）'))
    const controller = new MudCaptchaController(remote)
    const stop = controller.start()
    remote.push({ pending: [row('s1')] })
    await tick()
    await controller.submit('s1', 'x')
    expect(controller.getSnapshot().error).toBe('value 必填（验证码值）')
    stop()
  })
})
