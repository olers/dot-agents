# serve 宿主模式 Implementation Plan（v2）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `dot-agents serve` 宿主模式（长驻/定端口/不 open），补 Host 校验、/healthz、CSP 嵌入控制与 npm git 依赖分发修复。

**Architecture:** 全部服务端逻辑进 `startServer`（默认模式与 serve 模式共用同一加固）；CLI 只加一个薄 `serve` 子命令。契约 = CLI flags + HTTP（`/healthz` + 现有 API），宿主零 import。

**Tech Stack:** TypeScript + node:http、commander、vitest。

**Spec:** `docs/superpowers/specs/2026-07-15-serve-mode-design.md`

## 导读（给非技术读者）

dot-agents 现在只能「开一次用一次」：跑起来自动弹浏览器，关掉就没了。别的工具（比如 camp-d2c 门户）想把它的界面装进自己页面里，需要它能安静地待在指定门牌号上被托管。本计划就是给它加这个「被托管」模式，同时把长驻带来的安全问题（恶意网页冒充本机来偷操作权）一并堵死，并修好「别人通过 npm 安装装出坏包」的分发问题。默认用法完全不变。

## 修订记录

- **R1（2026-07-15，plan-review 14 维）→ v2**：吸收全部 6 条硬阻断中涉及上游的 3 条 + 清单 A 全部 6 项 —— CLI 测试改真 git fixture（mkRepo 不建 `.git`，原 happy 测试必炸）；补固定端口成功绑定测试；`close` 改可 await；SIGTERM 等 close 完成再退；`--allow-embed` 支持多 origin 原样透传；补占用 exit 1 / 首行 JSON 精确形状 / 非法端口 / 默认命令回归测试；Task 4 补 `package-lock.json`（现存 bin=`agents`、engines>=20 漂移）+ 临时 consumer 真装验证；新增 Task 5（README serve 章节）。
- **顶回 1 条**：R1 第 14 维要求入口拆到 ≤400 行 —— 那是 camp-d2c 仓库约定；本仓库走 superpowers 约定（代码完整内联、禁占位符），不拆，补导读代偿。R2 如仍有异议再裁。

## Global Constraints

- `engines.node` 目标值 `>=18`（本计划内从 `>=20` 降下来）。
- 默认命令 `dot-agents`（无子命令）行为不得变化：随机端口 + open 浏览器 + Ctrl-C 退出。
- 测试命名沿用现有风格：中文描述 + `// WHY:` 注释；helper 用 `tests/helpers/mkrepo.ts` 的 `mkRepo/cleanupRepo`。
- stdout 首行 JSON 之前不得有任何 stdout 输出（宿主契约）。
- commit 不加任何 Co-Authored-By 尾注。

---

### Task 1: Host 校验 + GET /healthz

**Files:**
- Modify: `src/server/index.ts`
- Test: `tests/server/serve.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `startServer(repoRoot)`、`mkRepo`。
- Produces: 所有响应先过 Host 白名单（`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，其余 403）；新端点 `GET /healthz` 免 token 返回 `{app:'dot-agents', version:<精确等于 package.json.version>, repoRoot:<string>}`。Task 2/3 依赖此文件结构。

- [ ] **Step 1: 写失败测试**

