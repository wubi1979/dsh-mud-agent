/**
 * dsh-mud-core — 行判据编译 (纯函数, 匹配服务域)。
 *
 * 把**行判据** (MatchSpec/FlowMatch 的 `regex`/`text` 子集) 编译为单个标记正则
 * (any-of, 逐行测)。消费方: 分帧器的武装标记接线 (§8.5) 与流程运行时的 arming
 * (§19) —— 判据编译属**匹配域**机制, 故住 `services/matcher/`, 不属任何一个消费方
 * (曾住 session/frame-splitter.ts, flow 跨域伸手反被纠正)。
 * @module @deepseek-ai/dsh-mud-core/services/matcher/criteria
 */

/**
 * 行判据 → 单个正则 (any-of, 逐行测)。
 *
 * `regex` 各 pattern 包裹后取 alternation; `text` 字面量转义后取 alternation
 * (未锚定正则 ≈ 子串语义)。`func`/`ga` 等非行判据返回 null (调用方跳过武装,
 * 仍走帧提交后的被动匹配)。
 */
export function lineCriteriaPattern(spec: {
  kind: string
  patterns?: readonly (string | RegExp)[]
  includes?: readonly string[]
}): RegExp | null {
  try {
    if (spec.kind === 'regex' && spec.patterns !== undefined && spec.patterns.length > 0) {
      return new RegExp(spec.patterns.map(p => `(?:${typeof p === 'string' ? p : p.source})`).join('|'))
    }
    if (spec.kind === 'text' && spec.includes !== undefined && spec.includes.length > 0) {
      return new RegExp(spec.includes.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'))
    }
  } catch {
    return null // 非法正则 → 不武装 (宿主被动匹配仍生效)
  }
  return null
}
