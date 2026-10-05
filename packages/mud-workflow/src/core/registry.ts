/**
 * core/registry — 流程注册表：锁定预制（随代码）+ agent 修缮（storage 域 / 内存降级）
 * + 变更账本（只追加快照）。
 *
 * **内核层**（A1）：只依赖契约层（词汇表 + 保存门 + 域声明），零 cordis、
 * 零宿主、零 I/O——storage 域以结构化表接口（`HostTable`）接入。
 *
 * 分层语义（§8.11）：
 *   - **locked 预制**：`locked: true`（login）固锁——拒改拒删，locked-only
 *     动词流程所在（红线：sendCredential/captcha 只允许 locked 流程用）；
 *   - **非 locked 预制**：随包分发的粗胚，agent 可 save 覆盖（version 自增）、
 *     delete 还原为预制——粗胚 → 执行 → 结构化失败现场 → 修缮 → 重试 = 进化闭环；
 *   - **agent 新建**：save 直接入库（storage 域持久化，域不可用降级内存）。
 *
 * 保存门（确定性校验即生效）：schema 校验（zod）+ 结构校验（checkFlow）+
 * locked-only 动词拒绝（usesCredentialVerb）。
 *
 * 存储纪律（T16）：
 *   - **迁入按 `version` 取新**：内存先行期记录迁入域表前逐条比对域内既有版本，
 *     域内更高 ⇒ 不改域，把内存期记录**归档**为 `migration` 快照（不再静默版本回退）；
 *   - **强审计提交**：账本先行（fast 记快照 → 再写生效记录）⇒ 不会出现"已生效但
 *     无账本"；账本失败即本操作整体失败。极端情况留下"已记账但未生效"的条目——
 *     它可从历史里重新回滚出来，不丢数据；
 *   - 域未挂时账本与记录同在**内存降级层**（迁入时一并落域）。
 */

import {
  checkFlow, usesCredentialVerb, workflowRecordSchema, workflowSnapshotSchema,
} from '../contract/schema.ts'
import type {
  Flow, SnapshotReason, WorkflowEntryView, WorkflowRecord, WorkflowSnapshot,
} from '../contract/schema.ts'
import type { HostTable } from '../contract/domain.ts'

/** save 输入（locked/version/updatedAt 由注册表管理，不接受外部指定）。 */
export interface SaveInput {
  readonly name: string
  readonly title: string
  readonly flow: Flow
}

/** 每流程快照保留上限（T16 D8：常量；落地后按实测评估是否 Config 化）。 */
export const MAX_SNAPSHOTS_PER_FLOW = 20

/** 挂域句柄：生效记录表 + 变更账本表。 */
export interface WorkflowDomainTables {
  readonly workflows: HostTable<WorkflowRecord>
  readonly snapshots: HostTable<WorkflowSnapshot>
}

/** 迁入报告（宿主层据此点名告警；内核不持日志）。 */
export interface MigrationReport {
  /** 迁入域表的记录数（内存先行期的新建/修缮）。 */
  readonly migrated: number
  /** 因域内版本更高而"取新"、被归档为 `migration` 快照的内存记录数。 */
  readonly superseded: number
  /** 落败记录名（点名用）。 */
  readonly supersededNames: readonly string[]
  /** 一并迁入的账本条目数。 */
  readonly snapshots: number
}

/** 快照键（`name` 与版本唯一确定一条历史）。 */
export function snapshotKey(name: string, version: number): string {
  return `${name}:v${version}`
}

/** Map → HostTable 适配（内存降级层与域表同形，读写路径不分叉）。 */
function mapTable<V>(store: Map<string, V>): HostTable<V> {
  return {
    get: (key: string) => store.get(key),
    entries: () => store.entries(),
    put: async (key: string, value: V) => { store.set(key, value) },
    delete: async (key: string) => store.delete(key),
  }
}

/** 流程注册表。 */
export class WorkflowRegistry {
  /** 预制（locked login 等，core3 经 registerBuiltins 挂载）；以 name 为键。 */
  private builtins: ReadonlyMap<string, WorkflowRecord> = new Map()
  /** agent 修缮（域表就绪后落域；此前内存）。 */
  private saved: HostTable<WorkflowRecord> | null = null
  /** 变更账本（域表就绪后落域；此前内存）。 */
  private ledger: HostTable<WorkflowSnapshot> | null = null
  private readonly memoryFallback = new Map<string, WorkflowRecord>()
  private readonly memoryLedger = new Map<string, WorkflowSnapshot>()
  private readonly memoryRecords = mapTable(this.memoryFallback)
  private readonly memorySnapshots = mapTable(this.memoryLedger)

