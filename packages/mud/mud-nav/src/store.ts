/**
 * nav/store — 行走知识图持久化：**项目内 JSON 文件**（用户裁定 2026-10-14 三次：
 * 知识图是伴随项目累积的耐久资产，应"跟数据库文件一样存在项目中"——
 * 宿主 storage 域落盘位置由宿主控制（`$DSH_HOME/storages/`，用户目录），
 * 不满足"项目内"诉求，故弃用；亦不与按天滚动的会话日志混放。
 *
 * 落点：`<cwd>/data/nav-graph.json`（项目根 `data/`，耐久数据语义，
 * 与 logs（可清理）/ knowledge（静态技能包）/ corpus（语料）分列）。
 *
 * 纪律（沿初版 json-store）：
 *   - **fail-soft**：读失败（文件不存在 / JSON 坏 / 结构不符）⇒ 返回 `null`（图从空开始），
 *     只通过 `onError` 上报；写失败 ⇒ 上报，**不影响行走本身**（知识是增益，不是前置）；
 *   - 文件是**快照 JSON**（`{ nodes:[…] }`，边含 region/room/pinyin/steps/direct/dirs），人可读、可手工清理；
 *   - 逐条校验在 `NavGraph.loadSnapshot`（坏数据逐条丢弃）——本模块只做浅层结构检查。
 *
 * 只依赖 `node:fs`（非宿主依赖，纯 Node 层）。
 *
 * @module mud-nav/store
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NavGraphSnapshot } from './graph.ts'
import type { NavStore } from './service.ts'

/** 建一个 JSON 文件存储（`file` 为绝对路径；父目录不存在时自动建）。 */
export function createFileNavStore(file: string, onError?: (message: string) => void): NavStore {
  const report = (message: string, e: unknown): void => {
    onError?.(`${message}: ${file}（${e instanceof Error ? e.message : String(e)}）`)
  }
  return {
    load(): NavGraphSnapshot | null {
      let raw: string
      try {
        raw = readFileSync(file, 'utf8')
      } catch {
        return null // 首次运行没有文件是正常情况，不上报
      }
      try {
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          report('mudNav 知识图结构不符，按空图处理', new Error('not an object'))
          return null
        }
        return parsed as NavGraphSnapshot
      } catch (e) {
        report('mudNav 知识图 JSON 解析失败，按空图处理', e)
        return null
      }
    },
    save(snapshot: NavGraphSnapshot): void {
      try {
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(snapshot, null, 2), 'utf8')
      } catch (e) {
        report('mudNav 知识图落盘失败（行走不受影响）', e)
      }
    },
  }
}
