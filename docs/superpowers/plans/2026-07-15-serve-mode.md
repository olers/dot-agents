# serve 宿主模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `dot-agents serve` 宿主模式（长驻/定端口/不 open），并补 Host 校验、/healthz、CSP 嵌入控制与 npm git 依赖分发修复。

**Architecture:** 全部服务端逻辑进 `startServer`（默认模式与 serve 模式共用同一加固）；CLI 只加一个薄 `serve` 子命令。契约 = CLI flags + HTTP（`/healthz` + 现有 API），宿主零 import。

**Tech Stack:** TypeScript + node:http、commander、vitest。

**Spec:** `docs/superpowers/specs/2026-07-15-serve-mode-design.md`

## Global Constraints

- `engines.node` 目标值 `>=18`（本计划内从 `>=20` 降下来）。
- 默认命令 `dot-agents`（无子命令）行为不得变化：随机端口 + open 浏览器 + Ctrl-C 退出。
- 测试命名沿用现有风格：中文描述 + 顶部 `// WHY:` 注释；helper 用 `tests/helpers/mkrepo.ts` 的 `mkRepo/cleanupRepo`。
- commit 不加任何 Co-Authored-By 尾注。

---

### Task 1: Host 校验 + GET /healthz

**Files:**
- Modify: `src/server/index.ts`
- Test: `tests/server/serve.test.ts`（新建）

**Interfaces:**
- Consumes: 现有 `startServer(repoRoot)`、`mkRepo`。
- Produces: 所有响应先过 Host 白名单（`127.0.0.1:<port>` / `localhost:<port>` / `[::1]:<port>`，其余 403）；新端点 `GET /healthz` 免 token 返回 `{app:'dot-agents', version:<string>, repoRoot:<string>}`。Task 2/3 依赖此文件结构。

- [ ] **Step 1: 写失败测试**

新建 `tests/server/serve.test.ts`。注意：undici 的 `fetch` 不允许伪造 Host 头，坏 Host 用 `node:http` 裸请求。

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { request } from 'node:http'
import { startServer } from '../../src/server/index.js'
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

  it('好 Host -> 放行', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(await rawGet(srv.port, '/healthz', `127.0.0.1:${srv.port}`)).toBe(200)
    expect(await rawGet(srv.port, '/healthz', `localhost:${srv.port}`)).toBe(200)
  })
})