  constructor(builtins: readonly WorkflowRecord[] = []) {
    this.registerBuiltins(builtins)
  }

  /**
   * 挂载预制流程（core3 启动期把流程实体交进来；幂等覆盖同名校验过的预制，
   * 不触碰 agent 修缮层）。校验失败 fail-loud（预制是代码作者的责任，宁可拒装
   * 不带病运行）。
   *
   * 同名冲突不由本方法裁决（不删不写修缮层）：优先级在 `view` 里按 locked 推导
   *（locked 预制优先 ⇒ 同名修缮降级 shadowed，见 `view`/`entries`/`delete`）。
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

  /** 生效记录表（域表或内存降级层）。 */
  private recordTable(): HostTable<WorkflowRecord> {
    return this.saved ?? this.memoryRecords
  }

  /** 账本表（域表或内存降级层）。 */
  private snapshotTable(): HostTable<WorkflowSnapshot> {
    return this.ledger ?? this.memorySnapshots
  }

  /**
   * 挂 storage 域表（域就绪后调用）。**迁入按 `version` 取新**：域内版本更高 ⇒
   * 不改域、把内存期记录归档为 `migration` 快照；账本条目同键跳过（只追加）。
   *
   * 失败语义（强审计）：任一步抛错 ⇒ **不挂域、不清内存**（内存仍是唯一真相），
   * 由宿主层点名告警。
   *
   * @param tables - 宿主 storage 域的 workflows / snapshots 表。
   * @returns 迁入报告（迁移数 / 取新数 / 点名 / 账本条数）。
   */
  async attachDomain(tables: WorkflowDomainTables): Promise<MigrationReport> {
    let migrated = 0
    let snapshotCount = 0
    const supersededNames: string[] = []
    // 1) 账本先迁（只追加：同键 = 同一版本，已在域中则跳过）。
    for (const [key, snapshot] of this.memoryLedger) {
      if (tables.snapshots.get(key) === undefined) {
        await tables.snapshots.put(key, snapshot)
        snapshotCount += 1
      }
    }
    // 2) 记录迁入：按 version 取新；落败方归档而非丢弃。
    for (const [name, record] of this.memoryFallback) {
      const existing = tables.workflows.get(name)
      if (existing !== undefined && existing.version > record.version) {
        await tables.snapshots.put(
          snapshotKey(record.name, record.version), this.snapshotOf(record, 'migration'),
        )
        supersededNames.push(name)
        continue
      }
      if (existing !== undefined && existing.version === record.version) continue
      await tables.workflows.put(name, record)
      migrated += 1
    }
    // 3) 全部成功才切换真相源。
    this.saved = tables.workflows
    this.ledger = tables.snapshots
    this.memoryFallback.clear()
    this.memoryLedger.clear()
    return {
      migrated,
      superseded: supersededNames.length,
      supersededNames,
      snapshots: snapshotCount,
    }
  }

  /** 域是否已挂（诊断/测试面）。 */
  get domainAttached(): boolean {
    return this.saved !== null
  }

  /**
   * 按名解析生效视图（**裁决优先级单一落点**，`get`/`list`/`entries` 共用）：
   *   - **locked 预制 ⇒ 内置优先**：同名修缮降级为 `shadowed`（保留在存储层待
   *     `delete` 清理），读取与执行一律用 locked 内置——locked 的「拒改拒删」在
   *     读取/执行侧同样成立（不再只在保存侧成立）；
   *   - 其它 ⇒ agent 修缮优先（非 locked 预制可被修缮覆盖，`delete` 还原为预制）。
   */
  private view(name: string): WorkflowEntryView | undefined {
    const builtin = this.builtins.get(name)
    const overlay = this.recordTable().get(name)
    if (builtin !== undefined && builtin.locked === true) {
      return overlay === undefined
        ? { record: builtin, origin: 'builtin' }
        : { record: builtin, origin: 'builtin', shadowed: overlay }
    }
    if (overlay !== undefined) return { record: overlay, origin: 'refined' }
    if (builtin !== undefined) return { record: builtin, origin: 'builtin' }
    return undefined
  }

  /** 全量视图（生效记录 + 来源 + 被遮蔽的同名修缮；list 工具面消费）。 */
  entries(): readonly WorkflowEntryView[] {
    const names = new Set<string>(this.builtins.keys())
    for (const [name] of this.recordTable().entries()) names.add(name)
    const out: WorkflowEntryView[] = []
    for (const name of names) {
      const entry = this.view(name)
      if (entry !== undefined) out.push(entry)
    }
    return out
  }

