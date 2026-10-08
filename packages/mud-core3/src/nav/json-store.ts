/**
 * nav/json-store — 行走知识图的 **JSON 文件持久化**（T23.10b，用户裁定 2026-10-08：
 * "先使用 json 数据持久化，后期再考虑优化"）。
 *
 * 纪律：
 *   - **fail-soft**：读失败（文件不存在 / JSON 坏 / 结构不符）⇒ 返回 `null`（图从空开始），
 *     只通过 `onError` 上报；写失败 ⇒ 上报，**不影响行走本身**（知识是增益，不是前置）；
 *   - 文件是**快照 JSON**（`{ nodes:[{region,edges,updatedAt}], hints:[…] }`），人可读、可手工清理；
 *   - 落点与会话日志同目录（`logDir`，`<logDir>/nav-graph.json`）——复用既有配置，不新增 Config 键。
 *
 * 只依赖 `node:fs`（非宿主依赖，纯 Node 层）。
 *
 * @module mud-core3/nav/json-store
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { NavGraphSnapshot } from './graph.ts'

/** 知识图存储端口（服务只认端口；换实现不影响服务）。 */
export interface NavStore {
  /** 读取快照；无/坏 ⇒ `null`（fail-soft，不抛）。 */
  load(): NavGraphSnapshot | null
  /** 写入快照（fail-soft，不抛）。 */
  save(snapshot: NavGraphSnapshot): void
}

/** 建一个 JSON 文件存储（`file` 为绝对路径；父目录不存在时自动建）。 */
export function createJsonNavStore(file: string, onError?: (message: string) => void): NavStore {
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
        if (typeof parsed !== 'object' || parsed === null) {
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