describe('GET /healthz', () => {
  // WHY: 宿主（门户）重启后要判断「端口上是谁、扫的是不是我要的仓库」，
  // 决定复用还是重拉。没有免 token 的身份端点就只能盲杀重启。
  it('免 token，返回 app/version/repoRoot', async () => {
    const { root, srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await fetch(`${srv.url}/healthz`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.app).toBe('dot-agents')
    expect(typeof body.version).toBe('string')
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
): Promise<{ url: string; token: string; port: number; close: () => void }> {
  const token = randomBytes(24).toString('hex')
  // dist/server/ -> 包根。healthz 要报版本，宿主靠它判断兼容性。
  const pkg = JSON.parse(
    await readFile(join(HERE, '../../package.json'), 'utf8'),
  ) as { version: string }
  let boundPort = 0
```

(2) `createServer` 回调开头（`const path = ...` 之前）加 Host 闸：

```ts

  const server = createServer(async (req, res) => {
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

(3) listen 之后给 `boundPort` 赋值（原有代码块改成）：

```ts
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0
  boundPort = port
```

- [ ] **Step 4: 全量测试过**

Run: `npx vitest run`
Expected: 全 PASS（现有 `tests/server/api.test.ts` 用 `srv.url` 发请求，Host 天然合法，不受影响）。

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts tests/server/serve.test.ts
git commit -m "feat(server): Host 白名单 + GET /healthz（防 DNS rebinding，给宿主做身份探测）"
```

---

### Task 2: startServer 选项（--port / --allow-embed 的底层）

**Files:**
- Modify: `src/server/index.ts`
- Test: `tests/server/serve.test.ts`（追加）

**Interfaces:**
- Consumes: Task 1 后的 `startServer`。
- Produces: `startServer(repoRoot, opts?: { port?: number; allowEmbed?: string })`。`opts.port` 占用时 Promise reject（`EADDRINUSE`）；`opts.allowEmbed` 时静态资源响应带 `Content-Security-Policy: frame-ancestors 'self' <origin>`。Task 3 的 CLI 直接透传这两个选项。

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

再追加：

```ts
describe('startServer 选项', () => {
  // WHY: 宿主要在自己的配置里记死端口；端口被占必须炸给宿主看，
  // 静默换端口会让宿主拿着旧 URL 白屏。
  it('指定端口生效；占用则 reject', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const root2 = await mkRepo({ '.claude/skills/bar/SKILL.md': 'y' })
    roots.push(root2)
    await expect(startServer(root2, { port: srv.port })).rejects.toThrow(/EADDRINUSE/)
  })

  // WHY: 长驻后恶意页面可以 iframe 叠透明层骗点 Apply（clickjacking）。
  // 给了 allow-embed 才收紧 frame-ancestors，缺省不发头维持现状。
  it('allowEmbed -> 静态资源带 frame-ancestors；缺省无 CSP 头', async () => {
    const a = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    expect((await fetch(`${a.srv.url}/`)).headers.get('content-security-policy')).toBeNull()

    const b = await boot(
      { '.claude/skills/foo/SKILL.md': 'x' },
      { allowEmbed: 'http://localhost:5273' },
    )
    expect((await fetch(`${b.srv.url}/`)).headers.get('content-security-policy')).toBe(
      "frame-ancestors 'self' http://localhost:5273",
    )
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/serve.test.ts`
Expected: FAIL —— `startServer` 第二参数不存在（类型错/被忽略）、无 CSP 头。

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
): Promise<{ url: string; token: string; port: number; close: () => void }> {
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
git commit -m "feat(server): startServer 支持指定端口与 frame-ancestors 嵌入白名单"
```

---

### Task 3: CLI `serve` 子命令

**Files:**
- Modify: `src/cli/index.ts`
- Test: `tests/cli/serve.test.ts`（新建）

**Interfaces:**
- Consumes: Task 2 的 `startServer(root, { port, allowEmbed })`。
- Produces: `dot-agents serve [--port <n>] [--repo <path>] [--allow-embed <origin>]`。stdout 首行 JSON `{"app":"dot-agents","url":...,"port":...}`；不 open；SIGINT/SIGTERM 优雅退出；非 git 仓库 / 端口占用 → stderr + exit 1。

- [ ] **Step 1: 写失败测试**

新建 `tests/cli/serve.test.ts`（spawn `tsx` 跑真 CLI，验证契约本体而非内部函数）：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
const procs: ChildProcess[] = []
afterEach(async () => {
  procs.splice(0).forEach((p) => p.kill('SIGTERM'))
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

function serveCli(args: string[]): { proc: ChildProcess; firstLine: Promise<string> } {
  const proc = spawn('npx', ['tsx', 'src/cli/index.ts', 'serve', ...args], {
    cwd: process.cwd(),
  })
  procs.push(proc)
  const firstLine = new Promise<string>((resolve, reject) => {
    let buf = ''
    proc.stdout!.on('data', (d: Buffer) => {
      buf += d.toString()
      const nl = buf.indexOf('\n')
      if (nl >= 0) resolve(buf.slice(0, nl))
    })
    proc.on('exit', (code) => reject(new Error(`exited ${code} before output`)))
  })
  return { proc, firstLine }
}

describe('dot-agents serve', () => {
  // WHY: 这行 JSON 就是对宿主的启动契约。格式破坏 = 所有宿主的就绪探测全瞎。
  it('stdout 首行 JSON 契约 + healthz 指向 --repo', async () => {
    const repo = await mkRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    roots.push(repo)
    const { firstLine } = serveCli(['--repo', repo])
    const info = JSON.parse(await firstLine)
    expect(info.app).toBe('dot-agents')
    expect(info.port).toBeGreaterThan(0)
    const health = await (await fetch(`${info.url}/healthz`)).json()
    expect(health.repoRoot).toBe(repo)
  })

  // WHY: 宿主靠 exit code 区分「起没起来」。lego CLI 当年退出码判不出流水线状态，
  // 别再犯。
  it('--repo 指向非 git 目录 -> exit 1', async () => {
    const { proc } = serveCli(['--repo', '/tmp'])
    const code = await new Promise<number | null>((r) => proc.on('exit', r))
    expect(code).toBe(1)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/serve.test.ts`
Expected: FAIL —— `serve` 子命令不存在（commander 报 unknown command，进程退出）。

- [ ] **Step 3: 实现**

`src/cli/index.ts`：顶部加 `import { resolve } from 'node:path'`；默认命令定义之前加：

```ts
program
  .command('serve')
  .description('宿主模式：长驻、不开浏览器、端口可指定，供外部工具（门户等）托管')
  .option('--port <n>', '监听端口（缺省随机）', (v) => parseInt(v, 10))
  .option('--repo <path>', '扫描目标仓库（缺省 = 当前目录的 git root）')
  .option('--allow-embed <origin>', '允许 iframe 嵌入的 origin（写进 CSP frame-ancestors）')
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
    // 首行 JSON 是对宿主的启动契约，人也能读。之后不再往 stdout 写任何东西。
    console.log(JSON.stringify({ app: 'dot-agents', url: srv.url, port: srv.port }))
    const bye = () => {
      srv.close()
      process.exit(0)
    }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
  })
```

- [ ] **Step 4: 全量测试过**

Run: `npx vitest run`
Expected: 全 PASS（默认命令路径未动）。

- [ ] **Step 5: Commit**

```bash
git add src/cli/index.ts tests/cli/serve.test.ts
git commit -m "feat(cli): serve 宿主子命令（--port/--repo/--allow-embed，首行 JSON 契约）"
```

---

### Task 4: 分发修复（prepare + engines）

**Files:**
- Modify: `package.json`

**Interfaces:**
- Produces: npm git 依赖可用（装完有 dist/）；node 18 可装。

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

- [ ] **Step 2: 验证构建与全量测试**

Run: `npm run build && npx vitest run`
Expected: build 出 `dist/cli/index.js`、`dist/web/index.html`；测试全 PASS。

- [ ] **Step 3: 模拟 git 依赖安装**

Run: `npm pack --dry-run 2>&1 | head -20`
Expected: 文件清单含 `dist/`。

- [ ] **Step 4: Commit**

```bash
git add package.json
git commit -m "fix(dist): prepare 构建钩子 + engines 降至 node>=18（git 依赖可装可用）"
```
