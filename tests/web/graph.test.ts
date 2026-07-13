import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { buildGraph, anchorItem, anchorSrcItem, refId, FOLD_CAP } from '../../src/web/graph.js'
import type { Graph, Row } from '../../src/web/graph.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

let root = ''
afterEach(async () => {
  if (root) await cleanupRepo(root)
  root = ''
})

/**
 * .claude 和 .codebuddy 各有一份 caveman，内容不同 —— 真冲突。
 * 两边各有一份 commit，内容完全相同 —— 只是重复，不是冲突。
 * 这两件事在 UI 上必须长得不一样，否则用户会以为每个重名都要他来裁决。
 */
async function mkFixture() {
  return mkRepo({
    '.claude/skills/caveman/SKILL.md': '内容 A',
    '.codebuddy/skills/caveman/SKILL.md': '内容 B —— 和 A 不一样',
    '.claude/skills/tdd/SKILL.md': 'tdd',
    '.claude/commands/commit.md': '一模一样',
    '.codebuddy/commands/commit.md': '一模一样',
  })
}

const rowsOf = (g: Graph, tool: string, dim: string): Row[] =>
  g.now.find((b) => b.tool === tool)?.dims.find((d) => d.dim === dim)?.entries ?? []

const srcRows = (g: Graph): Row[] => g.src.dims.flatMap((d) => d.entries)

const srcRow = (g: Graph, name: string): Row | undefined =>
  srcRows(g).find((r) => r.kind === 'item' && r.text === name)

describe('buildGraph —— 未裁决的冲突', () => {
  it('在唯一源里留一行占位，并明说它原地不动', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    const caveman = srcRow(graph, 'caveman')
    // 不留这一行，用户看不到 caveman，会以为它悄悄进了唯一源。
    // 实际上它会原地不动 —— 这是必须被看见的事实。
    expect(caveman).toBeDefined()
    expect(caveman!.tone).toBe('dup')
    expect(caveman!.note).toContain('未裁决')
    expect(caveman!.note).toContain('原地不动')
  })

  it('两边的副本都连到那一行 —— 两条线撞进同一个名字，冲突就长这样', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    const a = rowsOf(graph, '.claude', 'skills').find((r) => r.text === 'caveman')!
    const b = rowsOf(graph, '.codebuddy', 'skills').find((r) => r.text === 'caveman')!

    expect(a.tone).toBe('dup')
    expect(b.tone).toBe('dup')
    // 两条线，同一个落点。这是「冲突」在图上的全部含义。
    expect(a.anchor).toBe(anchorItem('.claude', 'skills/caveman'))
    expect(b.anchor).toBe(anchorItem('.codebuddy', 'skills/caveman'))
    expect(srcRow(graph, 'caveman')!.anchor).toBe(anchorSrcItem('skills/caveman'))
  })

  it('被挡住的目录，在「执行后」那一列显式写出来', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    const claude = graph.dist.find((d) => d.tool === '.claude')!
    const skills = claude.rows.find((r) => r.text === 'skills/')!

    // 软链是目录级的：skills/ 里还压着一个没裁决的 caveman，
    // 整个 skills/ 就换不成软链。沉默地跳过，用户会以为它接上了。
    expect(skills.kind).toBe('note')
    expect(skills.note).toContain('未裁决')

    // commands/ 没有冲突，照常接链
    expect(claude.rows.find((r) => r.text === 'commands/')!.kind).toBe('link')
  })
})

