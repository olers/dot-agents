import { basename, join, relative } from 'node:path'
import { isExecutable, type Dim, type Op, type Plan, type Result, type State } from '../core/types.js'
import { DIMS, TOOL_DIRS, AGENTS_DIR } from '../core/constants.js'
import { isNoise } from '../core/fsx.js'
import { buildChanges } from '../core/plan.js'

/**
 * `agents link` 专用：只建软链，绝不 move / discard。
 *
 * 这是给 clone 仓库的人跑的「安装」命令 —— 软链不进 git，只有 .agents/ 进 git。
 * 它必须绝对安全：一个新人 clone 下来跑一句 link，结果自己的 .claude/skills 被吞了，
 * 这个工具就没人敢用了。所以只处理 absent，real / drifted 一律不碰。
 */
export function buildLinkPlan(state: State): Plan {
  const ops: Op[] = []
  const dimHasContent = (d: Dim) => state.agentsDir.entries[d].length > 0

  for (const tool of TOOL_DIRS) {
    const t = state.tools[tool]
    if (t?.kind !== 'dir') continue // 整个目录是软链 —— 不碰
    for (const dim of DIMS) {
      const st = t.dims[dim]
      if (!st || !dimHasContent(dim)) continue
      if (st.kind !== 'absent') continue
      ops.push({
        t: 'symlink',
        path: join(state.repoRoot, tool, dim),
        target: relative(join(state.repoRoot, tool), join(state.repoRoot, AGENTS_DIR, dim)),
      })
    }
  }

  return {
    repoRoot: state.repoRoot,
    gitClean: state.gitClean,
    ops,
    changes: buildChanges(state, ops, {}, []),
    conflicts: [],
    resolved: {},
    skipped: [],
    blockedDims: [],
    benefits: ops.length ? [`${ops.length} 个 (工具 × 维度) 接上软链`] : ['软链已齐全，无需变更。'],
    risks: [],
  }
}

const CELL: Record<string, string> = {
  linked: '✅ 已链接',
  absent: '·  —',
  real: '📦 待收录',
  drifted: '⚠️ 指向别处',
  conflict: '🔴 有冲突',
}

/** plan 里的冲突落在哪些格子上 —— 给 renderState 上色用 */
export function conflictCells(plan: Plan): Set<string> {
  const s = new Set<string>()
  for (const b of plan.blockedDims) s.add(`${b.tool}/${b.dim}`)
  return s
}

export function renderState(state: State, cells = new Set<string>()): string {
  const lines: string[] = []
  lines.push(`仓库：${state.repoRoot}`)
  lines.push(
    `.agents/：${state.agentsDir.exists ? '存在' : '不存在'}    git 工作区：${state.gitClean ? '干净' : '不干净'}`,
  )
  lines.push('')

  const tools = Object.keys(state.tools)
  if (tools.length === 0 && state.strangers.length === 0) {
    lines.push('没有发现任何点目录。')
    return lines.join('\n')
  }

  if (tools.length > 0) {
    const w = Math.max(12, ...tools.map((t) => t.length + 3))
    lines.push('工具'.padEnd(w) + DIMS.map((d) => d.padEnd(14)).join(''))
    for (const tool of tools) {
      const t = state.tools[tool]
      // 整个目录是一条软链。四个维度格子全填 '-' 会把它说成「空工具目录」——
      // 它不是空的，它是别人的。
      if (t.kind === 'symlink') {
        lines.push((tool + '/').padEnd(w) + `🔗 整个目录是软链 → ${t.target}（不碰）`)
        continue
      }
      const row = DIMS.map((dim) => {
        const st = t.dims[dim]
        if (!st) return '-'.padEnd(14)
        const kind = cells.has(`${tool}/${dim}`) ? 'conflict' : st.kind
        const n = st.kind === 'real' ? ` ${st.entries.length}` : ''
        return (CELL[kind] + n).padEnd(14)
      })
      lines.push((tool + '/').padEnd(w) + row.join(''))
    }
  }

  const only = tools
    .map((t) => [t, state.tools[t].only] as const)
    .filter(([, v]) => v.length > 0)
  if (only.length > 0) {
    lines.push('')
    lines.push('工具专属 —— 看见了，故意没动：')
    for (const [tool, items] of only) {
      lines.push(`  ${tool}/  ${items.map(showForeign).join('  ')}`)
    }
  }

  if (state.strangers.length > 0) {
    lines.push('')
    lines.push('不认识的点目录 —— 看见了，故意没动：')
    lines.push('  ' + state.strangers.map(showForeign).join('  '))
  }
  return lines.join('\n')
}

