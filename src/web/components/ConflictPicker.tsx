import type { Plan, Resolutions } from '../../core/types.js'

export function ConflictPicker({
  plan,
  resolutions,
  onPick,
}: {
  plan: Plan
  resolutions: Resolutions
  onPick: (key: string, tool: string) => void
}) {
  const left = plan.skipped.length

  return (
    <div className="conf">
      <div className="conf-h">
        <span className="t">冲突裁决</span>
        <span className="c">{plan.conflicts.length}</span>
        <span className="h">
          {left > 0
            ? '两条赭石线撞进唯一源同一行 —— 那就是冲突'
            : '都选完了，线已收拢'}
        </span>
      </div>

      <p className="muted conf-note">
        同名但内容不同的副本。选一个当唯一源，其余先备份进 <code>.agents/.attic/</code> 再删除。
        {/* 软链是目录级的：只要目录里还有没裁决的条目，整个目录就换不成软链。
            不写清楚，用户会以为「跳过一个冲突」只影响那一个条目。 */}
        {plan.blockedDims.length > 0 && (
          <>
            {' '}没裁决完的目录（
            <code>{plan.blockedDims.map((b) => `${b.tool}/${b.dim}`).join('、')}</code>
            ）本次不会接上软链。
          </>
        )}
      </p>

      {plan.conflicts.map((c) => (
        <div key={c.key} className="crow">
          <span className="ckey">{c.key}</span>
          <div className="cands">
            {c.candidates.map((cand) => (
              <button
                key={cand.tool}
                className="cand"
                aria-pressed={resolutions[c.key] === cand.tool}
                onClick={() => onPick(c.key, cand.tool)}
              >
                <span className="cand-tool">{cand.tool}</span>
                <span className="cand-meta">
                  {cand.files.length} 个文件 · {cand.hash.slice(0, 6)}
                </span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
