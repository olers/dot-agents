import {
  mkdir,
  rename,
  rmdir,
  symlink,
  unlink,
  writeFile,
  chmod,
  readlink,
  readFile,
} from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import type { Op, Plan, Result } from './types.js'
import { ATTIC_DIR } from './constants.js'
import { copyTree, removeTree, pathKind } from './fsx.js'

/** 回滚一步 op 需要的信息。 */
interface Undo {
  op: Op
  /** unlink 之前那条软链原本指向哪（原样保存，不解析） */
  prevLinkTarget?: string
}

function tsDir(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 会被销毁的路径 -> 必须先备份 */
function destructivePaths(ops: Op[]): string[] {
  const out: string[] = []
  for (const op of ops) {
    if (op.t === 'move') out.push(op.from)
    else if (op.t === 'discard') out.push(op.path)
  }
  return out
}

async function execOp(op: Op): Promise<Undo> {
  switch (op.t) {
    case 'mkdir':
      await mkdir(op.path, { recursive: true })
      return { op }
    case 'move':
      await mkdir(dirname(op.to), { recursive: true })
      await rename(op.from, op.to)
      return { op }
    case 'discard':
      await removeTree(op.path)
      return { op }
    case 'rmdir':
      // 非递归。此时目录应该已被 move/discard 清空；如果没空，说明 plan 算错了 —— 让它响亮地失败。
      await rmdir(op.path)
      return { op }
    case 'unlink': {
      const prev = await readlink(op.path)
      await unlink(op.path)
      return { op, prevLinkTarget: prev }
    }
    case 'symlink':
      await symlink(op.target, op.path)
      return { op }
  }
}

/** 反向执行一步。backupRoot 用来还原被 move / discard 掉的内容。 */
async function undoOp(u: Undo, repoRoot: string, backupRoot: string): Promise<void> {
  const op = u.op
  const restore = async (p: string) => {
    const src = join(backupRoot, relative(repoRoot, p))
    if ((await pathKind(src)) === 'missing') return
    await mkdir(dirname(p), { recursive: true })
    await copyTree(src, p)
  }

  switch (op.t) {
    case 'mkdir':
      await rmdir(op.path).catch(() => {}) // 非空就留着 —— 说明本来就有别的东西
      return
    case 'move':
      await removeTree(op.to)
      await restore(op.from)
      return
    case 'discard':
      await restore(op.path)
      return
    case 'rmdir':
      await mkdir(op.path, { recursive: true })
      return
    case 'unlink':
      if (u.prevLinkTarget) await symlink(u.prevLinkTarget, op.path)
      return
    case 'symlink':
      await unlink(op.path).catch(() => {})
      return
  }
}

function renderUndoScript(plan: Plan, atticDir: string, ops: Op[]): string {
  const R = plan.repoRoot
  const rel = (p: string) => relative(R, p)
  const backupRel = join(rel(atticDir), 'backup')

  const lines: string[] = [
    '#!/bin/sh',
    '# dot-agents undo —— 把这次 apply 全部撤销。',
    '# 先删掉本次创建的东西，再从 backup/ 还原原始内容。',
    'set -e',
    `cd "${R}"`,
    '',
    'echo "撤销 dot-agents 变更…"',
    '',
  ]

  // 1. 删掉本次创建的软链
  for (const op of ops) {
    if (op.t === 'symlink') lines.push(`rm -f "${rel(op.path)}"`)
  }
  // 2. 删掉本次移进 .agents 的条目（只删这次移进去的，不碰 .agents 里原有的别的东西）
  for (const op of ops) {
    if (op.t === 'move') lines.push(`rm -rf "${rel(op.to)}"`)
  }
  // 3. 从备份还原（被 move 走的源、被 discard 掉的）
  lines.push('')
  for (const p of destructivePaths(ops)) {
    const r = rel(p)
    lines.push(`rm -rf "${r}"`)
    lines.push(`mkdir -p "$(dirname "${r}")"`)
    lines.push(`cp -R "${backupRel}/${r}" "${r}"`)
  }
  // 4. 被 unlink 的旧软链：指向别处，还原它没有意义（那本来就是 drifted 的错误状态）
  for (const op of ops) {
    if (op.t === 'unlink') {
      lines.push(`# 原本是一条指向别处的软链（drifted），未自动还原：${rel(op.path)}`)
    }
  }
  // 5. 清掉本次 mkdir 出来的空目录（非空则保留）
  lines.push('')
  for (const op of [...ops].reverse()) {
    if (op.t === 'mkdir') lines.push(`rmdir "${rel(op.path)}" 2>/dev/null || true`)
  }
  lines.push('')
  lines.push('echo "已撤销。"')
  lines.push('')
  return lines.join('\n')
}

/**
 * 确保目标仓库的 .gitignore 忽略掉 attic。
 *
 * 不做这件事的话，用户会把备份提交进 git —— 里面是「被删掉的重复副本」，
 * 体积可能很大，而且是纯粹的噪音。attic 是本地的后悔药，不是仓库内容。
 *
 * 幂等；已经有这条就不动。故意放在 ops 之外：它是纯追加的、无害的，
 * 而且回滚后 attic 仍然存在（备份不删），所以这条 ignore 依然是对的。
 */
async function ensureAtticIgnored(repoRoot: string): Promise<void> {
  const LINE = '.agents/.attic/'
  const f = join(repoRoot, '.gitignore')
  let cur = ''
  if ((await pathKind(f)) === 'file') {
    cur = await readFile(f, 'utf8')
    if (cur.split('\n').some((l) => l.trim() === LINE)) return
  }
  const sep = cur === '' || cur.endsWith('\n') ? '' : '\n'
  await writeFile(f, `${cur}${sep}${LINE}\n`, 'utf8')
}

export async function applyPlan(plan: Plan, opts: { force?: boolean } = {}): Promise<Result> {
  const atticDir = join(plan.repoRoot, ATTIC_DIR, tsDir())
  const backupRoot = join(atticDir, 'backup')
  const undoScript = join(atticDir, 'undo.sh')

  // 1. 前置检查 —— 失败时一个文件都不能动
  if (!opts.force && !plan.gitClean) {
    return {
      ok: false,
      atticDir,
      undoScript,
      applied: [],
      error: 'git 工作区不干净（或这里不是 git 仓库）。先提交或 stash 再重试；确实要继续就加 --force。',
    }
  }

  if (plan.ops.length === 0) {
    return { ok: true, atticDir, undoScript, applied: [] }
  }

  // 2. 备份 —— 不可关闭，--force 也不能跳过
  await ensureAtticIgnored(plan.repoRoot)
  await mkdir(backupRoot, { recursive: true })
  for (const p of destructivePaths(plan.ops)) {
    const dst = join(backupRoot, relative(plan.repoRoot, p))
    await mkdir(dirname(dst), { recursive: true })
    await copyTree(p, dst)
  }

  // 3. 写 undo 脚本（在执行之前写：万一进程被 kill，脚本已经在磁盘上了）
  await writeFile(undoScript, renderUndoScript(plan, atticDir, plan.ops), 'utf8')
  await chmod(undoScript, 0o755)

  // 4. 执行，逐步记 journal
  const journal: Undo[] = []
  try {
    for (const op of plan.ops) {
      journal.push(await execOp(op))
    }
  } catch (e) {
    // 5. 失败 -> 反向回滚。不留半成品。
    for (const u of journal.reverse()) {
      await undoOp(u, plan.repoRoot, backupRoot).catch(() => {})
    }
    return {
      ok: false,
      atticDir,
      undoScript,
      applied: [],
      error: `执行失败，已全部回滚：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  return { ok: true, atticDir, undoScript, applied: plan.ops }
}
