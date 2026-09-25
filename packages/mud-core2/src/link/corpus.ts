/**
 * mud-core2 link/corpus — 行流语料 JSONL + log-only 事件（impl §3.8）。
 *
 * - **行流语料**：JSONL 全量落盘（时间戳 + 原文）——自有通道；**不进 Session**
 *   （session.append 是同步通知、高频行会拖账；行级频率只落 JSONL）；
 * - **log-only 事件**（交换级，低频）：`mud/command-sent`、`mud/exchange-complete`
 *   （read 返回时）、`mud/danger-fired`、`mud/flow-result` —— 由装配层经
 *   `event()` 落同一 JSONL（白名单外天然不进模型上下文，log-only 由调用侧承载）；
 * - `readCorpus()` 供回放测试逐行读取（语料是数据，回放即按序喂 feed）。
 *
 * 纯度纪律：本文件不 import 宿主；node:fs 为运行时内建。
 */

import { appendFileSync, readFileSync } from 'node:fs'

/** 行流语料记录（JSONL 一行一条）。 */
export interface CorpusLineRecord {
  kind: 'line'
  time: number
  /** 纯文本（无 ANSI）：判据匹配、模型面。 */
  text: string
  /** 原文（含 ANSI，不含行末换行）：回放按 raw 喂回同一串字节面。 */
  raw: string
  /** 绝对行号（连接生命周期内单调）。 */
  abs: number
}

/** 交换级事件记录（log-only；白名单外不进模型上下文）。 */
export interface CorpusEventRecord {
  kind: 'event'
  time: number
  /** 事件类型：mud/command-sent | mud/exchange-complete | mud/danger-fired | mud/flow-result ... */
  type: string
  data?: unknown
}

export type CorpusRecord = CorpusLineRecord | CorpusEventRecord

/** 行流语料 JSONL 写入器。低频打开代价可接受（行频远低于 session 通知的反面
 *  假设：MUD 行流人读速率）；appendFileSync 保崩溃时行序完整。 */
export class CorpusWriter {
  private readonly path: string | null

  /** @param path JSONL 落盘路径；null = 只进内存缓冲（测试用）。 */
  constructor(path: string | null) {
    this.path = path
  }

  /** 落一行语料（时间戳 + 原文；text/raw 各留一份，回放按 raw）。 */
  line(text: string, raw: string, abs: number, time = Date.now()): void {
    this.write({ kind: 'line', time, text, raw, abs })
  }

  /** 落一条交换级事件（log-only）。 */
  event(type: string, data?: unknown, time = Date.now()): void {
    this.write({ kind: 'event', time, type, data })
  }

  private write(record: CorpusRecord): void {
    const json = JSON.stringify(record)
    if (this.path !== null) appendFileSync(this.path, `${json}\n`, 'utf8')
  }
}

/** 读取语料 JSONL（回放测试用）：逐行解析为记录。 */
export function readCorpus(path: string): CorpusRecord[] {
  const text = readFileSync(path, 'utf8')
  return text
    .split('\n')
    .filter(l => l.trim().length > 0)
    .map(l => JSON.parse(l) as CorpusRecord)
}
