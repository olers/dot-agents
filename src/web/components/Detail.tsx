import { useEffect, useState } from 'react'
import type { Peek } from '../../core/types.js'
import type { EntryRef } from '../graph.js'
import { getFile } from '../api.js'

/** 打开侧栏先看哪个文件。SKILL.md 是这个条目的门面 —— 先看它，省用户一次点击。 */
export function defaultFile(files: string[]): string | undefined {
  return files.find((f) => f === 'SKILL.md') ?? files[0]
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
    <aside className="detail" role="dialog" aria-label={`${entry.key} 详情`}>
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
  )
}

export function Detail({ entry, onClose }: { entry: EntryRef; onClose: () => void }) {
  const [file, setFile] = useState<string | undefined>(() => defaultFile(entry.files))
  const [peek, setPeek] = useState<Peek | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 换了个条目：回到它自己的默认文件。不重置的话，上一个条目选中的
  // reference.md 会被带到下一个条目上，而它可能根本没有这个文件。
  useEffect(() => {
    setFile(defaultFile(entry.files))
  }, [entry])

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

  return (
    <DetailView
      entry={entry}
      file={file}
      peek={peek}
      loading={loading}
      err={err}
      onPick={setFile}
      onClose={onClose}
    />
  )
}