/** 软链就把目标一起写出来。只报个名字，用户看不出它指向另一个仓库。 */
function showForeign(f: { name: string; kind: string; target?: string }): string {
  return f.kind === 'symlink' ? `${f.name} → ${f.target}` : f.name
}

export function renderPlan(plan: Plan): string {
  const lines: string[] = []
  const rel = (p: string) => relative(plan.repoRoot, p)

  const executable = plan.changes.filter(isExecutable)
  const blocked = plan.changes.filter((c) => !isExecutable(c))

  if (plan.ops.length === 0 && plan.skipped.length > 0) {
    // 不能说「无需变更」—— 是有活要干，但全被未裁决的冲突挡住了。
    lines.push('本次不会做任何变更 —— 全部卡在下面这些未裁决的冲突上。')
  } else if (plan.ops.length === 0) {
    lines.push('无需变更。')
  } else {
    // 先讲「用户的变更」：几项、每项做什么、为什么。原子操作是实现细节，往后放。
    lines.push(`本次共 ${executable.length} 项变更（${plan.ops.length} 个原子操作）：`)
    for (const c of executable) {
      lines.push(`  ${c.destructive ? '⚠️ ' : '✅ '}${c.title}`)
      lines.push(`      ${c.before}  →  ${c.after}`)
      lines.push(`      ${c.reason}`)
    }
  }

  // 挡住的维度：真实存在、但这次不动。绝不混进变更数里。
  if (blocked.length > 0) {
    lines.push('')
    lines.push('这些这次不动（不计入变更）：')
    for (const c of blocked) lines.push(`  ${c.title}  —— ${c.blockedReason}`)
  }

  // 技术细节：想核对到每一步文件系统动作的人看这里。
  if (plan.ops.length > 0) {
    lines.push('')
    lines.push('技术细节（原子操作）：')
    for (const op of plan.ops) {
      switch (op.t) {
        case 'mkdir':
          lines.push(`  建目录    ${rel(op.path)}/`)
          break
        case 'move':
          lines.push(`  收录      ${rel(op.from)}  →  ${rel(op.to)}`)
          break
        case 'discard':
          // .DS_Store 不是「重复副本」，它是垃圾文件。叫错名字，用户会以为自己有个同名 skill。
          lines.push(
            isNoise(basename(op.path))
              ? `  清垃圾    ${rel(op.path)}  (已备份)`
              : `  丢弃重复  ${rel(op.path)}  (已备份)`,
          )
          break
        case 'rmdir':
          lines.push(`  删空壳    ${rel(op.path)}/`)
          break
        case 'unlink':
          lines.push(`  拆旧链    ${rel(op.path)}`)
          break
        case 'symlink':
          lines.push(`  建软链    ${rel(op.path)}  →  ${op.target}`)
          break
      }
    }
  }

  if (plan.skipped.length > 0) {
    lines.push('')
    lines.push(`需要你裁决的冲突（${plan.skipped.length}）—— 未裁决则整个维度不接软链：`)
    for (const c of plan.skipped) {
      lines.push(`  ${c.key}`)
      for (const cand of c.candidates) {
        lines.push(
          `    ${cand.tool.padEnd(12)} ${cand.hash.slice(0, 8)}  ${cand.files.length} 个文件`,
        )
      }
    }
    lines.push('')
    lines.push('  裁决要在浏览器里做：跑 `dot-agents`（不带子命令）。')
  }

  if (plan.benefits.length > 0) {
    lines.push('')
    lines.push('收益：')
    for (const b of plan.benefits) lines.push(`  + ${b}`)
  }
  if (plan.risks.length > 0) {
    lines.push('')
    lines.push('风险：')
    for (const r of plan.risks) lines.push(`  ! ${r}`)
  }
  return lines.join('\n')
}

export function renderResult(r: Result, meaningful?: number): string {
  if (!r.ok) return `失败：${r.error}`
  if (r.applied.length === 0) return '无需变更。'
  // 成功也先报「几项变更」。原子操作数是技术旁注 —— 用户关心的是他那几件事成了没。
  const head =
    meaningful != null
      ? `完成，收敛了 ${meaningful} 项变更（${r.applied.length} 个原子操作）。`
      : `完成，执行了 ${r.applied.length} 个操作。`
  return [head, '', `备份：  ${r.atticDir}/backup/`, `撤销：  sh ${r.undoScript}`].join('\n')
}