新建 `tests/server/serve.test.ts`。undici 的 `fetch` 不允许伪造 Host 头，坏 Host 用 `node:http` 裸请求。

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/serve.test.ts`
Expected: FAIL —— 坏 Host 返回 200/401 而非 403；`/healthz` 404。

- [ ] **Step 3: 实现**

`src/server/index.ts` 三处改动。

(1) `startServer` 函数体开头读版本（放函数内而非顶层 await —— 不赌 tsconfig 的 module 设置）：

```ts
export async function startServer(
  repoRoot: string,
): Promise<{ url: string; token: string; port: number; close: () => Promise<void> }> {
  const token = randomBytes(24).toString('hex')
  // dist/server/ -> 包根。healthz 要报版本，宿主靠它判断兼容性。
  const pkg = JSON.parse(
    await readFile(join(HERE, '../../package.json'), 'utf8'),
  ) as { version: string }
  let boundPort = 0
```

(2) `createServer` 回调开头（`const path = ...` 之前）加 Host 闸：

```ts
    // Host 白名单：rebinding 页面的 Host 是攻击者域名。403 在一切路由之前。
    const host = req.headers.host ?? ''
    if (
      host !== `127.0.0.1:${boundPort}` &&
      host !== `localhost:${boundPort}` &&
      host !== `[::1]:${boundPort}`
    ) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }

    const path = new URL(req.url ?? '/', 'http://127.0.0.1').pathname

    if (path === '/healthz' && req.method === 'GET') {
      json(res, 200, { app: 'dot-agents', version: pkg.version, repoRoot })
      return
    }
    // ……以下原有 /api/ 与静态资源逻辑不动
```

(3) listen 后赋值 `boundPort`；`close` 改为可 await（否则串测端口不释放、宿主拿不到确定的关闭时点）：

```ts
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  boundPort = port

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      ),
  }
```

同步改 `src/cli/index.ts` 默认命令的 SIGINT：`close()` 现在返回 Promise ——

```ts
  process.on('SIGINT', () => {
    void close().finally(() => process.exit(0))
  })
```

- [ ] **Step 4: 全量测试过**

Run: `npx vitest run`
Expected: 全 PASS（现有 `tests/server/api.test.ts` 用 `srv.url` 发请求 Host 天然合法；其 closers 同步调用 Promise 版 close 仍兼容）。

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/cli/index.ts tests/server/serve.test.ts
git commit -m "feat(server): Host 白名单 + GET /healthz + close 可等待（防 DNS rebinding，给宿主做身份探测）"
```

---

### Task 2: startServer 选项（--port / --allow-embed 的底层）

**Files:**
- Modify: `src/server/index.ts`
- Test: `tests/server/serve.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 后的 `startServer`。
- Produces: `startServer(repoRoot, opts?: { port?: number; allowEmbed?: string })`。`opts.port` 占用时 Promise reject（`EADDRINUSE`）、可用时精确绑定该端口；`opts.allowEmbed`（原样字符串，可含多个空格分隔 origin）时静态资源响应带 `Content-Security-Policy: frame-ancestors 'self' <origins>`。Task 3 的 CLI 直接透传这两个选项。

- [ ] **Step 1: 写失败测试**

`tests/server/serve.test.ts`：先把 boot 改成透传选项 ——

```ts
async function boot(layout: Layout, opts: Parameters<typeof startServer>[1] = {}) {
  const root = await mkRepo(layout)
  roots.push(root)
  const srv = await startServer(root, opts)
  closers.push(srv.close)
  return { root, srv }
}
```

顶部补 `import { createServer as createNetServer } from 'node:net'` 与取空闲端口 helper：

```ts
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
```

再追加：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/serve.test.ts`
Expected: FAIL —— `startServer` 第二参数不存在（被忽略）、无 CSP 头。

- [ ] **Step 3: 实现**

`src/server/index.ts`：

(1) 签名与 listen：

```ts
export interface StartServerOptions {
  port?: number
  allowEmbed?: string
}

export async function startServer(
  repoRoot: string,
  opts: StartServerOptions = {},
): Promise<{ url: string; token: string; port: number; close: () => Promise<void> }> {
```

listen 块改为（EADDRINUSE 走 reject，而不是进程静默挂着）：

```ts
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
```

(2) 静态资源响应头（原 `res.writeHead(200, { 'content-type': ... })` 改为）：

```ts
    const headers: Record<string, string> = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    }
    if (opts.allowEmbed) {
      headers['content-security-policy'] = `frame-ancestors 'self' ${opts.allowEmbed}`
    }
    res.writeHead(200, headers)
```

- [ ] **Step 4: 全量测试过**

