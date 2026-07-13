import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Dim } from '../../core/types.js'
import { anchorFold, type Graph } from '../graph.js'
import type { Phase } from '../phase.js'

interface Seg {
  x1: number
  y1: number
  x2: number
  y2: number
  cls: string
  len: number
}

/** 低于这个宽度四列排不开，图会退化成上下堆叠 —— 那时没有中缝，也就没有线。 */
const NARROW = '(max-width: 1040px)'

/**
 * 两组线，两件事：
 *
 *   组一（现在 → 唯一源）：内容搬去哪。
 *     两条线撞进同一行 = 那个名字有多份内容不同的副本，也就是冲突。
 *     收敛后它从「每条目一条」变成「每目录一条」—— 线的条数真的少了，那就是收敛。
 *
 *   组二（唯一源 → 分发）：软链指回哪。
 *     这是软链的定义。不画出来，右边那些 `→ ../.agents/skills` 就只是一行字。
 *     计划态是虚线：那些链还没建立，它是预告，不是事实。
 *
 * 起止 x 一律钉在框的边线上。行宽随条目名长短变，拿行的边界当起点，线束就散了。
 */
export function Wires({
  graph,
  phase,
  gen,
  folded,
}: {
  graph: Graph
  phase: Phase
  gen: number
  /** 折起来的维度。它的条目行不在 DOM 里，逐条画线只会一条都画不出来。 */
  folded: (d: Dim) => boolean
}) {
  const svgRef = useRef<SVGSVGElement>(null)
  const [segs, setSegs] = useState<Seg[]>([])
  const [box, setBox] = useState({ w: 0, h: 0 })

  const measure = useCallback(() => {
    // 必须从自己的 svg 往上找，不能收一个父级的 ref 进来：
    // React 的 commit 是自底向上的 —— 子组件的 layout effect 跑的时候，
    // 父级那个 div 的 ref 还没 attach，拿到的是 null，一条线都画不出来。
    // svg 是本组件的子节点，它的 ref 一定先就绪。
    const g = svgRef.current?.parentElement
    if (!g) return
    if (window.matchMedia(NARROW).matches) {
      setSegs([])
      return
    }

    const frame = g.getBoundingClientRect()
    if (!frame.width) return
    setBox({ w: frame.width, h: frame.height })

    const nowBox = g.querySelector('.col-now .box')
    const srcBox = g.querySelector('.col-src .box')
    const distBox = g.querySelector('.col-dist .box')
    if (!nowBox || !srcBox) {
      setSegs([])
      return
    }

    const X = {
      nowR: nowBox.getBoundingClientRect().right - frame.left,
      srcL: srcBox.getBoundingClientRect().left - frame.left,
      srcR: srcBox.getBoundingClientRect().right - frame.left,
      distL: distBox ? distBox.getBoundingClientRect().left - frame.left : null,
    }

    /**
     * 接线柱的纵向中心。折叠到一半的行没有高度 —— 那时它还没有位置可言。
     *
     * 属性选择器里的值是字符串，不要拿 CSS.escape 去处理它 ——
     * 那是给标识符用的，会把 anchor 里的 `|` 转义成 `\|`，一个都匹配不上。
     */
    const yOf = (anchor: string, side?: 'l' | 'r'): number | null => {
      const row = g.querySelector(`[data-a="${anchor}"]`)
      const pt = row?.querySelector(side ? `.pt.${side}` : '.pt')
      if (!pt) return null
      const r = pt.getBoundingClientRect()
      if (!r.height) return null
      return r.top - frame.top + r.height / 2
    }

    const out: Seg[] = []
    const push = (x1: number, y1: number, x2: number, y2: number, cls: string) =>
      out.push({ x1, y1, x2, y2, cls, len: Math.abs(y2 - y1) + (x2 - x1) + 40 })

    const converged = phase !== 'plan'

    /* ── 组一 ── */
    if (!converged) {
      for (const b of graph.now)
        for (const d of b.dims) {
          // 折起来的维度：整组的线收成一条，落在唯一源的维度头上。
          // 逐条去画，锚点全在 DOM 之外 —— 画出来的是零条线，用户读到的是「这些条目不会被收录」。
          if (folded(d.dim)) {
            const live = d.entries.filter((r) => r.anchor)
            if (!live.length) continue // 全是落败方 / 重复副本，本来就没有线
            const y1 = yOf(anchorFold(b.tool, d.dim))
            const y2 = yOf(`S|${d.dim}`, 'l')
            if (y1 === null || y2 === null) continue
            push(X.nowR, y1, X.srcL, y2, live.some((r) => r.tone === 'dup') ? 'dup' : '')
            continue
          }

          for (const row of d.entries) {
            if (!row.anchor) continue // 落败方 / 重复副本：它不会进唯一源，没有线
            const key = row.anchor.split('|')[2]
            const y1 = yOf(row.anchor)
            const y2 = yOf(`T|${key}`, 'l')
            if (y1 === null || y2 === null) continue
            push(X.nowR, y1, X.srcL, y2, row.tone === 'dup' ? 'dup' : '')
          }
        }
    } else {
      for (const b of graph.now)
        for (const d of b.dims) {
          if (!d.link?.anchor) continue
          const y1 = yOf(d.link.anchor)
          const y2 = yOf(`S|${d.dim}`, 'l')
          if (y1 === null || y2 === null) continue // linkrow 还没展开
          push(X.nowR, y1, X.srcL, y2, 'linked')
        }
    }

    /* ── 组二 ── */
    if (X.distL !== null)
      for (const b of graph.dist)
        for (const row of b.rows) {
          if (!row.anchor) continue
          const dim = row.anchor.split('|')[2]
          const y1 = yOf(`S|${dim}`, 'r')
          const y2 = yOf(row.anchor, 'l')
          if (y1 === null || y2 === null) continue
          push(X.srcR, y1, X.distL, y2, converged ? 'linked' : 'plan')
        }

    setSegs(out)
  }, [graph, phase, folded])

  // gen 是外部的重测信号：折叠动画跑完、apply 回来，都得重新量一次
  useLayoutEffect(measure, [measure, gen])

  useEffect(() => {
    let t: ReturnType<typeof setTimeout>
    const onResize = () => {
      clearTimeout(t)
      t = setTimeout(measure, 120)
    }
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      clearTimeout(t)
    }
  }, [measure])

  return (
    <svg ref={svgRef} className="wires" viewBox={`0 0 ${box.w} ${box.h}`} aria-hidden="true">
      {segs.map((s, i) => {
        // 两端对称发力，线束贴着中缝走，不往外鼓
        const dx = (s.x2 - s.x1) * 0.46
        const d = `M ${s.x1} ${s.y1} C ${s.x1 + dx} ${s.y1}, ${s.x2 - dx} ${s.y2}, ${s.x2} ${s.y2}`
        return (
          <path
            key={i}
            className={`wire ${s.cls}`}
            d={d}
            style={
              { '--len': s.len.toFixed(0), '--d': `${i * 40}ms` } as React.CSSProperties
            }
          />
        )
      })}
    </svg>
  )
}
