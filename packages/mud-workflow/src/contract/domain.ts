/**
 * contract/domain — 流程持久化域声明 + 宿主 storage 面（**契约层**，A1）。
 *
 * 分工：契约层只声明"域长什么样"（域名 / 版本 / 表 + 值 schema + 宿主表最小面），
 * **访问策略**（内存先行 → 域就绪迁入、merge 顺序、save/delete 门）在内核
 * （core/registry）。宿主 storage 域以结构化接口接入，本包不引宿主包依赖。
 */

import { workflowRecordSchema, workflowSnapshotSchema } from './schema.ts'

/** 宿主 storage 表的最小面（`KvTable` 结构化子集，同 core3 store.ts）。 */
export interface HostTable<V> {
  get(key: string): V | undefined
  entries(): IterableIterator<[string, V]>
  put(key: string, value: V): Promise<void>
  delete(key: string): Promise<boolean>
}

/** 宿主 storage 域的最小面（`ctx.storageDomain` 结构化子集，同 core3 store.ts）。 */
export interface HostStorageDomain {
  open(spec: unknown): Promise<{
    table(name: string): HostTable<unknown>
  }>
}

/**
 * 词汇表文档版本（持久化记录按此版本书写）。
 *
 * 现状：**版本 1 为唯一版本，且无迁移钩子**——词汇表收紧/改名时，存量修缮记录
 * 会读不出来。演进规则（补迁移/容错读）属后置项，落地前不得在没有迁移的前提下
 * 在保存门里收紧既有字段。
 */
export const FLOW_SCHEMA_VERSION = 1

/**
 * 域声明（storage 域 spec；域名/表名须匹配宿主 UNIT_NAME_RE `^[a-z][a-z0-9_]*$`
 * ——无连字符，故用下划线）。与 core3 的 `mud` 域并列，各自独立演进。
 *
 * 两条与宿主 storage 机制绑定的纪律（T16 事实核查，见 §14.3）：
 *   1. **`version` 保持 1、永不用作迁移手段**——本域走 whole-unit 布局，版本不一致
 *      时宿主直接 `version-mismatch` 拒绝**整个 open**（`compatibleVersions` 只对
 *      `per-record` 生效）⇒ 改版本 = 全部修缮记录读不出来。词汇表演进一律走"字段
 *      可加可选 + 读时归一"。
 *   2. **新增表对存量文件零影响**——宿主只按 `spec.tables` 取表，旧文件缺表读为空。
 *      `snapshots`（变更账本）即按此新增。
 */
export const mudWorkflowDomainSpec = {
  name: 'mud_workflow',
  version: FLOW_SCHEMA_VERSION,
  layout: 'single',
  tables: {
    workflows: { valueSchema: workflowRecordSchema },
    snapshots: { valueSchema: workflowSnapshotSchema },
  },
} as const
