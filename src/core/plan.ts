import { join, relative } from 'node:path'
import type {
  BlockedDim,
  Conflict,
  ConflictCandidate,
  Dim,
  Op,
  Plan,
  Resolutions,
  State,
} from './types.js'
import { DIMS, TOOL_DIRS, AGENTS_DIR } from './constants.js'

const RANK: Record<Op['t'], number> = {
  mkdir: 0,
  discard: 1,
  move: 1,
  rmdir: 2,
  unlink: 2,
  symlink: 3,
}

interface Candidate {
  hash: string
  path: string
  files: string[]
}

/** 一个 (dim, name) 下所有来源的候选。'.agents' 也算一个来源。 */
interface Group {
  dim: Dim
  name: string
  key: string
  byTool: Map<string, Candidate>
}

/**
 * 按 (dim, name) 归组，把 .agents 和所有工具的同名条目收在一起。
 *
 * 不能逐个工具增量处理：那样 .claude/skills/foo 会先被 move 进空的 .agents，
 * .codebuddy/skills/foo 再来比时，比的是「刚被移进去的自己人」而不是原本的 .agents ——
 * 冲突的归属和候选列表会依赖工具遍历顺序，同一份数据算两次结果不同。
 */
function collectGroups(state: State): Map<string, Group> {
  const groups = new Map<string, Group>()

  const put = (dim: Dim, name: string, tool: string, c: Candidate) => {
    const key = `${dim}/${name}`
    let g = groups.get(key)
    if (!g) {
      g = { dim, name, key, byTool: new Map() }
      groups.set(key, g)
    }
    g.byTool.set(tool, c)
  }

  for (const dim of DIMS) {
    for (const e of state.agentsDir.entries[dim]) {
      put(dim, e.name, AGENTS_DIR, { hash: e.hash, path: e.path, files: e.files })
    }
  }
  for (const tool of TOOL_DIRS) {
    // kind === 'symlink'：整个工具目录是用户自己接的一条软链。
    // 把它的条目收进来，就会 move 掉软链另一头那个仓库里的文件。
    const t = state.tools[tool]
    if (t?.kind !== 'dir') continue
    for (const dim of DIMS) {
      const st = t.dims[dim]
      if (st?.kind !== 'real') continue
      for (const e of st.entries) {
        put(dim, e.name, tool, { hash: e.hash, path: e.path, files: e.files })
      }
    }
  }
  return groups
}

/** 白名单顺序即优先级：同哈希去重时排前面的当源。'.agents' 永远最优先。 */
function sourcePriority(tool: string): number {
  if (tool === AGENTS_DIR) return -1
  const i = (TOOL_DIRS as readonly string[]).indexOf(tool)
  return i < 0 ? 999 : i
}

