import { open, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import type { PeekResult } from './types.js'
import { AGENTS_DIR, DIMS, TOOL_DIRS } from './constants.js'
import { realpath } from './fsx.js'

/** 单次读取上限。侧栏是拿来看 skill 的，不是拿来看 dump 的。 */
export const MAX_PEEK = 256 * 1024

/**
 * 允许被读的路径前缀。
 *
 * 白名单和 scan 的视野严格一致：**图上看得见的才读得到，图上没有的一律 403。**
 * 不能退化成「只要在 root 之下就行」—— 那等于顺手在 localhost 上开了个读
 * .env / .git/config 的口子。.claude/settings.json 也读不到：它在点目录下，
 * 但不在任何维度下，图上本来也只是「工具专属，不碰」的一行。
 */
async function allowedPrefixes(roots: string[]): Promise<string[]> {
  const dirs = [AGENTS_DIR, ...TOOL_DIRS]
  const out: string[] = []

  for (const root of roots) {
    // root 自己也要 realpath。生产环境的 repoRoot 来自 findRepoRoot()，它只 resolve
    // 不 realpath；仓库路径上只要有一段软链（macOS 的 /tmp -> /private/tmp 就是），
    // realpath(请求路径) 和这里拼出的前缀就会对不上，合法请求被误判成 403。
    const real = await realpath(root).catch(() => null)
    if (!real) continue

    for (const d of dirs) {
      for (const dim of DIMS) {
        // 前缀必须以分隔符结尾。否则 <root>/.claude/skillsEVIL/x.md
        // 会命中 <root>/.claude/skills 这个前缀，白名单就漏了。
        out.push(join(real, d, dim) + sep)
      }
    }
  }
  return out
}

/**
 * 读一个条目里的文件。这是整个 server 上唯一的读文件出口 ——
 * 所有边界都在这里，别在调用方再加一层「应该没问题吧」。
 */
export async function peekFile(roots: string[], requested: string): Promise<PeekResult> {
  if (!requested || !isAbsolute(requested)) return { ok: false, code: 403 }

  // 先解析到底，之后所有判断都基于软链解析后的真实路径。
  // 先比前缀再 realpath 的话，一条指向仓库外的软链就能穿过去。
  const real = await realpath(normalize(requested)).catch(() => null)
  if (!real) return { ok: false, code: 404 }

  const prefixes = await allowedPrefixes(roots)
  if (!prefixes.some((p) => real.startsWith(p))) return { ok: false, code: 403 }

  // realpath 检查和这里的读取之间有个时间窗口，文件可能被并发删除/替换。
  // 这个函数是唯一的读口，边界必须都收在这一层：race 也要落回 PeekResult，
  // 不能让 promise reject 出去，逼调用方再补一层「万一炸了怎么办」。
  try {
    const st = await stat(real)
    if (!st.isFile()) return { ok: false, code: 403 } // 目录不给读

    // MAX_PEEK 存在的意义是挡资源耗尽，不是挡「返回的字节数」——
    // 先 readFile 整个文件再截断，等于白名单形同虚设：塞一个几 GB 的文件进受控
    // 目录，服务器照样把它整个读进内存。必须在读的层面就卡住实际读取的字节数。
    const truncated = st.size > MAX_PEEK
    const fh = await open(real, 'r')
    try {
      const buf = Buffer.alloc(Math.min(st.size, MAX_PEEK))
      await fh.read(buf, 0, buf.length, 0)
      const binary = buf.includes(0)

      return {
        ok: true,
        peek: {
          path: real,
          // 二进制原样 toString 会喷出一屏替换字符。明说「是二进制」比装作能显示要诚实。
          content: binary ? '' : buf.toString('utf8'),
          size: st.size,
          truncated,
          binary,
        },
      }
    } finally {
      await fh.close()
    }
  } catch {
    return { ok: false, code: 404 }
  }
}
