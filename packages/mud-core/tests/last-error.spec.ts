/**
 * dsh-mud-core — 会话级 lastError 生命周期测试 (W11.1②)。
 *
 * 回归的缺陷: `lastError` 写一次永不清 — 连接错误留痕后, 即便随后连接成功,
 * diag 仍显示陈旧文案 (旧错误遮蔽新状态)。裁决口径: 成功路径清除。
 *
 * 装配级 lastError (assemble 的凭据失败文案) 位于装饰器装配面, vitest 无法直接
 * 加载 (§18.9); 其"成功路径/purge 清除"随 tsc + 既有用例验收, 会话级行为在本
 * 文件钉死。
 */

import { describe, expect, it } from 'vitest'
import { MudSessionRuntime } from '../src/session/session.ts'
import type { MudRuntimeConfig, MudRuntimeSink } from '../src/session/types.ts'
import type { MudConnectionManager, MudConnectionSink } from '../src/network/manager.ts'

/** 最小假传输 + 捕获的连接 sink (与 runtime-delivery 夹具同款形状)。 */
function harness(sessionId: string): {
  runtime: MudSessionRuntime
  sink: () => MudConnectionSink
} {
  let captured: MudConnectionSink | null = null
  const connection = {
    id: 'conn-1',
    state: 'connected',
    client: { send: () => true },
  }
  const connections = {
    open: (_t: unknown, sink: MudConnectionSink) => { captured = sink; return connection },
    get: () => connection,
    close: () => {},
    list: () => [connection],
    closeAll: () => {},
  } as unknown as MudConnectionManager
  const sink: MudRuntimeSink = {
    agentOf: () => undefined,
    pushGame: () => {},
    pushUi: () => {},
    pushWorld: () => {},
    log: () => {},
    debug: () => {},
    decision: () => {},
  }
  const config: MudRuntimeConfig = {
    agentMode: 'off',
    commandIntervalMs: 0,
    bridgeTimeoutMs: 10_000,
    bridgeDeclaredTimeoutMs: 120_000,
    bridgeSilenceMs: 2_000,
    loginTimeoutMs: 20_000,
    deadAirMs: 60_000,
    holdTimeoutMs: 3_000,
    toolCallIntervalMs: 0,
    persona: '',
    skillsText: () => '',
    commands: '',
    defaultHost: 'example.invalid',
    defaultPort: 8081,
  }
  const runtime = new MudSessionRuntime(sessionId, config, sink, connections, {
    stateRules: [],
    eventRules: [],
    holdRuleIds: new Set(),
  })
  return {
    runtime,
    sink: () => {
      if (captured === null) throw new Error('connect 未调用')
      return captured
    },
  }
}

describe('会话级 lastError 生命周期 (W11.1②): 成功路径清除', () => {
  it('连接错误留痕 → 连接成功后 diag 不再显示陈旧文案', () => {
    const h = harness('last-error')
    h.runtime.connect()
    // 错误路径: 留痕。
    h.sink().onError(new Error('连接超时'))
    expect(h.runtime.diag().lastError).toBe('连接超时')
    // 成功路径: 清除 (旧实现永不清 → 会红)。
    h.sink().onConnect()
    expect(h.runtime.diag().lastError).toBeNull()
    // 新一轮错误仍正常留痕 (清除不破坏写入)。
    h.sink().onError(new Error('再次断开'))
    expect(h.runtime.diag().lastError).toBe('再次断开')
    h.runtime.dispose()
  })
})
