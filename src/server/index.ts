import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'
import { homedir } from 'node:os'
import type { Resolutions } from '../core/types.js'
import { scan } from '../core/scan.js'
import { buildPlan } from '../core/plan.js'
import { applyPlan } from '../core/apply.js'
import { pathKind } from '../core/fsx.js'
import { peekFile } from '../core/peek.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(HERE, '../web') // tsc 输出 dist/server/，vite 输出 dist/web/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(body))
}

export interface StartServerOptions {
  port?: number
  allowEmbed?: string
}

export async function startServer(
  repoRoot: string,
  opts: StartServerOptions = {},
): Promise<{ url: string; token: string; port: number; close: () => Promise<void> }> {
  const token = randomBytes(24).toString('hex')
  // dist/server/ -> 包根。healthz 要报版本，宿主靠它判断兼容性。
  const pkg = JSON.parse(
    await readFile(join(HERE, '../../package.json'), 'utf8'),
  ) as { version: string }
  let boundPort = 0

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

    // ── API：一律要 token ──
    if (path.startsWith('/api/')) {
      if (req.headers['x-agents-token'] !== token) {
        json(res, 401, { error: 'bad token' })
        return
      }

      try {
        if (path === '/api/state' && req.method === 'GET') {
          const repo = await scan(repoRoot)
          // 全局只是只读的附属展示。家目录下什么牛鬼蛇神都可能有（权限拒绝、奇怪的设备文件）。
          // 它挂了绝不能拖垮主视图 —— 否则用户连「本仓库」都打不开，还不知道为什么。
          const global = await scan(homedir()).catch(() => null)
          json(res, 200, {
            repo,
            global,
            globalError: global ? null : '全局目录扫描失败（不影响本仓库操作）',
          })
          return
        }

        if (path === '/api/plan' && req.method === 'POST') {
          const body = await readBody(req)
          const resolutions = (body.resolutions ?? {}) as Resolutions
          json(res, 200, buildPlan(await scan(repoRoot), resolutions))
          return
        }

        if (path === '/api/apply' && req.method === 'POST') {
          const body = await readBody(req)
          // 只取 resolutions 和 force。body.plan / body.ops 一律无视 ——
          // Plan.ops 里全是 move / discard / rmdir，照着前端给的 ops 执行，
          // 等于把一个任意文件删除接口开在 localhost 上。
          // 后端必须自己重新 scan + plan，执行自己算出来的 ops。
          const resolutions = (body.resolutions ?? {}) as Resolutions
          const force = body.force === true

          const plan = buildPlan(await scan(repoRoot), resolutions)
          json(res, 200, await applyPlan(plan, { force }))
          return
        }

        if (path === '/api/file' && req.method === 'GET') {
          // 只读、只 GET。所有路径校验都在 peekFile 里 —— server 只做 HTTP 翻译，
          // 一个字节的「应该没问题吧」都不在这里加。
          const want = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('path') ?? ''
          const r = await peekFile([repoRoot, homedir()], want)
          if (!r.ok) {
            json(res, r.code, { error: r.code === 404 ? 'not found' : 'forbidden' })
            return
          }
          json(res, 200, r.peek)
          return
        }
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        return
      }

      json(res, 404, { error: 'not found' })
      return
    }

    // ── 静态资源 ──
    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').slice(1)
    const file = join(WEB_ROOT, rel)
    if (!file.startsWith(WEB_ROOT) || (await pathKind(file)) !== 'file') {
      res.writeHead(404)
      res.end('not found')
      return
    }

    let content = await readFile(file)
    if (rel === 'index.html') {
      // token 注入：前端拿不到别的渠道
      content = Buffer.from(
        content
          .toString('utf8')
          .replace(
            '</head>',
            `<script>window.__AGENTS_TOKEN__=${JSON.stringify(token)}</script></head>`,
          ),
      )
    }
    const headers: Record<string, string> = {
      'content-type': MIME[extname(file)] ?? 'application/octet-stream',
    }
    if (opts.allowEmbed) {
      headers['content-security-policy'] = `frame-ancestors 'self' ${opts.allowEmbed}`
    }
    res.writeHead(200, headers)
    res.end(content)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(opts.port ?? 0, '127.0.0.1', () => resolve())
  })
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
}