Run: `npx vitest run`
Expected: 全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts tests/server/serve.test.ts
git commit -m "feat(server): startServer 支持指定端口（占用即拒）与 frame-ancestors 嵌入白名单"
```

---

### Task 3: CLI `serve` 子命令

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli/serve.test.ts`（新建）、`tests/helpers/mkrepo.ts`（加 mkGitRepo）

**Interfaces:**
- Consumes: Task 2 的 `startServer(root, { port, allowEmbed })`。
- Produces: `dot-agents serve [--port <n>] [--repo <path>] [--allow-embed <origins>]`。stdout 首行且仅首行前无输出，格式 `{"app":"dot-agents","url":...,"port":...}`；不 open；SIGINT/SIGTERM 等 close 完成后 exit 0；非 git 仓库 / 端口占用 / 非法端口 → stderr + exit 1，绝不换端口。

- [ ] **Step 1: helper 补真 git fixture**

`tests/helpers/mkrepo.ts` 追加（**现有 `mkRepo` 不建 `.git`，而 `findRepoRoot` 靠 `.git` 认仓库根 —— CLI 测试必须用真 git 仓库**）：

```ts
import { execSync } from 'node:child_process'

/** mkRepo + git init：给需要过 findRepoRoot 的 CLI/e2e 测试用 */
export async function mkGitRepo(layout: Layout): Promise<string> {
  const root = await mkRepo(layout)
  execSync('git init -q', { cwd: root })
  return root
}
```

- [ ] **Step 2: 写失败测试**

新建 `tests/cli/serve.test.ts`（spawn `tsx` 跑真 CLI，验证契约本体而非内部函数）：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer as createNetServer } from 'node:net'
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

