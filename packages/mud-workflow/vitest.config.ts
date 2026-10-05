import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `*.e2e.ts` = 工件面用例（导入 lib/ 产物；缺产物自动跳过），见 test/plugin-load.e2e.ts。
    include: ['test/**/*.spec.ts', 'test/**/*.e2e.ts'],
    environment: 'node',
  },
})
