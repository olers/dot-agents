import { describe, it, expect, afterEach } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { buildGraph, anchorFold, refId, FOLD_CAP } from '../../src/web/graph.js'
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

describe('可点的行 + 描述预览', () => {
  it('带 ref 的条目行：有 role=button 和 tabindex，键盘能停上去', async () => {
    const g = await graphOf({ '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!

    const html = renderToStaticMarkup(
      <NowBoxView box={box} delay={0} fold={fold} onOpen={() => {}} />,
    )
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('clickable')
  })

  // WHY: 有描述才浮提示。没有 desc 还渲染一个空方块，hover 上去是一片空白 —— 那比没有更糟。
  it('有 desc -> 渲染 tooltip；没有 desc -> 一个 tip 节点都不渲染', async () => {
    const withDesc = await graphOf({
      '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n',
    })
    const f1 = { big: withDesc.bigDims, open: new Set<never>(), onToggle: () => {} }
    const h1 = renderToStaticMarkup(
      <NowBoxView
        box={withDesc.now.find((b) => b.tool === '.claude')!}
        delay={0}
        fold={f1}
        onOpen={() => {}}
      />,
    )
    expect(h1).toContain('class="tip"')
    expect(h1).toContain('我是 foo')

    const noDesc = await graphOf({ '.claude/skills/foo/SKILL.md': '没有 frontmatter' })
    const f2 = { big: noDesc.bigDims, open: new Set<never>(), onToggle: () => {} }
    const h2 = renderToStaticMarkup(
      <NowBoxView
        box={noDesc.now.find((b) => b.tool === '.claude')!}
        delay={0}
        fold={f2}
        onOpen={() => {}}
      />,
    )
    expect(h2).not.toContain('class="tip"')
  })

  // WHY: only 里是 dot-agents 不管理的东西。让它们看起来可点、点了却什么都没有，
  // 等于告诉用户「这里有内容」——而我们压根不读它们。
  it('不管理的行（only）不可点：没有 role=button', async () => {
    const g = await graphOf({ '.claude/settings.json': '{}' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!

    const html = renderToStaticMarkup(
      <NowBoxView box={box} delay={0} fold={fold} onOpen={() => {}} />,
    )
    expect(html).toContain('settings.json')
    expect(html).not.toContain('role="button"')
  })

  // WHY: 不传 onOpen（比如某个只读视图不想要侧栏）时，行不该假装可点。
  it('没传 onOpen -> 行不可点', async () => {
    const g = await graphOf({ '.claude/skills/foo/SKILL.md': 'x' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!

    const html = renderToStaticMarkup(<NowBoxView box={box} delay={0} fold={fold} />)
    expect(html).not.toContain('role="button"')
  })

  it('activeId 命中的那一行带 active 类', async () => {
    const g = await graphOf({ '.claude/skills/foo/SKILL.md': 'x' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!
    const id = refId(box.dims[0].entries[0].ref!)

    const html = renderToStaticMarkup(
      <NowBoxView box={box} delay={0} fold={fold} onOpen={() => {}} activeId={id} />,
    )
    expect(html).toContain('active')
  })
})
