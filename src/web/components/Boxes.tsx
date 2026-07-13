import { useState } from 'react'
import type { Dim } from '../../core/types.js'
import { anchorFold, type DistBox, type NowBox, type Row, type SrcBlock } from '../graph.js'

/** only 列表里超过这么多条就省略。不连线，所以可以每个盒子自己折自己。 */
const ONLY_CAP = 4

/**
 * 一行。文字一律左对齐（目录树就该这么读）——
 * 换边的只有接线柱，因为它决定线从哪儿出发。
 */
export function RowView({ row }: { row: Row }) {
  const cls = ['row', row.kind, row.tone, row.pt.includes('l') ? 'hasl' : '']
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} data-a={row.anchor}>
      {row.pt.includes('l') && <span className="pt l" />}
      <span className="tx">
        {row.kind === 'link' ? (
          <>
            <span className="rname">{row.text}</span>
            <span className="rarrow">→</span>
            <span className="rtarget">{row.target}</span>
          </>
        ) : (
          <span className="rname">{row.text}</span>
        )}
        {row.note && <span className="rnote">{row.note}</span>}
      </span>
      {row.pt.includes('r') && <span className="pt r" />}
    </div>
  )
}

/** 一个维度折起来之后的样子：整组条目收成一行，线也收成一条。 */
function FoldRow({
  n,
  anchor,
  side,
  onClick,
}: {
  n: number
  anchor?: string
  side: 'l' | 'r'
  onClick: () => void
}) {
  return (
    <button className="foldbtn" onClick={onClick} type="button">
      <RowView
        row={{ kind: 'note', text: `${n} 个条目`, note: '展开', tone: 'muted', pt: side, anchor }}
      />
    </button>
  )
}

function Collapse({ onClick }: { onClick: () => void }) {
  return (
    <button className="foldbtn" onClick={onClick} type="button">
      <RowView row={{ kind: 'note', text: '收起', tone: 'muted', pt: '' }} />
    </button>
  )
}

/**
 * 一个维度的条目列表。折 / 展是**按维度**的，不是按盒子 ——
 * 见 Graph.bigDims 上那段注释：按盒子折会让连线静默消失。
 */
function Entries({
  rows,
  dim,
  tool,
  side,
  folded,
  onToggle,
}: {
  rows: Row[]
  dim: Dim
  tool: string
  side: 'l' | 'r'
  folded: boolean
  onToggle: (d: Dim) => void
}) {
  if (folded && rows.length) {
    return (
      <FoldRow
        n={rows.length}
        anchor={anchorFold(tool, dim)}
        side={side}
        onClick={() => onToggle(dim)}
      />
    )
  }
  return (
    <>
      {rows.map((r, i) => (
        <RowView key={i} row={r} />
      ))}
    </>
  )
}

/** only 列表：不连线，所以可以就地省略，不用管别的盒子。 */
function Only({ rows }: { rows: Row[] }) {
  const [open, setOpen] = useState(false)
  if (rows.length <= ONLY_CAP + 1) {
    return (
      <>
        {rows.map((r, i) => (
          <RowView key={i} row={r} />
        ))}
      </>
    )
  }
  const shown = open ? rows : rows.slice(0, ONLY_CAP)
  return (
    <>
      {shown.map((r, i) => (
        <RowView key={i} row={r} />
      ))}
      <button className="foldbtn" onClick={() => setOpen(!open)} type="button">
        <RowView
          row={{
            kind: 'note',
            text: open ? '收起' : `还有 ${rows.length - ONLY_CAP} 个不管理的`,
            tone: 'muted',
            pt: '',
          }}
        />
      </button>
    </>
  )
}

interface Fold {
  /** 这些维度条目太多，默认折起来 */
  big: Dim[]
  open: Set<Dim>
  onToggle: (d: Dim) => void
}

const isFolded = (f: Fold, d: Dim) => f.big.includes(d) && !f.open.has(d)

