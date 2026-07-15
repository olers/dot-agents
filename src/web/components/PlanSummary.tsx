import { isExecutable, type Change, type Op } from '../../core/types.js'

/**
 * 计划回执：把「用户的变更」讲清楚，原子操作退成可展开的技术细节。
 *
 * 主视图的大数字（接线柱那枚铆钉）已经报了「N 项变更」；这里不再堆第二个大数字，
 * 只给一句结果陈述 + 每项变更一张卡。见交接文档「信息层级」。
 */

/** 原子操作的人话。路径相对仓库根，target 本就是相对路径。 */
function describeOp(op: Op, rel: (p: string) => string): string {
  switch (op.t) {
    case 'mkdir':
      return `建目录 ${rel(op.path)}/`
    case 'move':
      return `收录 ${rel(op.from)} → ${rel(op.to)}`
    case 'discard':
      return `删除（已备份） ${rel(op.path)}`
    case 'rmdir':
      return `删空壳 ${rel(op.path)}/`
    case 'unlink':
      return `拆旧链 ${rel(op.path)}`
    case 'symlink':
      return `建软链 ${rel(op.path)} → ${op.target}`
  }
}

/** 安全状态徽标。破坏性（移动/删除内容）永远显式标出，不藏在 hover 里。 */
function safety(c: Change): { cls: string; text: string } {
  if (c.kind === 'blocked') return { cls: 'blocked', text: '暂不执行' }
  return c.destructive
    ? { cls: 'warn', text: '移动/删除内容 · 已备份' }
    : { cls: 'safe', text: '不删除内容' }
}

/** Apply 按钮文案 —— 用语义变更数，不是原子操作数。 */
export function ctaLabel(count: number): string {
  return count > 0 ? `收敛 ${count} 项变更` : '无需变更'
}

/** 一句话结果陈述。数「可执行变更」，被冲突挡住的单独说、绝不混进去。 */
export function planOutcome(changes: Change[]): string {
  const exec = changes.filter(isExecutable)
  const blocked = changes.filter((c) => !isExecutable(c))
  if (exec.length === 0 && blocked.length === 0) return '已经是统一状态，无需变更。'

  const parts: string[] = []
  if (exec.length === 0) {
    parts.push('本次没有可执行的变更')
  } else {
    const destr = exec.filter((c) => c.destructive).length
    parts.push(`把 ${exec.length} 个工具维度接到唯一源`)
    parts.push(destr === 0 ? '没有内容被删除' : `其中 ${destr} 项会移动或删除内容（均已备份）`)
  }
  if (blocked.length > 0) parts.push(`另有 ${blocked.length} 项因未裁决冲突暂不执行`)
  return parts.join('；') + '。'
}

function ChangeCard({ change, rel }: { change: Change; rel: (p: string) => string }) {
  const s = safety(change)
  return (
    <div className={`chg ${change.destructive ? 'chg-warn' : ''}`}>
      <div className="chg-h">
        <span className="chg-title">{change.title}</span>
        <span className={`chip ${s.cls}`}>{s.text}</span>
      </div>
      {/* 主陈述：现状 ⟶ 结果。只有一个转变箭头；软链目标做成 chip，不再内嵌第二个箭头。 */}
      <div className="chg-flow">
        <span className="chg-before">{change.before}</span>
        <span className="chg-arrow" aria-hidden="true">⟶</span>
        {change.target ? (
          <span className="chg-link">
            <span className="chg-link-tag">软链</span>
            <span className="chg-link-target">{change.target}</span>
          </span>
        ) : (
          <span className="chg-after">{change.after}</span>
        )}
      </div>
      <p className="chg-reason">
        <span className="chg-why">为什么</span>
        {change.reason}
      </p>
      {change.ops.length > 0 && (
        <details className="chg-ops">
          <summary>技术细节 · {change.ops.length} 步原子操作</summary>
          <ul>
            {change.ops.map((op, i) => (
              <li key={i}>{describeOp(op, rel)}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

export function PlanSummary({ changes, repoRoot }: { changes: Change[]; repoRoot: string }) {
  const rel = (p: string) => (p.startsWith(repoRoot + '/') ? p.slice(repoRoot.length + 1) : p)
  const exec = changes.filter(isExecutable)
  const blocked = changes.filter((c) => !isExecutable(c))

  return (
    <section className="plan-sum" aria-label="变更概览">
      <div className="plan-head">
        <h2 className="plan-h2">
          本次变更<span className="plan-h2-n">{exec.length}</span>
          <span className="plan-h2-l">项</span>
        </h2>
        <p className="plan-outcome">{planOutcome(changes)}</p>
      </div>

      {exec.length > 0 && (
        <div className="chg-list">
          {exec.map((c) => (
            <ChangeCard key={c.key} change={c} rel={rel} />
          ))}
        </div>
      )}

      {/* 被挡住的维度：真实存在、这次不动。列出来、写原因 —— 藏起来 = 撒谎。 */}
      {blocked.length > 0 && (
        <div className="plan-blocked">
          <span className="lab">这些这次不动 · 需要先裁决下方冲突</span>
          {blocked.map((c) => (
            <div key={c.key} className="chg chg-blocked">
              <div className="chg-h">
                <span className="chg-title">{c.title}</span>
                <span className="chip blocked">{c.blockedReason}</span>
              </div>
              <p className="chg-reason">{c.reason}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