  /** 全量流程（生效记录；预制为底，非 locked 预制被同名修缮覆盖）。 */
  list(): readonly WorkflowRecord[] {
    return this.entries().map(entry => entry.record)
  }

  /** 按名取生效记录（locked 内置优先于同名修缮；其它修缮优先于预制）。 */
  get(name: string): WorkflowRecord | undefined {
    return this.view(name)?.record
  }

  /**
   * 保存（agent 修缮 / 新建）：
   *   1. locked 同名拒（预制锁死 + 红线：凭据流程不可被替换）；
   *   2. 凭据动词拒（agent 可写词汇表不含 sendCredential）；
   *   3. schema + 结构校验（校验即生效）；
   *   4. version 自增（覆盖时），updatedAt 记当前时刻；
   *   5. **强审计提交**：先记 `save` 快照，再写生效记录（账本失败 ⇒ 整体失败）。
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
    await this.appendSnapshot(record, 'save')
    await this.recordTable().put(record.name, record)
    return record
  }

  /**
   * 删除修缮层记录（账本先行：先归档 `delete` 快照，再删生效记录）。判据按
   * 「**删的是修缮还是内置本体**」分：
   *   - **有修缮**：删除之（含 locked 内置场景——生效一直是内置，删掉只是清掉
   *     遮蔽；否则只能手工清存储才能恢复）；
   *   - **无修缮且名对 locked 内置**：可读拒（内置本体不可删）；
   *   - **无修缮、非 locked 名**：false（非 locked 预制删除 = 还原为预制）。
   * @returns 是否删除了 agent 修缮（false = 无修缮可删）。
   * @throws locked 内置本体可读拒。
   */
  async delete(name: string): Promise<boolean> {
    const overlay = this.recordTable().get(name)
    if (overlay === undefined && this.builtins.get(name)?.locked === true) {
      throw new Error(`流程 ${name} 已锁定，不可删除`)
    }
    if (overlay === undefined) return false
    await this.appendSnapshot(overlay, 'delete')
    return this.recordTable().delete(name)
  }

  /** 历史（按版本倒序；只读账本）。 */
  history(name: string): readonly WorkflowSnapshot[] {
    const out: WorkflowSnapshot[] = []
    for (const [, snapshot] of this.snapshotTable().entries()) {
      if (snapshot.name === name) out.push(snapshot)
    }
    return out.sort((a, b) => b.version - a.version)
  }

  /**
   * 回滚到某个历史版本：取该快照的 `title`/`flow` **写一条新版本**（不原地改历史，
   * 与只追加账本自洽）。
   * @throws 可读错（无该版本快照 / locked 本体）。
   */
  async rollback(name: string, version: number): Promise<WorkflowRecord> {
    const snapshot = this.snapshotTable().get(snapshotKey(name, version))
    if (snapshot === undefined) {
      throw new Error(`已拒绝：流程 ${name} 没有 v${version} 的历史快照`)
    }
    return this.save({ name: snapshot.name, title: snapshot.title, flow: snapshot.flow })
  }

  /** 快照记录构造（账本只追加，因此每次都是新对象）。 */
  private snapshotOf(record: WorkflowRecord, reason: SnapshotReason): WorkflowSnapshot {
    return workflowSnapshotSchema.parse({
      name: record.name,
      version: record.version,
      title: record.title,
      locked: record.locked,
      updatedAt: record.updatedAt,
      flow: record.flow,
      archivedAt: new Date().toISOString(),
      reason,
    })
  }

  /** 追加快照 + 剪枝（超出 `MAX_SNAPSHOTS_PER_FLOW` 丢最旧）。 */
  private async appendSnapshot(record: WorkflowRecord, reason: SnapshotReason): Promise<void> {
    const table = this.snapshotTable()
    const snapshot = this.snapshotOf(record, reason)
    await table.put(snapshotKey(snapshot.name, snapshot.version), snapshot)
    await this.pruneSnapshots(snapshot.name)
  }

  /** 账本剪枝（每流程保留最近 `MAX_SNAPSHOTS_PER_FLOW` 个版本）。 */
  private async pruneSnapshots(name: string): Promise<void> {
    const versions: number[] = []
    for (const [, snapshot] of this.snapshotTable().entries()) {
      if (snapshot.name === name) versions.push(snapshot.version)
    }
    if (versions.length <= MAX_SNAPSHOTS_PER_FLOW) return
    versions.sort((a, b) => a - b)
    for (const version of versions.slice(0, versions.length - MAX_SNAPSHOTS_PER_FLOW)) {
      await this.snapshotTable().delete(snapshotKey(name, version))
    }
  }
}
