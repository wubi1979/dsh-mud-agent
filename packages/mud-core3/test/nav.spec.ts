/**
 * nav/stamina 单测（T23.10）：精力闸的比值口径与"未知即放行"。
 * 判据出处：A.9 结论 7（`walk_speed` 档位）+ A.7.1 结论 4（精力可为上限的 200%）+ 用户裁定 20%。
 */

import { describe, expect, it } from 'vitest'
import {
  DEFAULT_STAMINA_FLOOR_PCT, belowStaminaFloor, staminaRatio,
} from '../src/nav/stamina.ts'

describe('nav/stamina 精力闸（T23.10）', () => {
  it('占比 = 精力 / 最大精力；精力可为上限的 200%（A.7.1 结论 4）', () => {
    expect(staminaRatio(150, 100)).toBe(1.5)
    expect(staminaRatio(200, 100)).toBe(2)
    expect(staminaRatio(20, 100)).toBe(0.2)
  })

  it('未知 / 非法 ⇒ null（"不知道"不等于"不足"）', () => {
    expect(staminaRatio(undefined, 100)).toBeNull()
    expect(staminaRatio(50, undefined)).toBeNull()
    expect(staminaRatio('50', 100)).toBeNull()
    expect(staminaRatio(50, 0)).toBeNull()
    expect(staminaRatio(50, -1)).toBeNull()
    expect(staminaRatio(Number.NaN, 100)).toBeNull()
  })

  it('闸门比较：低于为 true、等于/高于为 false、未知为 null', () => {
    expect(belowStaminaFloor(10, 100)).toBe(true)
    expect(belowStaminaFloor(19, 100)).toBe(true)
    expect(belowStaminaFloor(20, 100)).toBe(false) // 恰好 20% 不算不足
    expect(belowStaminaFloor(200, 100)).toBe(false)
    expect(belowStaminaFloor(undefined, 100)).toBeNull()
  })

  it('阈值可覆盖（Config staminaFloorPct 与 T21 战斗规则共用同一值）', () => {
    expect(DEFAULT_STAMINA_FLOOR_PCT).toBe(0.2)
    expect(belowStaminaFloor(30, 100, 0.5)).toBe(true)
    expect(belowStaminaFloor(30, 100, 0.2)).toBe(false)
  })
})
