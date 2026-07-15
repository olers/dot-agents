import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest'
import { request } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { readFile, writeFile, rm, access } from 'node:fs/promises'

import { startServer } from '../../src/server/index.js'
import { mkRepo, cleanupRepo, type Layout } from '../helpers/mkrepo.js'

const roots: string[] = []
const closers: Array<() => void | Promise<void>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()))
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

// vitest 跑源码：server 的 WEB_ROOT 解析到 src/web，那里没有 index.html，
// 命中静态资源 200 分支（CSP 头就挂在这条分支上）就需要一个真文件。
// 造一个临时的 src/web/index.html 让静态分支可达，跑完删掉；已存在则不碰。
const WEB_INDEX = new URL('../../src/web/index.html', import.meta.url)
let createdWebIndex = false
beforeAll(async () => {
  try {
    await access(WEB_INDEX)
  } catch {
    await writeFile(WEB_INDEX, '<html><head></head><body>test</body></html>', 'utf8')
    createdWebIndex = true
  }
})
afterAll(async () => {
  if (createdWebIndex) await rm(WEB_INDEX, { force: true })
})

async function boot(layout: Layout, opts: Parameters<typeof startServer>[1] = {}) {
  const root = await mkRepo(layout)
  roots.push(root)
  const srv = await startServer(root, opts)
  closers.push(srv.close)
  return { root, srv }
}

// 先占后放拿一个「刚刚还空闲」的端口。有理论 race，本地测试可接受。
function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(p))
    })
  })
}

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

describe('startServer 选项', () => {
  // WHY: 宿主要在自己的配置里记死端口。绑定成功必须绑的就是那个端口；
  // 端口被占必须炸给宿主看，静默换端口会让宿主拿着旧 URL 白屏。
  it('指定可用端口 -> 绑定的就是该端口', async () => {
    const want = await freePort()
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' }, { port: want })
    expect(srv.port).toBe(want)
    expect((await fetch(`${srv.url}/healthz`)).status).toBe(200)
  })

  it('端口被占 -> reject EADDRINUSE，不换端口', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const root2 = await mkRepo({ '.claude/skills/bar/SKILL.md': 'y' })
    roots.push(root2)
    await expect(startServer(root2, { port: srv.port })).rejects.toThrow(/EADDRINUSE/)
  })

  // WHY: 长驻后恶意页面可以 iframe 叠透明层骗点 Apply（clickjacking）。
  // 给了 allow-embed 才收紧 frame-ancestors；值原样透传以支持多 origin。
  it('allowEmbed 多 origin 原样进 CSP；缺省无 CSP 头', async () => {
    const a = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    expect((await fetch(`${a.srv.url}/`)).headers.get('content-security-policy')).toBeNull()

    const b = await boot(
      { '.claude/skills/foo/SKILL.md': 'x' },
      { allowEmbed: 'http://localhost:5273 http://127.0.0.1:5273' },
    )
    expect((await fetch(`${b.srv.url}/`)).headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' http://localhost:5273 http://127.0.0.1:5273",
    )
  })
})
