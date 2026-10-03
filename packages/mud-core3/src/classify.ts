/**
 * mud-core3 classify — 行分类器（C5.2）：MudLine.kind 的**全系统唯一写入点**。
 *
 * 分类与路由判定都在服务端（规则更新 = 后端重启即生效，无前后端规则不一致）：
 *   - 输入 = `line.text`（纯文本，无 ANSI——解析层已剥离，恰为判据匹配变体）；
 *   - 输出 = 就地写 `line.kind`（无命中保留 null，不改 text/raw/style/abs）；
 *   - 规则 = Config 正则清单（`{kind, source, flags?}`，构造期编译，非法正则
 *     fail-loud 拒装）；**声明序**取首个命中（先声明优先）。
 *
 * 缺省规则（语料校准 2026-10-03：logs/ 实录 + 实机房间语料核对）：
 *   - `chat`：`^\s*【频道】` 锚定 ——【闲聊】×4 +【交易】×2 共 6/6 命中，
 *     同日 95KB 全量 stream 行零误报（游戏系统输出不以【开头）。
 *   - `action`（他人动作/进出）：**主语前置洞见（2026-10-03 用户）——自身活动
 *     一律「你」开头，故 `^(?!你)` 排除自身**；锚行尾（走了过来/离开/连线/断线），
 *     战斗接近（冲了过来）不收——留给 danger 判据。
 *   - `vitals`（他人状态刷屏）：真气循环等——同 `^(?!你)` 主语排除；**自身状态
 *     （你渴/活跃度警告）保留主屏**（2026-10-03 用户裁定修正，agent 需据此行动）。
 *   - 房间说话（无频道头的说道/道/打听）：**暂不打标**——等日常观察漏出量再按
 *     「非你主语」判别补规则（2026-10-03 用户裁定）。
 *
 * 打标零副作用：录制缓冲/日志仍全量（剔除只发生在投递侧，见 deliver.ts）。
 *
 * 纯 TS，零宿主依赖。
 *
 * @module mud-core3/classify
 */

import type { MudLine } from './link/line.ts'

/** Config 形态的一条分类规则（正则以字符串声明，构造期编译）。 */
export interface ClassifyRuleSpec {
  /** 命中后写入 line.kind 的标（如 'chat' / 'action'）。 */
  kind: string
  /** 正则源文本（判据书写纪律适用：行首锚必配 flags:'m'；量词不越行）。 */
  source: string
  /** 正则 flags（缺省无；多行锚用 'm'）。 */
  flags?: string
}

/**
 * 缺省分类规则（声明序）。
 *
 * chat 频道行的判定依据（语料锚点 2026-10-03）：pkuxkx 频道输出以全角【频道名】
 * 开头（【闲聊】【交易】等），频道名 ≤6 字；其余游戏输出（横幅/战斗/地图）实证
 * 不以【开头。整窗匹配模型下行安全：`.` 不跨行，首字符锚定。
 *
 * action 锚行尾（游戏动作句以谓语短语收尾，最稳）；`^(?!你)` = 主语排除：
 * 本游戏自身活动一律「你」开头（2026-10-03 用户洞见），他人动作句主语为他人名。
 * vitals = 自身状态刷屏/警告（用户裁定全部进副屏，不进投递）。
 */
export const DEFAULT_CLASSIFY_RULES: readonly ClassifyRuleSpec[] = [
  { kind: 'chat', source: '^\\s*【[^】]{1,6}】' },
  // ── action：他人动作/进出（主语非你；战斗接近「冲了过来」不收）──
  { kind: 'action', source: '^(?!你).*(走|踱)了过来。$' },           // 雷平坤…走了过来。/ 一个才女…踱了过来。
  { kind: 'action', source: '^(?!你).*离开(了|游戏)?。$' },          // 雷平坤往西离开。/ 行者急急忙忙地离开了。/ 孟早车离开游戏。
  { kind: 'action', source: '^(?!你).*连线进入这个世界。$' },        // 暴雪连线进入这个世界。
  { kind: 'action', source: '^(?!你).*重新连线回到这个世界。$' },    // 了悔重新连线回到这个世界。
  { kind: 'action', source: '^(?!你).*断线了。$' },                  // 了悔断线了。
  { kind: 'action', source: '^(?!你).*给[^\\s，。]{1,8}一[件双条枚]' }, // 文玉给梁红蝉一双巨灵之靴。
  // ── vitals：他人状态刷屏（主语非你；自身状态/警告保留主屏，2026-10-03 用户裁定）──
  { kind: 'vitals', source: '^(?!你)[^\\s，。！？【』]{1,8}真气' },   // 本小减缓真气…/本小运行真气…（旁人 idling 刷屏）
]

/** 编译后的规则（内部形态）。 */
interface CompiledRule {
  readonly kind: string
  readonly re: RegExp
}

/** Config 规则清单 → 编译规则（非法正则 fail-loud：部署错误启动即炸，不静默失效）。 */
export function compileRules(specs: readonly ClassifyRuleSpec[]): CompiledRule[] {
  return specs.map(spec => {
    let re: RegExp
    try {
      re = new RegExp(spec.source, spec.flags ?? '')
    } catch (cause) {
      throw new Error(`分类规则编译失败（kind=${spec.kind}）：${String(cause)}`)
    }
    return { kind: spec.kind, re }
  })
}

/**
 * 行分类器：单实例持有编译后的规则表，`mark(line)` 就地写入 kind。
 *
 * 每会话一个实例（规则全会话一致；实例本身无状态，共享亦可）。
 */
export class Classifier {
  private readonly rules: CompiledRule[]

  /** @param rules 规则清单；缺省 DEFAULT_CLASSIFY_RULES。 */
  constructor(rules: readonly ClassifyRuleSpec[] = DEFAULT_CLASSIFY_RULES) {
    this.rules = compileRules(rules)
  }

  /**
   * 唯一打标入口：按声明序取首个命中写 `line.kind`；无命中保留 null。
   * 匹配输入 = `line.text`（去 ANSI 变体）；不改行的其他任何字段。
   */
  mark(line: MudLine): void {
    for (const rule of this.rules) {
      if (rule.re.test(line.text)) {
        line.kind = rule.kind
        return
      }
    }
  }
}
