import { describe, it, expect, afterEach } from 'vitest'
import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { startServer } from '../../src/server/index.js'
import { mkRepo, cleanupRepo, type Layout } from '../helpers/mkrepo.js'

const roots: string[] = []
const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()))
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

async function boot(layout: Layout) {
  const root = await mkRepo(layout)
  roots.push(root)
  const srv = await startServer(root)
  closers.push(srv.close)
  return { root, srv }
}
// 注：Task 2 会把 boot 改成 (layout, opts?) 透传 startServer 第二参数。

// 指定 Host 头打裸 HTTP。fetch 会拒绝伪造 host，必须用 node:http。
function rawGet(port: number, path: string, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: { host } },
      (res) => {
        res.resume()
        resolve(res.statusCode ?? 0)
      },
    )
    req.on('error', reject)
    req.end()
  })
}

describe('Host 校验', () => {
  // WHY: serve 长驻 + 固定端口后，DNS rebinding 页面可以同源读 index.html 偷 token，
  // 再调 /api/apply 搬删仓库文件。Host 白名单是这条链的总闸。
  it('坏 Host -> 全路径 403', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(await rawGet(srv.port, '/', 'evil.com:1234')).toBe(403)
    expect(await rawGet(srv.port, '/healthz', 'evil.com:1234')).toBe(403)
    expect(await rawGet(srv.port, '/api/state', 'evil.com:1234')).toBe(403)
  })

  it('好 Host（127.0.0.1 / localhost / [::1]）-> 放行', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(await rawGet(srv.port, '/healthz', `127.0.0.1:${srv.port}`)).toBe(200)
    expect(await rawGet(srv.port, '/healthz', `localhost:${srv.port}`)).toBe(200)
    expect(await rawGet(srv.port, '/healthz', `[::1]:${srv.port}`)).toBe(200)
  })
})

describe('GET /healthz', () => {
  // WHY: 宿主（门户）重启后要判断「端口上是谁、扫的是不是我要的仓库」，
  // 决定复用还是重拉。没有免 token 的身份端点就只能盲杀重启。
  it('免 token，version 精确等于 package.json.version', async () => {
    const { root, srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await fetch(`${srv.url}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    const pkg = JSON.parse(await readFile(new URL('../../package.json', import.meta.url), 'utf8'))
    expect(body.app).toBe('dot-agents')
    expect(body.version).toBe(pkg.version)
    expect(body.repoRoot).toBe(root)
  })
})
