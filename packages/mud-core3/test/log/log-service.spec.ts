/**
 * log 测试 — 会话日志：内存环 + 按天 JSONL 落盘 + 清理。
 *
 * 覆盖：
 *   - seq 单调、内存环有上限（丢最旧）
 *   - 原始行流只落盘不进环（stream 是 file-only）
 *   - 按天 + 会话命名 `mud-YYYYMMDD-<sessionId>.log`，可读回 JSONL
 *   - purgeSessionLogs 只删该会话文件（含滚动分片），不碰其它会话
 *   - resolveLogDir 的空值语义（显式目录优先，未配置回落缺省）
 *   - 落盘失败不抛出（用不可写路径验证降级）
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionLog, purgeSessionLogs, resolveLogDir } from '../../src/log/log-service.ts'

function tempDir(tag: string): string {
  return mkdtempSync(join(tmpdir(), `mud-log-${tag}-`))
}

function dayStemOf(sessionId: string): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `mud-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${sessionId}`
}

describe('resolveLogDir', () => {
  it('显式目录优先；未配置/空白回落缺省', () => {
    expect(resolveLogDir('D:/data/logs', 'D:/fallback')).toBe('D:/data/logs')
    expect(resolveLogDir(undefined, 'D:/fallback')).toBe('D:/fallback')
    expect(resolveLogDir('   ', 'D:/fallback')).toBe('D:/fallback')
  })
})

describe('SessionLog 内存环', () => {
  it('seq 单调递增，环超限丢最旧', () => {
    const log = new SessionLog('s1', { bufferMax: 3 })
    log.info('runtime', 'a')
    log.warn('network', 'b')
    log.error('deliver', 'c')
    log.info('gate', 'd')
    const entries = log.entries()
    expect(entries.map(e => e.text)).toEqual(['b', 'c', 'd'])
    expect(entries.map(e => e.seq)).toEqual([2, 3, 4])
    expect(log.entries(2).map(e => e.text)).toEqual(['c', 'd'])
  })

  it('未配置目录时 fileTarget 为 null，stream 为空操作', () => {
    const log = new SessionLog('s1')
    expect(log.fileTarget).toBeNull()
    log.stream('原始行')
    expect(log.entries()).toEqual([])
  })
})

describe('SessionLog 落盘', () => {
  it('事件入环也落盘；原始行流只落盘不进环', () => {
    const dir = tempDir('write')
    try {
      const log = new SessionLog('sess-a', { logDir: dir })
      log.info('runtime', '连接 127.0.0.1:4000')
      log.stream('欢迎来到北大侠客行')
      log.error('runtime', '连接失败：Error: boom')

      expect(log.entries().map(e => e.text)).toEqual(['连接 127.0.0.1:4000', '连接失败：Error: boom'])
      const lines = readFileSync(join(dir, `${dayStemOf('sess-a')}.log`), 'utf8')
        .split('\n').filter(l => l.trim() !== '').map(l => JSON.parse(l) as { channel: string; text: string; level: string })
      expect(lines.map(l => l.channel)).toEqual(['runtime', 'stream', 'runtime'])
      expect(lines[1]?.text).toBe('欢迎来到北大侠客行')
      expect(lines[1]?.level).toBe('debug')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('已有当日文件时 seq 从文件最大号续起（跨运行不冲突）', () => {
    const dir = tempDir('seed')
    try {
      writeFileSync(join(dir, `${dayStemOf('sess-b')}.log`), `${JSON.stringify({
        seq: 41, time: Date.now(), level: 'info', channel: 'runtime', text: '旧运行',
      })}\n`)
      const log = new SessionLog('sess-b', { logDir: dir })
      expect(log.info('runtime', '新运行').seq).toBe(42)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('落盘失败不抛出（错误路径降级为仅内存）', () => {
    const file = join(tempDir('bad'), 'not-a-dir')
    writeFileSync(file, 'x')
    const failures: string[] = []
    const log = new SessionLog('sess-c', {
      logDir: join(file, 'nested'),
      onFileError: (_error, entry) => { failures.push(entry.text) },
    })
    expect(() => { log.info('runtime', '第一条') }).not.toThrow()
    expect(log.entries().map(e => e.text)).toEqual(['第一条'])
    expect(failures).toEqual(['第一条']) // 只报一次
  })
})

describe('purgeSessionLogs', () => {
  it('只删该会话的全部日期/分片文件，不碰其它会话', () => {
    const dir = tempDir('purge')
    try {
      writeFileSync(join(dir, 'mud-20200101-sess-a.log'), '{}\n')
      writeFileSync(join(dir, 'mud-20200102-sess-a-1.log'), '{}\n')
      writeFileSync(join(dir, 'mud-20200101-sess-a2.log'), '{}\n')
      writeFileSync(join(dir, 'unrelated.txt'), 'x')

      expect(purgeSessionLogs(dir, 'sess-a')).toBe(2)
      expect(readdirSync(dir).sort()).toEqual(['mud-20200101-sess-a2.log', 'unrelated.txt'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('目录未配置/不存在时返回 0', () => {
    expect(purgeSessionLogs(undefined, 'sess-a')).toBe(0)
    expect(purgeSessionLogs('   ', 'sess-a')).toBe(0)
    expect(purgeSessionLogs(join(tmpdir(), 'mud-log-does-not-exist'), 'sess-a')).toBe(0)
  })
})
