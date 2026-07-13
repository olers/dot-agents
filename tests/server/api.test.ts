import { describe, it, expect, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startServer } from '../../src/server/index.js'
import { pathKind } from '../../src/core/fsx.js'
import { mkRepo, cleanupRepo, type Layout } from '../helpers/mkrepo.js'

const roots: string[] = []
const closers: Array<() => void> = []
afterEach(async () => {
  closers.splice(0).forEach((c) => c())
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

async function boot(layout: Layout) {
  const root = await mkRepo(layout)
  roots.push(root)
  const srv = await startServer(root)
  closers.push(srv.close)
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${srv.url}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-agents-token': srv.token,
        ...(init.headers ?? {}),
      },
    })
  return { root, srv, call }
}

describe('server', () => {
  // WHY: 没有 token 校验，本机上任何一个网页都能 POST /api/apply 删你的文件。
  it('没有 token -> 401', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await fetch(`${srv.url}/api/state`)
    expect(res.status).toBe(401)
  })

  it('GET /api/state -> 仓库 + 全局', async () => {
    const { call } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const body = await (await call('/api/state')).json()
    expect(body.repo.tools['.claude'].dims.skills.kind).toBe('real')
    expect(body.global).toBeDefined()
  })

  it('POST /api/plan 带 resolutions -> 冲突被裁决', async () => {
    const { call } = await boot({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const p1 = await (
      await call('/api/plan', { method: 'POST', body: JSON.stringify({ resolutions: {} }) })
    ).json()
    expect(p1.skipped).toHaveLength(1)

    const p2 = await (
      await call('/api/plan', {
        method: 'POST',
        body: JSON.stringify({ resolutions: { 'skills/foo': '.claude' } }),
      })
    ).json()
    expect(p2.skipped).toHaveLength(0)
    expect(p2.resolved).toEqual({ 'skills/foo': '.claude' })
  })

  // WHY: 这是整个 server 最重要的一条。Plan.ops 里全是 move / discard / rmdir，
  // 前端可以在里面写任何路径。一旦照单执行，localhost 上就多了一个任意文件删除接口。
  it('POST /api/apply 无视前端传来的 ops，只认 resolutions', async () => {
    const { root, call } = await boot({
      '.claude/skills/foo/SKILL.md': 'x',
      'PRECIOUS.md': 'keep me',
    })

    const res = await call('/api/apply', {
      method: 'POST',
      body: JSON.stringify({
        resolutions: {},
        force: true,
        // 恶意注入：试图让后端删掉 PRECIOUS.md
        plan: { ops: [{ t: 'discard', path: join(root, 'PRECIOUS.md') }] },
        ops: [{ t: 'discard', path: join(root, 'PRECIOUS.md') }],
      }),
    })
    const body = await res.json()
    expect(body.ok).toBe(true)

    // PRECIOUS.md 必须还在
    expect(await readFile(join(root, 'PRECIOUS.md'), 'utf8')).toBe('keep me')
    // 而后端自己算出来的 plan 正常执行了
    expect(await pathKind(join(root, '.claude/skills'))).toBe('symlink')
  })

  // WHY: /api/file 是这个 server 上唯一的读文件出口。没有 token 校验，
  // 本机上任何一个网页都能拿它读你 ~/.claude 下的东西。
  it('GET /api/file 没有 token -> 401', async () => {
    const { root, srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const p = encodeURIComponent(join(root, '.claude/skills/foo/SKILL.md'))
    const res = await fetch(`${srv.url}/api/file?path=${p}`)
    expect(res.status).toBe(401)
  })

  it('GET /api/file 读维度下的文件 -> 200', async () => {
    const { root, call } = await boot({ '.claude/skills/foo/SKILL.md': 'hello foo' })
    const p = encodeURIComponent(join(root, '.claude/skills/foo/SKILL.md'))
    const body = await (await call(`/api/file?path=${p}`)).json()
    expect(body.content).toBe('hello foo')
    expect(body.binary).toBe(false)
  })

  // WHY: 和 POST /api/apply 那条同等重要。前端可以在 path 里写任何东西 ——
  // 后端必须自己判，不能信。
  it('GET /api/file 读维度之外的文件 -> 403', async () => {
    const { root, call } = await boot({
      '.claude/skills/foo/SKILL.md': 'x',
      'PRECIOUS.md': 'keep me',
    })
    const p = encodeURIComponent(join(root, 'PRECIOUS.md'))
    const res = await call(`/api/file?path=${p}`)
    expect(res.status).toBe(403)
  })

  // WHY: path 是拼在 query string 里传的。encodeURIComponent -> URLSearchParams
  // 这条链路现在是对的，但没有测试锁住它 —— 有人把 getFile 改成手写字符串拼接
  // （比如 `?path=${want}` 不经过 encodeURIComponent），空格/# 会把 query 截断，
  // & 会被拆成多个参数，这条测试才会亮红灯。
  it('GET /api/file 条目名带空格和 # -> 200，内容能读到', async () => {
    const { root, call } = await boot({ '.claude/commands/my cmd#1.md': 'hash & space 都在' })
    const p = encodeURIComponent(join(root, '.claude/commands/my cmd#1.md'))
    const body = await (await call(`/api/file?path=${p}`)).json()
    expect(body.content).toBe('hash & space 都在')
  })

  it('GET /api/file 读不存在的文件 -> 404', async () => {
    const { root, call } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const p = encodeURIComponent(join(root, '.claude/skills/foo/NOPE.md'))
    const res = await call(`/api/file?path=${p}`)
    expect(res.status).toBe(404)
  })
})
