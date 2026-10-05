/**
 * contract/domain — 流程持久化域声明 + 宿主 storage 面（**契约层**，A1）。
 *
 * 分工：契约层只声明"域长什么样"（域名 / 版本 / 表 + 值 schema + 宿主表最小面），
 * **访问策略**（内存先行 → 域就绪迁入、merge 顺序、save/delete 门）在内核
 * （core/registry）。宿主 storage 域以结构化接口接入，本包不引宿主包依赖。
 */

import { workflowRecordSchema } from './schema.ts'

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
 */
export const mudWorkflowDomainSpec = {
  name: 'mud_workflow',
  version: FLOW_SCHEMA_VERSION,
  tables: {
    workflows: { valueSchema: workflowRecordSchema },
  },
} as const