describe('buildGraph —— 裁决之后', () => {
  it('输家不再连线：它不会进唯一源，画一条线过去就是撒谎', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, { 'skills/caveman': '.claude' }))

    const winner = rowsOf(graph, '.claude', 'skills').find((r) => r.text === 'caveman')!
    const loser = rowsOf(graph, '.codebuddy', 'skills').find((r) => r.text === 'caveman')!

    expect(winner.tone).toBe('won')
    expect(winner.anchor).toBeDefined()

    expect(loser.tone).toBe('loser')
    expect(loser.anchor).toBeUndefined()
  })

  it('唯一源里那行不再是冲突态，两边目录都接上软链', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, { 'skills/caveman': '.claude' }))

    expect(srcRow(graph, 'caveman')!.tone).toBe('plain')

    for (const tool of ['.claude', '.codebuddy']) {
      const box = graph.dist.find((d) => d.tool === tool)!
      expect(box.rows.every((r) => r.kind === 'link')).toBe(true)
    }
  })
})

describe('buildGraph —— 内容相同的重复副本', () => {
  it('标成 dropped 且不连线：它被静默去重，根本不会进唯一源', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    const claude = rowsOf(graph, '.claude', 'commands').find((r) => r.text === 'commit.md')!
    const buddy = rowsOf(graph, '.codebuddy', 'commands').find((r) => r.text === 'commit.md')!

    // 白名单顺序即优先级：.claude 排前面，它当源。
    expect(claude.tone).toBe('plain')
    expect(claude.anchor).toBeDefined()

    // .codebuddy 那份内容一模一样 —— 备份后删掉，不需要用户裁决。
    // 它要是长得跟冲突一样，用户会以为自己漏选了什么。
    expect(buddy.tone).toBe('dropped')
    expect(buddy.anchor).toBeUndefined()

    expect(srcRow(graph, 'commit.md')).toBeDefined()
  })
})

