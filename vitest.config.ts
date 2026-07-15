import { defineConfig } from 'vitest/config'

export default defineConfig({
  // 组件测试是 .tsx。只 include .test.ts 的话，整个文件一条都不会跑，
  // 而 vitest 照样打印 PASS —— 「测试通过」就成了一句谎话。
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
    // 全程一次：保证 src/web/index.html 存在，让 server 静态资源 200 分支（CSP 头）可测。
    globalSetup: ['tests/setup/web-fixture.ts'],
  },
  esbuild: { jsx: 'automatic' },
})
