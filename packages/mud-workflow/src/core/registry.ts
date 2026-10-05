/**
 * core/registry — 流程注册表：锁定预制（随代码）+ agent 修缮（storage 域 / 内存降级）。
 *
 * **内核层**（A1）：只依赖契约层（词汇表 + 保存门 + 域声明），零 cordis、
 * 零宿主、零 I/O——storage 域以结构化表接口（`HostTable`）接入。
 *
 * 分层语义（PLAN「流程面演进」）：
 *   - **locked 预制**：`locked: true`（login）固锁——拒改拒删，locked-only
 *     动词流程所在（红线：sendCredential/captcha 只允许 locked 流程用）；
 *   - **非 locked 预制**：随包分发的粗胚，agent 可 save 覆盖（version 自增）、
 *     delete 还原为预制——粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试 = 进化闭环；
 *   - **agent 新建**：save 直接入库（storage 域持久化，域不可用降级内存）。
 *
 * 保存门（确定性校验即生效）：schema 校验（zod）+ 结构校验（checkFlow）+
 * locked-only 动词拒绝（usesCredentialVerb——agent 可写词汇表不含
 * sendCredential/captcha）。
 *
 * 存储纪律承 core3 名册同型：storage 域就绪前内存先行，域挂上后把内存记录
 * 迁入（切换不丢数据）；域不可用长期内存运行（重启丢 agent 修缮，warn 点名）。
 */

import { checkFlow, usesCredentialVerb, workflowRecordSchema } from '../contract/schema.ts'
import type { Flow, WorkflowRecord } from '../contract/schema.ts'
import type { HostTable } from '../contract/domain.ts'

/** save 输入（locked/version/updatedAt 由注册表管理，不接受外部指定）。 */
export interface SaveInput {
  readonly name: string
  readonly title: string
  readonly flow: Flow
}

/** 流程注册表。 */
export class WorkflowRegistry {
  /** 预制（locked login 等，core3 经 registerBuiltins 挂载）；以 name 为键。 */
  private builtins: ReadonlyMap<string, WorkflowRecord> = new Map()
  /** agent 修缮（域表就绪后落域；此前内存）。 */
  private saved: HostTable<WorkflowRecord> | null = null
  private readonly memoryFallback = new Map<string, WorkflowRecord>()

  constructor(builtins: readonly WorkflowRecord[] = []) {
    this.registerBuiltins(builtins)
  }

  /**
   * 挂载预制流程（core3 启动期把流程实体交进来；幂等覆盖同名校验过的预制，
   * 不触碰 agent 修缮层——get 优先 saved，修缮天然保留）。校验失败 fail-loud
   *（预制是代码作者的责任，宁可拒装不带病运行）。
   */
  registerBuiltins(records: readonly WorkflowRecord[]): void {
    const map = new Map(this.builtins)
    for (const record of records) {
      workflowRecordSchema.parse(record)
      checkFlow(record.flow)
      if (record.locked !== true && usesCredentialVerb(record.flow)) {
        throw new Error(`预制流程 ${record.name} 违反凭据红线：sendCredential/captcha 只允许 locked 流程使用`)
      }
      map.set(record.name, record)
    }
    this.builtins = map
  }

  /**
   * 挂 storage 域表（域就绪后调用；内存先行期记录迁入，切换不丢数据）。
   * @param table - 宿主 storage 域的 workflows 表。
   */
  async attachDomain(table: HostTable<WorkflowRecord>): Promise<void> {
    this.saved = table
    for (const [name, record] of this.memoryFallback) {
      await table.put(name, record)
    }
    this.memoryFallback.clear()
  }

  /** 域是否已挂（诊断/测试面）。 */
  get domainAttached(): boolean {
    return this.saved !== null
  }

  /** 全量流程（预制为底，agent 修缮覆盖同名）。 */
  list(): readonly WorkflowRecord[] {
    const merged = new Map(this.builtins)
    const saved = this.saved
    const iterate: Iterable<[string, WorkflowRecord]> = saved !== null
      ? [...saved.entries()]
      : this.memoryFallback
    for (const [name, record] of iterate) merged.set(name, record)
    return [...merged.values()]
  }

  /** 按名取（agent 修缮优先于预制）。 */
  get(name: string): WorkflowRecord | undefined {
    const saved = this.saved
    const savedRecord = saved !== null ? saved.get(name) : this.memoryFallback.get(name)
    return savedRecord ?? this.builtins.get(name)
  }

  /**
   * 保存（agent 修缮 / 新建）：
   *   1. locked 同名拒（预制锁死 + 红线：凭据流程不可被替换）；
   *   2. 凭据动词拒（agent 可写词汇表不含 sendCredential）；
   *   3. schema + 结构校验（校验即生效）；
   *   4. version 自增（覆盖时），updatedAt 记当前时刻。
   *
   * @throws 可读错（工具层转可读拒绝）。
   */
  async save(input: SaveInput): Promise<WorkflowRecord> {
    const existing = this.get(input.name)
    if (existing?.locked === true) {
      throw new Error(`流程 ${input.name} 已锁定，不可修改`)
    }
    if (usesCredentialVerb(input.flow)) {
      throw new Error('已拒绝：sendCredential/captcha 只允许锁定流程使用（凭据红线）')
    }
    const record = workflowRecordSchema.parse({
      name: input.name,
      title: input.title,
      locked: false,
      version: (existing?.version ?? 0) + 1,
      updatedAt: new Date().toISOString(),
      flow: input.flow,
    })
    checkFlow(record.flow)
    const table = this.saved
    if (table !== null) {
      await table.put(record.name, record)
    } else {
      this.memoryFallback.set(record.name, record)
    }
    return record
  }

  /**
   * 删除（locked 拒；非 locked 预制删除 = 还原为预制，agent 新建删除 = 移除）。
   * @returns 是否删除了 agent 修缮（false = 无修缮可删或被拒）。
   * @throws locked 流程可读拒。
   */
  async delete(name: string): Promise<boolean> {
    if (this.builtins.get(name)?.locked === true) {
      throw new Error(`流程 ${name} 已锁定，不可删除`)
    }
    const table = this.saved
    if (table !== null) return table.delete(name)
    return this.memoryFallback.delete(name)
  }
}
