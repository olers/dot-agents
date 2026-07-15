import { writeFile, rm, access } from 'node:fs/promises'

// vitest 跑源码：server 的 WEB_ROOT 解析到 src/web，那里没有 index.html。
// 命中静态资源 200 分支（CSP 头挂在这条分支上）需要一个真文件。
// globalSetup 全程只跑一次：整场测试期间保证该文件存在，跑完删掉（仅当是本文件创建的）。
// 用 globalSetup 而非各文件 beforeAll，是为了避免并行 worker 之间对同一路径 create/delete 打架。
const WEB_INDEX = new URL('../../src/web/index.html', import.meta.url)

export async function setup(): Promise<void> {
  try {
    await access(WEB_INDEX)
  } catch {
    await writeFile(WEB_INDEX, '<html><head></head><body>test</body></html>', 'utf8')
    // 标记：是本次创建的，teardown 才删
    process.env.__DOT_AGENTS_WEB_FIXTURE_CREATED__ = '1'
  }
}

export async function teardown(): Promise<void> {
  if (process.env.__DOT_AGENTS_WEB_FIXTURE_CREATED__ === '1') {
    await rm(WEB_INDEX, { force: true })
  }
}
