import { join, resolve, dirname } from 'node:path'
import type { Dim, Entry, EntryState, Foreign, Residue, State, ToolState } from './types.js'
import { TOOL_DIRS, DIMS, AGENTS_DIR, NOT_A_TOOL } from './constants.js'
import { pathKind, readLinkTarget, listChildren, isNoise } from './fsx.js'
import { hashPath, listFiles } from './hash.js'
import { gitIsClean, gitCheckIgnored } from './git.js'

export async function findRepoRoot(cwd: string): Promise<string | null> {
  let cur = resolve(cwd)
  for (;;) {
    if ((await pathKind(join(cur, '.git'))) !== 'missing') return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

/**
 * 读一个维度目录的全部直接子项，每一个都要有归属：要么是条目，要么是残留物。
 *
 * 绝不 `continue` 掉任何东西。跳过一个名字，它就从 plan 的视野里消失了，
 * 而 rmdir 仍然会在真实文件系统上撞见它 —— ENOTEMPTY。
 */
async function readDim(dir: string): Promise<{ entries: Entry[]; residue: Residue[] }> {
  const entries: Entry[] = []
  const residue: Residue[] = []

  for (const name of await listChildren(dir)) {
    const p = join(dir, name)
    const kind = await pathKind(p)

    if (kind === 'missing') continue // 读目录和 lstat 之间被删了。它已经不在了，不用管。

    if (isNoise(name)) {
      residue.push({ name, path: p, kind: 'noise' })
      continue
    }
    if (kind === 'symlink') {
      // 条目级软链不在 MVP 的管理范围 —— 但「不管理」不等于「不存在」。
      residue.push({ name, path: p, kind: 'symlink' })
      continue
    }

    entries.push({
      name,
      path: p,
      isDir: kind === 'dir',
      hash: await hashPath(p),
      files: await listFiles(p),
    })
  }

  return { entries, residue }
}

async function scanDim(repoRoot: string, tool: string, dim: Dim): Promise<EntryState> {
  const dimPath = join(repoRoot, tool, dim)
  const kind = await pathKind(dimPath)

  if (kind === 'missing') return { kind: 'absent' }

  if (kind === 'symlink') {
    const target = await readLinkTarget(dimPath)
    const want = join(repoRoot, AGENTS_DIR, dim)
    return target === want ? { kind: 'linked' } : { kind: 'drifted', actualTarget: target }
  }

  if (kind === 'file') {
    // 维度位置上是个文件（不该发生）。当 absent 处理，并让 toolOnly 收走它。
    return { kind: 'absent' }
  }

  return { kind: 'real', ...(await readDim(dimPath)) }
}

/** 工具目录下、不属于任何受管维度的直接子项。软链要连目标一起读出来 —— 只报个名字等于没说。 */
async function readForeign(dir: string): Promise<Foreign[]> {
  const out: Foreign[] = []
  for (const name of await listChildren(dir)) {
    if ((DIMS as string[]).includes(name) || isNoise(name)) continue
    const p = join(dir, name)
    const kind = await pathKind(p)
    if (kind === 'missing') continue
    out.push(kind === 'symlink' ? { name, kind, target: await readLinkTarget(p) } : { name, kind })
  }
  return out
}

/**
 * 枚举仓库根下的**每一个**点目录，不是只查白名单里那几个名字。
 *
 * 白名单只回答「哪个要收敛」，回答不了「这个仓库现在长什么样」。
 * 拿白名单当枚举器，.codex / .superpowers 这种没进白名单的目录就整个消失了 ——
 * 而它们在磁盘上明明躺着。列出来（哪怕只是标一句「不管」）和沉默地跳过，是两回事。
 */
export async function scan(repoRoot: string): Promise<State> {
  const emptyDims = () =>
    Object.fromEntries(DIMS.map((d) => [d, [] as Entry[]])) as Record<Dim, Entry[]>

  const agentsPath = join(repoRoot, AGENTS_DIR)
  const agentsExists = (await pathKind(agentsPath)) === 'dir'
  const agentsEntries = emptyDims()
  // 唯一源里也有我们不管的东西（docs/、plans/、.attic/）。它们执行后原样还在 ——
  // 「执行后」那一列不列出来，就是在承诺一个不会发生的干净结果。
  let agentsOnly: Foreign[] = []
  if (agentsExists) {
    for (const dim of DIMS) {
      agentsEntries[dim] = (await readDim(join(agentsPath, dim))).entries
    }
    agentsOnly = await readForeign(agentsPath)
  }

  const known = new Set<string>(TOOL_DIRS)
  const tools: State['tools'] = {}
  const strangers: State['strangers'] = []

  for (const name of await listChildren(repoRoot)) {
    if (!name.startsWith('.') || NOT_A_TOOL.has(name)) continue

    const p = join(repoRoot, name)
    const kind = await pathKind(p)
    if (kind !== 'dir' && kind !== 'symlink') continue // 点文件（.gitignore 之类）不是我们的事

    const target = kind === 'symlink' ? await readLinkTarget(p) : undefined

    if (!known.has(name)) {
      strangers.push(kind === 'symlink' ? { name, kind, target } : { name, kind })
      continue
    }

    // 整个工具目录本身是一条软链 —— 用户自己接的（worktree 里很常见）。
    // 往里写 = 写到软链另一头那个仓库去了。所以只显示，一个 op 都不发给它。
    if (kind === 'symlink') {
      tools[name] = { kind, target, dims: {}, only: [] }
      continue
    }

    const dims: Partial<Record<Dim, EntryState>> = {}
    for (const dim of DIMS) {
      dims[dim] = await scanDim(repoRoot, name, dim)
    }
    tools[name] = { kind: 'dir', dims, only: await readForeign(p) }
  }

  return {
    repoRoot,
    gitClean: await gitIsClean(repoRoot),
    gitIgnored: await gitCheckIgnored(repoRoot, Object.keys(tools)),
    agentsDir: { exists: agentsExists, entries: agentsEntries, only: agentsOnly },
    tools,
    strangers,
  }
}
