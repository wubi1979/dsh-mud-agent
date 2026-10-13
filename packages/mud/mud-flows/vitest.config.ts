import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.spec.ts'],
    environment: 'node',
    // T28：login/fullme 为引擎集成 E2E，归 mud/tests 覆盖；本包暂无自有单测。
    passWithNoTests: true,
  },
})