describe('默认命令回归', () => {
  // WHY: Commander 接线动过。默认无子命令行为（open + 随机端口）不能被 serve 顺手改坏。
  it('--help 列出 serve 且默认命令仍在', async () => {
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
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run tests/cli/serve.test.ts`
Expected: FAIL —— `serve` 子命令不存在（commander unknown command）。

- [ ] **Step 4: 实现**

`src/cli/index.ts`：顶部加 `import { resolve } from 'node:path'`；默认命令定义之前加：

```ts
function parsePort(v: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`非法端口：${v}（需 1-65535 整数）`)
    process.exit(1)
  }
  return n
}

program
  .command('serve')
  .description('宿主模式：长驻、不开浏览器、端口可指定，供外部工具（门户等）托管')
  .option('--port <n>', '监听端口（缺省随机）', parsePort)
  .option('--repo <path>', '扫描目标仓库（缺省 = 当前目录的 git root）')
  .option('--allow-embed <origins>', '允许 iframe 嵌入的 origin（原样写进 CSP frame-ancestors，可空格分隔多个）')
  .action(async (opts: { port?: number; repo?: string; allowEmbed?: string }) => {
    const base = opts.repo ? resolve(opts.repo) : process.cwd()
    const root = await findRepoRoot(base)
    if (!root) {
      console.error(`不是 git 仓库：${base}`)
      process.exit(1)
    }
    let srv: Awaited<ReturnType<typeof startServer>>
    try {
      srv = await startServer(root, { port: opts.port, allowEmbed: opts.allowEmbed })
    } catch (e) {
      console.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
    // 首行 JSON 是对宿主的启动契约。之后不再往 stdout 写任何东西。
    console.log(JSON.stringify({ app: 'dot-agents', url: srv.url, port: srv.port }))
    const bye = () => {
      void srv.close().finally(() => process.exit(0))
    }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
  })
```

- [ ] **Step 5: 全量测试过**

Run: `npx vitest run`
Expected: 全 PASS（默认命令路径未动，回归用例过）。

- [ ] **Step 6: Commit**

```bash
git add src/cli/index.ts tests/cli/serve.test.ts tests/helpers/mkrepo.ts
git commit -m "feat(cli): serve 宿主子命令（--port/--repo/--allow-embed，首行 JSON 契约，优雅退出）"
```

---

### Task 4: 分发修复（prepare + engines + lock 漂移）

**Files:**
- Modify: `package.json`、`package-lock.json`

**Interfaces:**
- Produces: npm git 依赖可装可用（装完有 dist/、bin 名为 dot-agents）；node 18 可装；lock 与 package 一致。

- [ ] **Step 1: 改 package.json**

```json
  "engines": { "node": ">=18" },
  "scripts": {
    "build": "tsc -p tsconfig.json && vite build",
    "prepare": "npm run build",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts"
  },
```

（`prepare` 是 npm git 依赖安装后的构建钩子——没有它，git 依赖装出来的包 `dist/` 为空，`bin` 指的文件不存在。）

- [ ] **Step 2: 重生 lock（修漂移）**

现存 `package-lock.json` 根条目还是旧 bin 名 `agents` + `engines >=20`，与 package.json 不一致。

Run: `npm install --package-lock-only && grep -n '"node": ">=18"' package-lock.json && grep -cn '"agents"' package-lock.json || true`
Expected: engines 命中 `>=18`；旧 bin 名 `agents` 不再出现在根条目。

- [ ] **Step 3: 构建 + 全量测试**

Run: `npm run build && npx vitest run`
Expected: build 出 `dist/cli/index.js`、`dist/web/index.html`；测试全 PASS。

- [ ] **Step 4: Commit（consumer 验证要装「已提交」的代码，先提交）**

```bash
git add package.json package-lock.json
git commit -m "fix(dist): prepare 构建钩子 + engines 降至 node>=18 + 修 lock 漂移（git 依赖可装可用）"
```

- [ ] **Step 5: 临时 consumer 真装验证（git 依赖端到端）**

```bash
T=$(mktemp -d) && cd "$T" && npm init -y >/dev/null \
  && npm install "git+file:///Users/linemagic/Develop/personal/dot-agents" \
  && ./node_modules/.bin/dot-agents --version && cd - && rm -rf "$T"
```

Expected: 安装期间跑 prepare 构建；`--version` 输出 `0.1.0`。失败则修完 amend 本 task 的 commit。

---

### Task 5: README serve 章节

**Files:**
- Modify: `README.md`

**Interfaces:**
- Produces: 文档与行为一致（现 README 写「不常驻、没有固定端口」，serve 落地后为半谎话）。

- [ ] **Step 1: 在 README 交付形态/用法段落后追加**

```markdown
### 宿主模式（serve）

默认命令是「开一次用一次」：随机端口、自动开浏览器、Ctrl-C 即退，这仍是唯一的交互式用法。
`serve` 是给**外部宿主**（如门户类工具）托管用的显式 opt-in 模式：

    dot-agents serve --port 18852 --repo /path/to/repo --allow-embed "http://localhost:5273"

- 长驻前台、不开浏览器；生命周期归宿主管（SIGINT/SIGTERM 优雅退出）。
- stdout 首行输出一行 JSON `{"app":"dot-agents","url":"...","port":...}`，之后不再写 stdout。
- `--port` 被占直接 exit 1，绝不换端口；`--repo` 缺省取当前目录的 git root。
- `--allow-embed` 的值原样写进 CSP `frame-ancestors`（可空格分隔多个 origin）；缺省不发 CSP 头。
- 安全：只绑 127.0.0.1；Host 头白名单（防 DNS rebinding）；`/api/*` 仍要页面注入的 token；
  免 token 的只有 `GET /healthz`（返回 app/version/repoRoot，给宿主认人）。
```

- [ ] **Step 2: 校对 README 原有「不做常驻进程」表述**

若正文仍有「不常驻 / server 跑完即退」类句子，改为「默认模式跑完即退；serve 为显式托管模式」，与 spec 章程修订一致。

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: README 补 serve 宿主模式（契约/安全边界/与默认模式的关系）"
```