describe('buildGraph —— 已经是软链的维度', () => {
  it('不参与折叠，且在「执行后」标明它本来就是软链', async () => {
    root = await mkRepo({
      '.agents/skills/tdd/SKILL.md': 'tdd',
      '.claude/skills': { symlink: '../.agents/skills' },
      '.claude/commands/ship.md': 'ship',
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    const skills = graph.now
      .find((b) => b.tool === '.claude')!
      .dims.find((d) => d.dim === 'skills')!

    // 已经收敛过的维度没有内容可搬，也就没有「折叠成软链」这个动作可演
    expect(skills.entries).toEqual([])
    expect(skills.link).toBeNull()
    expect(skills.head.kind).toBe('link')

    const dist = graph.dist.find((d) => d.tool === '.claude')!
    expect(dist.rows.find((r) => r.text === 'skills/')!.note).toBe('已经是软链')
  })
})

/**
 * 「现在 · 散在各处」这个标题，承诺的是仓库里点目录的**全部**现状。
 * 只画有受管维度的那几个，就是拿一个残缺的现状去冒充完整的现状 ——
 * 用户看到图上没有自己的 .codex，得出的结论是「工具没发现它」，而不是「工具不管它」。
 */
describe('buildGraph —— 不收敛的东西也要看得见', () => {
  it('一个受管维度都没有的工具目录，照样进图（执行前后都在）', async () => {
    root = await mkRepo({
      '.claude/skills/tdd/SKILL.md': 'tdd',
      '.codex/environments/e.json': '{}',
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    // .codex 一个受管维度都没有 —— 老代码这里 blocks.length === 0，整个盒子被丢掉。
    const now = graph.now.find((b) => b.tool === '.codex')
    expect(now).toBeDefined()
    expect(now!.dims).toEqual([])
    expect(now!.only.map((r) => r.text)).toEqual(['environments/'])
    expect(now!.only[0].note).toContain('不管理')

    // 执行后：skills/ 是新接的软链（.codex 也是白名单工具，照样分发），
    // environments/ 原封不动 —— 漏掉它，等于暗示它被收走了。
    const dist = graph.dist.find((b) => b.tool === '.codex')!
    expect(dist.rows.map((r) => r.text)).toEqual(['skills/', 'environments/'])
    expect(dist.rows[1].tone).toBe('muted')
  })

  it('整个目录是软链的工具，两列都画出来，并写明不碰', async () => {
    root = await mkRepo({
      '.agents/skills/tdd/SKILL.md': 'tdd',
      '.claude': { symlink: '.agents' },
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    for (const col of [graph.now.find((b) => b.tool === '.claude')?.only, graph.dist.find((b) => b.tool === '.claude')?.rows]) {
      expect(col).toHaveLength(1)
      expect(col![0].kind).toBe('link')
      expect(col![0].target).toBe('.agents')
      expect(col![0].note).toContain('不碰')
    }
  })

  it('白名单外的点目录列在图外 —— 不参与收敛，但不假装它不存在', async () => {
    root = await mkRepo({
      '.claude/skills/tdd/SKILL.md': 'tdd',
      '.superpowers/sdd/x.md': 'y',
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    expect(graph.strangers.map((r) => r.text)).toEqual(['.superpowers/'])
  })
})

describe('buildGraph —— 唯一源也是「现在」的一部分', () => {
  it('.agents 里已有的东西出现在「现在」，不是只有工具目录', async () => {
    root = await mkRepo({
      '.agents/skills/tdd/SKILL.md': 'tdd',
      '.agents/docs/x.md': 'doc',
      '.claude/skills/caveman/SKILL.md': 'c',
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    // 只画工具目录，用户会以为 .agents/ 现在是空的 —— 它里头已经躺着 tdd 了。
    const box = graph.now.find((b) => b.tool === '.agents')!
    expect(box.badge).toBe('唯一源')
    expect(box.dims.find((d) => d.dim === 'skills')!.entries.map((r) => r.text)).toEqual(['tdd'])
    // 唯一源永远不会被换成软链
    expect(box.dims.every((d) => d.link === null)).toBe(true)
  })

  it('.agents 下不是受管维度的东西（docs/），执行前后都要列出来', async () => {
    root = await mkRepo({
      '.agents/skills/tdd/SKILL.md': 'tdd',
      '.agents/docs/x.md': 'doc',
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    // 「执行后」只画四个维度，就是在承诺一个干净的 .agents —— 而 docs/ 执行后还在那儿。
    expect(graph.src.only.map((r) => r.text)).toEqual(['docs/'])
    expect(graph.now.find((b) => b.tool === '.agents')!.only.map((r) => r.text)).toEqual(['docs/'])
  })
})

/**
 * 折叠是视图行为，但**折叠的粒度**是数据契约：
 * 线靠 DOM 锚点量，一个维度必须在所有盒子里同进同退，否则线的两端会一头在、一头没了。
 */
describe('buildGraph —— 折叠判据', () => {
  const many = (tool: string, n: number) =>
    Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`${tool}/skills/s${i}/SKILL.md`, `x${i}`]),
    )

  it('条目没超过上限 -> 不折', async () => {
    root = await mkRepo(many('.claude', FOLD_CAP))
    const state = await scan(root)
    expect(buildGraph(state, buildPlan(state, {})).bigDims).toEqual([])
  })

  it('任何一个盒子超了 -> 这个维度整体折，不是只折那一个盒子', async () => {
    root = await mkRepo({
      ...many('.claude', FOLD_CAP + 1),
      '.codebuddy/skills/only-one/SKILL.md': 'x', // 这个盒子只有 1 个，照样跟着折
      '.claude/commands/c.md': 'x',
    })
    const state = await scan(root)
    const graph = buildGraph(state, buildPlan(state, {}))

    // skills 超了 -> 折。commands 只有 1 个 -> 不折。
    expect(graph.bigDims).toEqual(['skills'])
  })
})

describe('buildGraph —— 只翻译 plan，不自己推演', () => {
  it('唯一源里的条目全部来自 plan.ops 的 move 落点', async () => {
    root = await mkFixture()
    const state = await scan(root)
    const plan = buildPlan(state, { 'skills/caveman': '.codebuddy' })
    const graph = buildGraph(state, plan)

    const landed = new Set(
      plan.ops
        .filter((o) => o.t === 'move')
        .map((o) => (o as { to: string }).to.split('/').pop()!),
    )
    const shown = new Set(srcRows(graph).map((r) => r.text))

    // 前端一旦自己算一遍「应该会变成什么样」，它的预测就会和真正执行的东西对不上。
    // 这个仓库里没有「本来就在 .agents 里」的条目，所以两边应该完全相等。
    expect(shown).toEqual(landed)
  })
})

describe('Row.ref —— 行连回真实条目', () => {
  it('「现在」列的条目行带 ref，指向它在磁盘上的真实路径', async () => {
    root = await mkRepo({ '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n' })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const row = g.now.find((b) => b.tool === '.claude')!.dims[0].entries[0]
    expect(row.ref).toBeDefined()
    expect(row.ref!.path).toBe(join(root, '.claude/skills/foo'))
    expect(row.ref!.from).toBe('.claude')
    expect(row.ref!.isDir).toBe(true)
    expect(row.ref!.desc).toBe('我是 foo')
    expect(row.ref!.files).toEqual(['SKILL.md'])
  })

  // WHY: 唯一源那一列是**预测** —— 文件还没搬过去，.agents/skills/foo 在磁盘上根本不存在。
  // ref 指向目标路径的话，点开侧栏必然 404。它得指向「内容将会来自哪儿」。
  it('唯一源列的条目：ref 指向源路径，不是 .agents 下那个还不存在的目标', async () => {
    root = await mkRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const row = g.src.dims.find((d) => d.dim === 'skills')!.entries[0]
    expect(row.ref!.path).toBe(join(root, '.claude/skills/foo'))
    expect(row.ref!.path).not.toContain('.agents')
    expect(row.ref!.from).toBe('.claude')
  })

  // WHY: 用户最想点开的恰恰是「我要删掉的这份」。不给它 ref，等于让用户闭着眼睛删。
  it('冲突里落败的、和被静默去重的条目，一样可以点开', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
      '.cursor/skills/bar/SKILL.md': 'same',
      '.trae/skills/bar/SKILL.md': 'same',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, { 'skills/foo': '.claude' }))

    const loser = g.now
      .find((b) => b.tool === '.codebuddy')!
      .dims[0].entries.find((r) => r.text === 'foo')!
    expect(loser.tone).toBe('loser')
    expect(loser.ref!.path).toBe(join(root, '.codebuddy/skills/foo'))

    const dropped = g.now
      .find((b) => b.tool === '.trae')!
      .dims[0].entries.find((r) => r.text === 'bar')!
    expect(dropped.tone).toBe('dropped')
    expect(dropped.ref).toBeDefined()
  })

  // WHY: 未裁决的冲突在唯一源列里只是一个赭石占位行，它没有唯一的内容来源 ——
  // 那正是「未裁决」的含义。给它 ref = 替用户选了一份，而这个工具的第一原则就是绝不替他选。
  it('未裁决冲突的占位行没有 ref，点不开', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const row = g.src.dims.find((d) => d.dim === 'skills')!.entries.find((r) => r.text === 'foo')!
    expect(row.tone).toBe('dup')
    expect(row.ref).toBeUndefined()
  })

  it('不管理的东西（only / residue / 软链行）都没有 ref', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'x',
      '.claude/settings.json': '{}',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const box = g.now.find((b) => b.tool === '.claude')!
    expect(box.only.every((r) => r.ref === undefined)).toBe(true)
  })

  // WHY: 同一个 name 在 .claude 和 .codebuddy 里都有，key 都是 skills/foo。
  // 拿 key 当选中态的标识，点开左边那份，右边那份也会跟着高亮 —— 那是在撒谎。
  it('refId 用 from + key，同名条目在不同盒子里不会互相冒充', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const a = g.now.find((b) => b.tool === '.claude')!.dims[0].entries[0].ref!
    const b = g.now.find((b) => b.tool === '.codebuddy')!.dims[0].entries[0].ref!
    expect(a.key).toBe(b.key)
    expect(refId(a)).not.toBe(refId(b))
  })
})
