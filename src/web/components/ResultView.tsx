import type { Result } from '../../core/types.js'

export function ResultView({ result, linkCount }: { result: Result; linkCount: number }) {
  if (!result.ok) {
    return (
      <div className="result bad">
        <div className="big">失败 —— 已全部回滚</div>
        <p className="result-err">{result.error}</p>
        <p className="muted">仓库回到了执行前的状态，没有留下半成品。</p>
      </div>
    )
  }

  if (result.applied.length === 0) {
    return (
      <div className="result">
        <div className="big">无需变更</div>
        <p className="muted">已经是统一状态。</p>
      </div>
    )
  }

  return (
    <div className="result">
      <div className="big">
        已收敛。<em>{result.applied.length} 个操作</em>，一个源，{linkCount} 条软链。
      </div>
      <dl>
        <dt>备份</dt>
        <dd>{result.atticDir}/backup/</dd>
        <dt>撤销</dt>
        <dd>sh {result.undoScript}</dd>
      </dl>
      <p className="muted">
        软链已建立，任一工具目录下的改动都会写回唯一源。可以关掉这个页面了 —— CLI 那边按 Ctrl-C
        退出。
      </p>
    </div>
  )
}
