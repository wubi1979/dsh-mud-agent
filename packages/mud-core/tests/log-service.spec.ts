/**
 * dsh-mud-core 日志服务测试 — MudLogService。
 *
 * 覆盖: seq 单调分配 + 回调转发; 内存环形缓冲 (entries(since) 过滤 / bufferMax 截断);
 * 文件 JSONL 落盘 (按天命名 / 内容可解析 / 明文占位符策略); 无落盘目标降级;
 * info/warn/error/debug 便捷方法。
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { MudLogService, purgeSessionLogs, resolveLogDir, type LogEntry } from '../src/logging/log-service.ts'

const tmpDirs: string[] = []

function makeTmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mud-log-test-'))
  tmpDirs.push(dir)
  return dir
}

afterAll(() => {
  for (const dir of tmpDirs) {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('MudLogService', () => {
  it('seq 单调分配 + onEntry 回调逐条转发', () => {
    const seen: LogEntry[] = []
    const svc = new MudLogService({ onEntry: (e) => seen.push(e) })
    svc.info('runtime', 'a')
    svc.warn('perception', 'b')
    svc.error('send', 'c')
    expect(seen.map(e => e.seq)).toEqual([1, 2, 3])
    expect(seen.map(e => e.level)).toEqual(['info', 'warn', 'error'])
    expect(seen.map(e => e.channel)).toEqual(['runtime', 'perception', 'send'])
    expect(seen.every(e => typeof e.time === 'number' && e.time > 0)).toBe(true)
  })

  it('entries(since) 过滤 + bufferMax 截断 (丢最旧)', () => {
    const svc = new MudLogService({ bufferMax: 3 })
    svc.debug('network', 'n1')
    svc.debug('network', 'n2')
    svc.debug('network', 'n3')
    svc.debug('network', 'n4')
    const all = svc.entries()
    expect(all.map(e => e.seq)).toEqual([2, 3, 4])
    const since = svc.entries(2)
    expect(since.map(e => e.seq)).toEqual([3, 4])
  })

  it('文件落盘: JSONL 按天+会话命名, 内容含级别/通道/文本', () => {
    const dir = makeTmpDir()
    const svc = new MudLogService({ logDir: dir, sessionId: 'test-session' })
    expect(svc.fileTarget).toBe(dir)
    svc.info('perception', '[感知] feedParsed 3 行')
    svc.append({ level: 'error', channel: 'send', text: '[发送] 写 socket 失败', actor: 'router', action: 'x' })
    const stem = (() => {
      const pad = (n: number): string => String(n).padStart(2, '0')
      const d = new Date()
      return `mud-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-test-session`
    })()
    const files = readdirSync(dir).filter(f => f.startsWith('mud-'))
    expect(files.length).toBe(1)
    expect(files[0]).toBe(`${stem}.log`)
    const lines = readFileSync(join(dir, files[0] as string), 'utf8').trim().split('\n')
    expect(lines.length).toBe(2)
    const first = JSON.parse(lines[0] as string) as LogEntry
    expect(first.seq).toBe(1)
    expect(first.level).toBe('info')
    expect(first.channel).toBe('perception')
    expect(first.text).toContain('feedParsed')
    expect((first as { time?: number }).time).toBeTypeOf('number')
    const second = JSON.parse(lines[1] as string) as LogEntry
    expect(second.level).toBe('error')
    expect(second.actor).toBe('router')
  })

  it('无落盘目标: 降级为仅内存 + 回调, 不抛错', () => {
    const seen: LogEntry[] = []
    const svc = new MudLogService({ onEntry: (e) => seen.push(e) })
    expect(svc.fileTarget).toBeNull()
    expect(() => svc.info('runtime', 'x')).not.toThrow()
    expect(seen.length).toBe(1)
  })

  it('明文不落盘策略: 密码占位符原样记录 ({pass}, 不插值)', () => {
    const dir = makeTmpDir()
    const svc = new MudLogService({ logDir: dir, sessionId: 'pw-test' })
    svc.append({ level: 'debug', channel: 'send', text: '[工具] mud_send → {pass}' })
    const files = readdirSync(dir).filter(f => f.startsWith('mud-'))
    const content = readFileSync(join(dir, files[0] as string), 'utf8')
    expect(content).toContain('{pass}')
    expect(content).not.toMatch(/secret123/)
  })

  it('initLogFile 切换会话 → 新文件', () => {
    const dir = makeTmpDir()
    const svc = new MudLogService({ logDir: dir, sessionId: 's1' })
    svc.info('runtime', 'first')
    const files1 = readdirSync(dir).filter(f => f.startsWith('mud-'))
    expect(files1.length).toBe(1)
    expect(files1[0]).toContain('s1')

    svc.initLogFile('s2')
    svc.info('runtime', 'second')
    const files2 = readdirSync(dir).filter(f => f.startsWith('mud-'))
    expect(files2.length).toBe(2)
    expect(files2.some(f => f.includes('s2'))).toBe(true)
  })

  it('seq 跨 host 运行续起: 从当日文件最大 seq 递增 (logSeq 当日全局唯一)', () => {
    const dir = makeTmpDir()
    // 第一次运行: 写 3 条 (seq 1..3)。
    const svc1 = new MudLogService({ logDir: dir, sessionId: 'restart-ctx' })
    svc1.info('runtime', 'run1-a')
    svc1.info('runtime', 'run1-b')
    svc1.info('runtime', 'run1-c')
    expect(svc1.entries().map(e => e.seq)).toEqual([1, 2, 3])
    // 第二次运行 (模拟 host 重启): seq 必须从 3 续起 → 4, 5。
    const svc2 = new MudLogService({ logDir: dir, sessionId: 'restart-ctx' })
    svc2.info('runtime', 'run2-a')
    svc2.info('runtime', 'run2-b')
    expect(svc2.entries().map(e => e.seq)).toEqual([4, 5])
    // readDayEntries 返回当日全部条目, seq 全局唯一 (1..5, 无冲突)。
    const restored = svc2.readDayEntries('restart-ctx')
    expect(restored.map(e => e.seq)).toEqual([1, 2, 3, 4, 5])
    expect(new Set(restored.map(e => e.seq)).size).toBe(5)
  })

  it('initLogFile 切换会话时按新会话文件续起 seq', () => {
    const dir = makeTmpDir()
    const svc = new MudLogService({ logDir: dir, sessionId: 'seq-a' })
    svc.info('runtime', 'a1') // a 文件 seq=1
    svc.initLogFile('seq-b')
    svc.info('runtime', 'b1') // b 文件 seq 从 0 续起 → 1
    // 切回 a: a 文件最大 seq=1 → 续起为 2。
    svc.initLogFile('seq-a')
    svc.info('runtime', 'a2')
    const restored = svc.readDayEntries('seq-a')
    expect(restored.map(e => e.seq)).toEqual([1, 2])
  })

  it('purge() 清内存缓冲并把 seq 归零 (删除用户后不该再有可读回的内容)', () => {
    const svc = new MudLogService({ sessionId: 'purge-mem' })
    svc.info('runtime', 'gone-a')
    svc.info('runtime', 'gone-b')
    expect(svc.entries()).toHaveLength(2)
    svc.purge()
    expect(svc.entries()).toHaveLength(0)
    // seq 归零: 重建的同 id 会话从 1 重新计, 不与已删内容同号。
    expect(svc.info('runtime', 'fresh').seq).toBe(1)
  })
})

describe('purgeSessionLogs', () => {
  it('删除该会话全部日期的文件 + 滚动分片, 不动其它会话', () => {
    const dir = makeTmpDir()
    const svcA = new MudLogService({ logDir: dir, sessionId: 'sess-a' })
    svcA.info('runtime', 'a')
    const svcB = new MudLogService({ logDir: dir, sessionId: 'sess-b' })
    svcB.info('runtime', 'b')
    // 滚动分片 + 历史日期 + 前缀相同的兄弟会话 (sess-a2 不能被误删)。
    writeFileSync(join(dir, 'mud-20200101-sess-a-1.log'), '{}\n')
    writeFileSync(join(dir, 'mud-20200101-sess-a-2.log'), '{}\n')
    writeFileSync(join(dir, 'mud-20200101-sess-a2.log'), '{}\n')
    expect(readdirSync(dir).filter(n => n.includes('sess-a'))).toHaveLength(4)

    const removed = purgeSessionLogs(dir, 'sess-a')

    expect(removed).toBe(3)
    const left = readdirSync(dir)
    expect(left.filter(n => n.startsWith('mud-') && n.includes('sess-a'))).toEqual(['mud-20200101-sess-a2.log'])
    expect(left.some(n => n.includes('sess-b'))).toBe(true)
    // 注销后读回: 空 (前端"当日恢复"拿不到任何内容)。
    expect(svcB.readDayEntries('sess-a')).toEqual([])
  })

  it('无落盘目录 / 目录不存在 / sessionId 含正则元字符 → 不抛出', () => {
    expect(purgeSessionLogs(undefined, 'x')).toBe(0)
    expect(purgeSessionLogs('', 'x')).toBe(0)
    expect(purgeSessionLogs(join(makeTmpDir(), 'missing'), 'x')).toBe(0)
    const dir = makeTmpDir()
    const svc = new MudLogService({ logDir: dir, sessionId: 'a+b.c' })
    svc.info('runtime', 'literal')
    writeFileSync(join(dir, 'mud-20200101-axbxc.log'), '{}\n') // 元字符不得当通配
    expect(purgeSessionLogs(dir, 'a+b.c')).toBe(1)
    expect(readdirSync(dir)).toContain('mud-20200101-axbxc.log')
  })
})

describe('resolveLogDir', () => {
  it('未配置 logDir → 缺省目录 (曾踩坑: `?.trim() !== \'\'` 对 undefined 为 true 会静默关落盘)', () => {
    expect(resolveLogDir(undefined, 'D:/fallback/mud-logs')).toBe('D:/fallback/mud-logs')
  })

  it('空白 logDir → 缺省目录', () => {
    expect(resolveLogDir('   ', 'D:/fallback/mud-logs')).toBe('D:/fallback/mud-logs')
  })

  it('显式 logDir → 原样采用 (仅判空, 不裁剪值本身, 与构造器语义一致)', () => {
    expect(resolveLogDir('  D:/data/logs  ', 'D:/fallback/mud-logs')).toBe('  D:/data/logs  ')
  })
})