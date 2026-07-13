import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { buildGraph, anchorFold, FOLD_CAP } from '../../src/web/graph.js'
import { NowBoxView, SrcBoxView } from '../../src/web/components/Boxes.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

let root = ''
afterEach(async () => {
  if (root) await cleanupRepo(root)
  root = ''
})

async function graphOf(layout: Record<string, string>) {
  root = await mkRepo(layout)
  const state = await scan(root)
  return buildGraph(state, buildPlan(state, {}))
}

const many = (tool: string, n: number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`${tool}/skills/s${i}/SKILL.md`, `x${i}`]))

/**
 * 折叠是视图行为，但它有一个必须成立的数据后果：
 * 折起来的那一行，得带着「整组线」的锚点。没有它，Wires 找不到落点 ——
 * 一个维度被折起来，用户看到的就是「这些条目一条线都没有」= 它们不会被收录。那是假的。
 */
describe('折叠后的盒子', () => {
  it('折起来时：条目行不渲染，取而代之的是一行带锚点的「N 个条目」', async () => {
    const g = await graphOf(many('.claude', FOLD_CAP + 1))
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }

    const box = g.now.find((b) => b.tool === '.claude')!
    const html = renderToStaticMarkup(<NowBoxView box={box} delay={0} fold={fold} />)

    expect(html).toContain(`${FOLD_CAP + 1} 个条目`)
    expect(html).not.toContain('>s0<') // 条目本身不在 DOM 里
    // 这个锚点就是 Wires 画那条汇总线的起点
    expect(html).toContain(`data-a="${anchorFold('.claude', 'skills')}"`)
  })

  it('展开后：每个条目都带回自己的锚点（线才逐条画得出来）', async () => {
    const g = await graphOf(many('.claude', FOLD_CAP + 1))
    const fold = { big: g.bigDims, open: new Set(['skills' as const]), onToggle: () => {} }

    const box = g.now.find((b) => b.tool === '.claude')!
    const html = renderToStaticMarkup(<NowBoxView box={box} delay={0} fold={fold} />)

    expect(html).toContain('>s0<')
    expect(html).toContain('data-a="A|.claude|skills/s0"')
    expect(html).toContain('收起')
  })

  it('唯一源跟着同一个维度一起折 —— 两端的锚点必须成对出现或成对消失', async () => {
    const g = await graphOf(many('.claude', FOLD_CAP + 1))
    const folded = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }

    const html = renderToStaticMarkup(
      <SrcBoxView dims={g.src.dims} only={g.src.only} fold={folded} />,
    )
    // 唯一源这一侧也折了：左边折了右边没折的话，左边那条汇总线会落在一个不存在的锚点上
    expect(html).not.toContain('data-a="T|skills/s0"')
    expect(html).toContain('data-a="S|skills"') // 维度头永远在 —— 汇总线的落点
  })

  it('条目没超上限：正常铺开，没有折叠行', async () => {
    const g = await graphOf(many('.claude', 3))
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }

    const box = g.now.find((b) => b.tool === '.claude')!
    const html = renderToStaticMarkup(<NowBoxView box={box} delay={0} fold={fold} />)

    expect(html).toContain('>s0<')
    expect(html).not.toContain('个条目')
    expect(html).not.toContain('收起')
  })
})