/**
 * 列 1 的一个点目录。
 * 每个维度同时藏着「条目列表」和「一行软链」—— 收敛时前者折叠、后者原地展开。
 * 收拢发生在同一个位置上，不是换页。
 */
export function NowBoxView({ box, delay, fold }: { box: NowBox; delay: number; fold: Fold }) {
  return (
    <div
      className={box.badge ? 'box source' : 'box'}
      style={{ '--d': `${delay}ms` } as React.CSSProperties}
    >
      <div className="box-h">
        {box.badge && <span className="badge">{box.badge}</span>} {box.tool}/
      </div>
      {box.dims.map((d) => (
        <div key={d.dim} className={d.link ? 'dim willlink' : 'dim'}>
          {/* 目录名跟着条目一起折叠 —— 软链行里已经有 `skills/` 了，
              留着 head 会变成「skills/」紧跟「skills/ → ../.agents/skills」，重复一遍。 */}
          <div className="entries">
            <RowView row={d.head} />
            <Entries
              rows={d.entries}
              dim={d.dim}
              tool={box.tool}
              side="r"
              folded={isFolded(fold, d.dim)}
              onToggle={fold.onToggle}
            />
            {!isFolded(fold, d.dim) && d.entries.length > 0 && fold.big.includes(d.dim) && (
              <Collapse onClick={() => fold.onToggle(d.dim)} />
            )}
          </div>
          {d.link && (
            <div className="linkrow">
              <RowView row={d.link} />
            </div>
          )}
        </div>
      ))}
      {/* dot-agents 不管的东西。不折叠、不连线 —— 但它在磁盘上，就得在图上。 */}
      <Only rows={box.only} />
    </div>
  )
}

/** 列 3：唯一源。整页的重心，所以只有它上色。 */
export function SrcBoxView({
  dims,
  only,
  fold,
}: {
  dims: SrcBlock[]
  only: Row[]
  fold: Fold
}) {
  return (
    <div className="box source" style={{ '--d': '160ms' } as React.CSSProperties}>
      <div className="box-h">
        <span className="badge">唯一源</span> .agents/
      </div>
      {dims.length === 0 && only.length === 0 ? (
        <div className="row note muted">
          <span className="tx">
            <span className="rname">（先裁决冲突）</span>
          </span>
        </div>
      ) : (
        dims.map((d) => (
          <div key={d.dim} className="dim">
            <RowView row={d.head} />
            <Entries
              rows={d.entries}
              dim={d.dim}
              tool=".agents"
              side="l"
              folded={isFolded(fold, d.dim)}
              onToggle={fold.onToggle}
            />
            {!isFolded(fold, d.dim) && fold.big.includes(d.dim) && (
              <Collapse onClick={() => fold.onToggle(d.dim)} />
            )}
          </div>
        ))
      )}
      <Only rows={only} />
    </div>
  )
}

/** 列 4：执行后每个点目录只剩软链，线指回唯一源。 */
export function DistBoxView({ box, delay }: { box: DistBox; delay: number }) {
  // tone 才是判据，不是 kind。「整个目录是软链，我们不碰」也是 link 行，
  // 但它没有接上唯一源 —— 把它涂成收敛成功的样子，是在图上撒谎。
  const anyLink = box.rows.some((r) => r.kind === 'link' && r.tone === 'link')
  const links = box.rows.filter((r) => r.tone === 'link' || r.kind === 'note')
  const rest = box.rows.filter((r) => !(r.tone === 'link' || r.kind === 'note'))

  return (
    <div
      className={anyLink ? 'box tool' : 'box'}
      style={{ '--d': `${delay}ms` } as React.CSSProperties}
    >
      <div className="box-h">{box.tool}/</div>
      {links.map((r, i) => (
        <RowView key={i} row={r} />
      ))}
      {/* 不参与收敛的东西可能有几十个（~/.claude 下就是）。省略掉，别把软链淹了。 */}
      <Only rows={rest} />
    </div>
  )
}