export function buildPlan(state: State, resolutions: Resolutions): Plan {
  const { repoRoot } = state
  const ops: Op[] = []
  const conflicts: Conflict[] = []
  const skipped: Conflict[] = []
  const resolved: Record<string, string> = {}
  const blockedDims: BlockedDim[] = []

  const groups = collectGroups(state)

  /** 该维度最终会不会有内容 —— 决定要不要 mkdir + 建链 */
  const dimWillExist = new Set<Dim>()
  /** `${tool}/${dim}` -> 被未裁决的冲突 block 住 */
  const blocked = new Set<string>()
  let dedupCount = 0

  // ── 第 1 趟：按 (dim, name) 归组，决定收录 / 丢弃 / 冲突 ──
  for (const g of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const tools = [...g.byTool.entries()].sort(
      (a, b) => sourcePriority(a[0]) - sourcePriority(b[0]),
    )
    const hashes = new Set(tools.map(([, v]) => v.hash))

    if (hashes.size === 1) {
      // 无冲突。优先级最高的当源，其余全部 discard。
      dimWillExist.add(g.dim)
      const [srcTool, src] = tools[0]
      if (srcTool !== AGENTS_DIR) {
        ops.push({ t: 'move', from: src.path, to: join(repoRoot, AGENTS_DIR, g.dim, g.name) })
      }
      for (const [, v] of tools.slice(1)) {
        ops.push({ t: 'discard', path: v.path })
        dedupCount++
      }
      continue
    }

    // 冲突
    const candidates: ConflictCandidate[] = tools.map(([tool, v]) => ({
      tool,
      hash: v.hash,
      path: v.path,
      files: v.files,
    }))
    const conflict: Conflict = { key: g.key, dim: g.dim, name: g.name, candidates }
    conflicts.push(conflict)

    const winner = resolutions[g.key]
    if (!winner || !g.byTool.has(winner)) {
      // 未裁决 -> 一个都不动，且把所有持有该条目的 (tool, dim) 全部 block
      skipped.push(conflict)
      for (const [tool] of tools) {
        if (tool === AGENTS_DIR) continue
        blocked.add(`${tool}/${g.dim}`)
      }
      // .agents 里已有的那份仍然在 -> 维度是存在的
      if (g.byTool.has(AGENTS_DIR)) dimWillExist.add(g.dim)
      continue
    }

    // 已裁决
    resolved[g.key] = winner
    dimWillExist.add(g.dim)

    if (winner !== AGENTS_DIR && g.byTool.has(AGENTS_DIR)) {
      // .agents 里那份要被换掉 -> 先 discard（备份后删），腾出位置再 move 赢家进来
      ops.push({ t: 'discard', path: g.byTool.get(AGENTS_DIR)!.path })
    }
    if (winner !== AGENTS_DIR) {
      ops.push({
        t: 'move',
        from: g.byTool.get(winner)!.path,
        to: join(repoRoot, AGENTS_DIR, g.dim, g.name),
      })
    }
    for (const [tool, v] of tools) {
      if (tool === winner || tool === AGENTS_DIR) continue
      ops.push({ t: 'discard', path: v.path })
    }
  }

  // ── 第 2 趟：每个 (tool, dim) 决定软链 ──
  let linkCount = 0
  for (const tool of TOOL_DIRS) {
    const t = state.tools[tool]
    if (t?.kind !== 'dir') continue // 整个目录是软链 —— 不碰
    for (const dim of DIMS) {
      const st = t.dims[dim]
      if (!st || st.kind === 'linked') continue

      if (blocked.has(`${tool}/${dim}`)) {
        blockedDims.push({
          tool,
          dim,
          short: '有未裁决的冲突',
          reason:
            '该维度下有未裁决的冲突条目。软链是目录级的 —— 只要还有一个条目留在原地，整个目录就不能被替换成软链。',
        })
        continue
      }

      // 我们不管理、也不该碰的东西（条目级软链）。
      // 软链是目录级的：把这个目录换成软链，会把它们一起删掉。
      // 所以有它们在，这个维度就不能收敛 —— 说清楚，别偷偷删。
      const keep = st.kind === 'real' ? st.residue.filter((r) => r.kind !== 'noise') : []
      if (keep.length > 0) {
        const names = keep.map((r) => r.name).join('、')
        blockedDims.push({
          tool,
          dim,
          short: `有 dot-agents 不管理的条目（${names}）`,
          reason: `${tool}/${dim} 下有 dot-agents 不管理的条目（${names}）。软链是目录级的 —— 把这个目录换成软链会把它们一并删掉，所以这次不动它。`,
        })
        continue
      }

      if (!dimWillExist.has(dim)) continue // .agents 该维度是空的，没什么可链

      const dimPath = join(repoRoot, tool, dim)

      if (st.kind === 'drifted') {
        ops.push({ t: 'unlink', path: dimPath })
      } else if (st.kind === 'real') {
        // rmdir 是非递归的：这里必须保证目录真的空了。
        // 条目会被上面那趟 move/discard 搬空，但噪声文件（.DS_Store）不是条目 ——
        // 它不会被任何 op 碰到，却实实在在占着位置。不清掉它，apply 就会炸 ENOTEMPTY。
        //
        // 只在这里清：走到这一步才说明这个目录真的会被 rmdir。
        // 一个不打算收敛的目录，没有任何理由去动它的 .DS_Store。
        for (const r of st.residue) {
          if (r.kind === 'noise') ops.push({ t: 'discard', path: r.path })
        }
        ops.push({ t: 'rmdir', path: dimPath })
      }
      ops.push({
        t: 'symlink',
        path: dimPath,
        target: relative(join(repoRoot, tool), join(repoRoot, AGENTS_DIR, dim)),
      })
      linkCount++
    }
  }

  // mkdir 只发给「真的要往里 move 东西」的维度。
  // 不能用 dimWillExist —— 它包含「本来就有内容、什么都不用动」的维度，
  // 那样已经统一好的仓库每跑一次都会冒出一个无用的 mkdir op，plan 就不幂等了。
  const dimsNeedingMkdir = new Set<Dim>()
  for (const op of ops) {
    if (op.t !== 'move') continue
    for (const dim of DIMS) {
      if (op.to.startsWith(join(repoRoot, AGENTS_DIR, dim) + '/')) dimsNeedingMkdir.add(dim)
    }
  }
  for (const dim of dimsNeedingMkdir) {
    ops.unshift({ t: 'mkdir', path: join(repoRoot, AGENTS_DIR, dim) })
  }

  // 只按 RANK 排；同 rank 保持 push 顺序（Array.prototype.sort 是稳定的），
  // 这样「先 discard .agents 那份，再 move 赢家进来」的相对顺序不会被打乱。
  ops.sort((a, b) => RANK[a.t] - RANK[b.t])

  // ── 风险 & 收益 ──
  const risks: string[] = []
  if (!state.gitClean) {
    risks.push(
      'git 工作区不干净（或这里不是 git 仓库）。出事时 git 帮不上忙 —— 只能靠 .agents/.attic/ 的备份回滚。',
    )
  }
  for (const t of state.gitIgnored) {
    risks.push(
      `${t}/ 被 gitignore。git 根本没跟踪它，git checkout 救不回来 —— .agents/.attic/ 是唯一的后悔药。`,
    )
  }
  if (skipped.length > 0) {
    const names = [...new Set(blockedDims.map((b) => `${b.tool}/${b.dim}`))]
    risks.push(
      `${skipped.length} 个冲突未裁决 → 这些目录不会接上软链，保持原样：${names.join('、')}`,
    )
  }
  if (ops.some((o) => o.t === 'discard')) {
    risks.push(
      'discard 会删除重复/落败的副本。删除前全部备份进 .agents/.attic/<时间戳>/，并生成 undo.sh。',
    )
  }

  const benefits: string[] = []
  const moveCount = ops.filter((o) => o.t === 'move').length
  if (moveCount > 0) benefits.push(`${moveCount} 个条目收进 .agents/ 唯一源`)
  if (dedupCount > 0) {
    benefits.push(`${dedupCount} 份内容完全相同的重复副本被消除（改一处，所有工具同时生效）`)
  }
  if (linkCount > 0) benefits.push(`${linkCount} 个 (工具 × 维度) 接上软链`)
  // ops 为空有两种截然不同的含义，不能混为一谈：
  // (1) 真的已经统一了 —— 没有冲突
  // (2) 所有变更都被未裁决的冲突挡住了 —— 说「已经是统一状态」是在撒谎，
  //     用户会以为一切正常，实际上什么都没干成。
  if (ops.length === 0 && skipped.length === 0) {
    benefits.push('已经是统一状态，无需变更。')
  }

  return {
    repoRoot,
    gitClean: state.gitClean,
    ops,
    conflicts,
    resolved,
    skipped,
    blockedDims,
    benefits,
    risks,
  }
}
