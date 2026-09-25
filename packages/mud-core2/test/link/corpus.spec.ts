/**
 * link/corpus — 行流 JSONL 落盘与读取（impl §3.8）。
 */

import { describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CorpusWriter, readCorpus } from '../../src/link/corpus.ts'

describe('CorpusWriter', () => {
  it('行与事件全量落 JSONL, readCorpus 可回放读取', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mud-corpus-'))
    const path = join(dir, 'corpus.jsonl')
    const w = new CorpusWriter(path)
    w.line('欢迎来到北大侠客行', '\x1b[32m欢迎来到北大侠客行\x1b[0m', 0, 1000)
    w.event('mud/command-sent', { cmd: 'look' }, 1001)
    w.line('你往东走去。', '你往东走去。', 1, 1002)

    const records = readCorpus(path)
    expect(records).toHaveLength(3)
    expect(records[0]).toEqual({ kind: 'line', time: 1000, text: '欢迎来到北大侠客行', raw: '\x1b[32m欢迎来到北大侠客行\x1b[0m', abs: 0 })
    expect(records[1]).toEqual({ kind: 'event', time: 1001, type: 'mud/command-sent', data: { cmd: 'look' } })
    rmSync(dir, { recursive: true, force: true })
  })

  it('null 路径 = 只构造不落盘 (测试态)', () => {
    const w = new CorpusWriter(null)
    expect(() => {
      w.line('x', 'x', 0)
      w.event('mud/flow-result', { done: true })
    }).not.toThrow()
  })

  it('readCorpus 忽略空行 (容错)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mud-corpus-'))
    const path = join(dir, 'c.jsonl')
    writeFileSync(path, '{"kind":"line","time":1,"text":"a","raw":"a","abs":0}\n\n', 'utf8')
    expect(readCorpus(path)).toHaveLength(1)
    expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })
})
