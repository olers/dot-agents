import { useEffect, useState } from 'react'
import type { Peek } from '../../core/types.js'
import { refId, type EntryRef } from '../graph.js'
import { getFile } from '../api.js'

/** 打开侧栏先看哪个文件。SKILL.md 是这个条目的门面 —— 先看它，省用户一次点击。 */
export function defaultFile(files: string[]): string | undefined {
  return files.find((f) => f === 'SKILL.md') ?? files[0]
}

/**
 * 一次点击该不该关掉侧栏。纯判定，抽出来是为了不靠 jsdom 就能验行为。
 *
 * 三条规则，缺一不可：
 *   - 点在抽屉里面           -> 不关（X 按钮、文件切换、正文选中都在里面）
 *   - 点在任何交互控件上     -> 不关：那次点击自己有事要做
 *                              （点另一个条目 = 切换内容，绝不能先关再开）
 *   - 其余（图的空白、标题）-> 关
 *
 * 背景遮罩是「点得穿」的（pointer-events:none），所以这些点击真的落到图上、
 * 由这个判定接管，而不是被遮罩吞掉 —— 图始终可点、可切换条目。
 */
export function shouldDismiss(target: EventTarget | null, drawer: Element | null): boolean {
  if (!(target instanceof Element)) return false
  if (drawer && drawer.contains(target)) return false
  if (target.closest('button, [role="button"], a, input, label, select, textarea, summary')) {
    return false
  }
  return true
}

/**
 * 一个文件的绝对路径。
 *
 * 单文件条目（commands / agents / hooks）的 path 本身就是那个文件，
 * 再拼一次 basename 会得到 …/go.md/go.md —— 必然 404。
 */
export function fileAbs(entry: EntryRef, file: string): string {
  return entry.isDir ? `${entry.path}/${file}` : entry.path
}

interface ViewProps {
  entry: EntryRef
  file?: string
  peek: Peek | null
  loading: boolean
  err: string | null
  onPick: (f: string) => void
  onClose: () => void
}

/**
 * 纯展示。把取数据和画出来分开 —— 这样每一种状态
 * （加载中 / 出错 / 二进制 / 截断 / 正常）都能被单独渲染出来验，不用 jsdom。
 */
export function DetailView({ entry, file, peek, loading, err, onPick, onClose }: ViewProps) {
  return (
    <>
      {/* 克制的背景：轻轻压暗，点得穿（pointer-events:none）。图仍看得清、点得到。
          真正「点外面关掉」由 document 上的 mousedown + shouldDismiss 接管。 */}
      <div className="detail-scrim" aria-hidden="true" />
      <aside className="detail" role="dialog" aria-modal="false" aria-label={`${entry.key} 详情`}>
      <div className="detail-h">
        <div className="detail-id">
          <div className="detail-t">{entry.name}</div>
          <div className="detail-sub">
            <span className="badge">{entry.dim}</span>
            <span className="detail-from">{entry.from}/</span>
          </div>
        </div>
        <button className="detail-x" onClick={onClose} aria-label="关闭详情" type="button">
          ×
        </button>
      </div>

      <div className="detail-path">{entry.path}</div>

      {entry.desc ? (
        <p className="detail-desc">{entry.desc}</p>
      ) : (
        <p className="detail-desc muted">无 frontmatter 描述</p>
      )}

      <div className="detail-files">
        {entry.files.map((f) => (
          <button
            key={f}
            className="dfile"
            aria-pressed={f === file}
            onClick={() => onPick(f)}
            type="button"
          >
            {f}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {err ? (
          <p className="err">读取失败：{err}</p>
        ) : loading ? (
          <p className="muted">加载中…</p>
        ) : !file ? (
          <p className="muted">这个条目里没有文件</p>
        ) : peek?.binary ? (
          <p className="muted">二进制文件，不展示内容</p>
        ) : peek ? (
          <pre className="detail-pre">{peek.content}</pre>
        ) : null}
      </div>

      {/* 截断了不说，用户会以为他看到的就是全部。 */}
      {peek?.truncated && <div className="detail-cut">已截断，仅显示前 256KB</div>}
      </aside>
    </>
  )
}

export function Detail({ entry, onClose }: { entry: EntryRef; onClose: () => void }) {
  // 选中的文件跟着条目走。用 render 期间派生、而不是 useEffect 重置 ——
  // 后者会让「取数据」那个 effect 先拿着上一个条目的文件名对新条目发一次请求，
  // 那次请求注定被丢弃，纯属浪费。
  const [sel, setSel] = useState<{ id: string; file?: string }>(() => ({
    id: refId(entry),
    file: defaultFile(entry.files),
  }))
  const file = sel.id === refId(entry) ? sel.file : defaultFile(entry.files)
  const onPick = (f: string) => setSel({ id: refId(entry), file: f })

  const [peek, setPeek] = useState<Peek | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    if (!file) {
      setPeek(null)
      return
    }
    let dead = false
    setLoading(true)
    setErr(null)
    getFile(fileAbs(entry, file))
      .then((p) => {
        if (dead) return // 请求还在飞的时候用户又点了别的 —— 别让旧结果覆盖新的
        setPeek(p)
        setLoading(false)
      })
      .catch((e) => {
        if (dead) return
        setErr(String(e))
        setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [entry, file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // 点外面关掉。用 mousedown（在 focus 变更之前触发），落点交给 shouldDismiss 判。
  // 抽屉整个是 position:fixed，用类名取它即可 —— 同一时刻只有一个。
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (shouldDismiss(e.target, document.querySelector('.detail'))) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [onClose])

  return (
    <DetailView
      entry={entry}
      file={file}
      peek={peek}
      loading={loading}
      err={err}
      onPick={onPick}
      onClose={onClose}
    />
  )
}
