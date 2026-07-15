import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
import { writeFile, readFile } from 'node:fs/promises'
import { mkGitRepo, mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
const procs: ChildProcess[] = []
afterEach(async () => {
  procs.splice(0).forEach((p) => p.kill('SIGKILL'))
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer().listen(0, '127.0.0.1', () => {
      const addr = s.address()
      const p = typeof addr === 'object' && addr ? addr.port : 0
      s.close(() => resolve(p))
    })
  })
}

function serveCli(args: string[]) {
  const proc = spawn('npx', ['tsx', 'src/cli/index.ts', 'serve', ...args], {
    cwd: process.cwd(),
  })
  procs.push(proc)
  let out = ''
  proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
  let err = ''
  proc.stderr!.on('data', (d: Buffer) => (err += d.toString()))
  const firstLine = new Promise<string>((resolve, reject) => {
    proc.stdout!.on('data', () => {
      const nl = out.indexOf('\n')
      if (nl >= 0) resolve(out.slice(0, nl))
    })
    proc.on('exit', (code) => reject(new Error(`exited ${code} before output; stderr=${err}`)))
  })
  const exited = new Promise<number | null>((r) => proc.on('exit', r))
  return { proc, firstLine, exited, stderr: () => err, stdout: () => out }
}

describe('dot-agents serve', () => {
  // WHY: 这行 JSON 就是对宿主的启动契约。格式破坏 = 所有宿主的就绪探测全瞎。
  it('首行 JSON 契约 + healthz 指向 --repo + 首行前无输出', async () => {
    const repo = await mkGitRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    const cli = serveCli(['--repo', repo])
    const line = await cli.firstLine
    expect(cli.stdout().indexOf(line)).toBe(0) // 首行之前没有别的输出
    const info = JSON.parse(line)
    expect(Object.keys(info).sort()).toEqual(['app', 'port', 'url']) // 键集精确，宿主按形状校验
    expect(info.app).toBe('dot-agents')
    expect(info.port).toBeGreaterThan(0)
    expect(info.url).toBe(`http://127.0.0.1:${info.port}`)
    const health = await (await fetch(`${info.url}/healthz`)).json()
    expect(health.repoRoot).toBe(repo)
  })

  it('--port 固定端口生效；--allow-embed 透传到 CSP 头', async () => {
    const repo = await mkGitRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    const want = await freePort()
    const cli = serveCli([
      '--repo', repo, '--port', String(want),
      '--allow-embed', 'http://localhost:5273',
    ])
    const info = JSON.parse(await cli.firstLine)
    expect(info.port).toBe(want)
    const res = await fetch(`${info.url}/`)
    expect(res.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' http://localhost:5273",
    )
  })

  // WHY: 宿主靠 exit code 区分「起没起来」。lego CLI 当年退出码判不出流水线状态，别再犯。
  it('端口被占 -> stderr + exit 1，不换端口', async () => {
    const repo = await mkGitRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    const a = serveCli(['--repo', repo])
    const info = JSON.parse(await a.firstLine)
    const b = serveCli(['--repo', repo, '--port', String(info.port)])
    expect(await b.exited).toBe(1)
    expect(b.stderr()).toContain('启动失败')
    expect(b.stdout()).toBe('') // 没起来就不许打首行 JSON
  })

  it('--repo 指向非 git 目录 -> exit 1', async () => {
    const notGit = await mkRepo({ 'readme.txt': 'x' })
    roots.push(notGit)
    const cli = serveCli(['--repo', notGit])
    expect(await cli.exited).toBe(1)
  })

  it('非法 --port -> exit 1', async () => {
    const repo = await mkGitRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    expect(await serveCli(['--repo', repo, '--port', 'abc']).exited).toBe(1)
    expect(await serveCli(['--repo', repo, '--port', '99999']).exited).toBe(1)
  })

  // WHY: 宿主用 SIGTERM 收编生命周期；不优雅退出会把端口和半截响应留给下一次启动。
  it('SIGTERM -> 优雅退出 exit 0', async () => {
    const repo = await mkGitRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    const cli = serveCli(['--repo', repo])
    await cli.firstLine
    cli.proc.kill('SIGTERM')
    expect(await cli.exited).toBe(0)
  })
})

describe('CLI 接线冒烟', () => {
  it('--help 列出 serve/status（只证注册，不证行为）', async () => {
    const proc = spawn('npx', ['tsx', 'src/cli/index.ts', '--help'])
    procs.push(proc)
    let out = ''
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    const code = await new Promise<number | null>((r) => proc.on('exit', r))
    expect(code).toBe(0)
    expect(out).toContain('serve')
    expect(out).toContain('status')
  })
})

describe('默认命令回归（真跑无子命令路径）', () => {
  // WHY: Commander 接线动过。默认行为（随机端口 + open 浏览器 + Ctrl-C 退出）
  // 不能被 serve 顺手改坏。用 PATH 垫一个假 `open` 防测试真弹浏览器。
  it('无子命令：打启动行、healthz 通、SIGINT 退出 0、调用了 open', async () => {
    const repo = await mkGitRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    const shim = await mkRepo({}) // 空目录当 PATH 垫片目录
    roots.push(shim)
    const openLog = `${shim}/open.log`
    await writeFile(`${shim}/open`, `#!/bin/sh\necho "$@" >> "${openLog}"\nexit 0\n`, { mode: 0o755 })

    const proc = spawn('npx', ['tsx', `${process.cwd()}/src/cli/index.ts`], {
      cwd: repo,
      env: { ...process.env, PATH: `${shim}:${process.env.PATH}` },
    })
    procs.push(proc)
    let out = ''
    proc.stdout!.on('data', (d: Buffer) => (out += d.toString()))
    await new Promise<void>((resolve, reject) => {
      proc.stdout!.on('data', () => out.includes('已启动') && resolve())
      proc.on('exit', (c) => reject(new Error(`exited ${c}: ${out}`)))
    })
    const url = out.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0]
    expect(url).toBeTruthy() // 随机端口起来了
    expect((await fetch(`${url}/healthz`)).status).toBe(200)
    // open 是异步 fire-and-forget。并行子进程负载下固定 500ms 太短会假红，
    // 改成有界轮询：最多等 8s，等到 shim 落 log 即断言（断言不变，只换等待策略）。
    let openLogged = ''
    for (let i = 0; i < 80 && !openLogged.includes(url!); i++) {
      openLogged = await readFile(openLog, 'utf8').catch(() => '')
      if (openLogged.includes(url!)) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(openLogged).toContain(url!) // open 被调用（默认行为唯一证明）
    proc.kill('SIGINT')
    expect(await new Promise<number | null>((r) => proc.on('exit', r))).toBe(0)
  })
})
