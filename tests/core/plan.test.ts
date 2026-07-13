import { describe, it, expect, afterEach } from 'vitest'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { mkRepo, cleanupRepo, type Layout } from '../helpers/mkrepo.js'
import type { Op, Resolutions } from '../../src/core/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function planFor(layout: Layout, resolutions: Resolutions = {}) {
  const r = await mkRepo(layout)
  roots.push(r)
  return { root: r, plan: buildPlan(await scan(r), resolutions) }
}
const opsOf = <T extends Op['t']>(ops: Op[], t: T) =>
  ops.filter((o) => o.t === t) as Extract<Op, { t: T }>[]

describe('buildPlan', () => {
  it('单个工具的 real 目录 -> move 条目 + rmdir 空壳 + symlink', async () => {
    const { plan } = await planFor({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(plan.conflicts).toEqual([])
    expect(opsOf(plan.ops, 'move')).toHaveLength(1)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
    // WHY: 绝对路径的软链换台机器就废，也没法提交进 git。相对路径是唯一能用的形式。
    expect(opsOf(plan.ops, 'symlink')[0].target).toBe('../.agents/skills')
  })

  // WHY: 内容一模一样却让人裁决，是在浪费人的注意力。人被无意义的确认框训练几次之后，
  // 就会开始无脑点确认 —— 那时真正的冲突也会被一起点过去。
  it('两个工具、同名、哈希相同 -> 不是冲突，第二份 discard', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'same',
      '.codebuddy/skills/foo/SKILL.md': 'same',
    })
    expect(plan.conflicts).toEqual([])
    expect(opsOf(plan.ops, 'move')).toHaveLength(1) // .claude 排前面，当源
    expect(opsOf(plan.ops, 'discard')).toHaveLength(1) // .codebuddy 那份丢弃
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(2) // 两个工具都建链
  })

  // WHY: 静默丢内容是这个工具最严重的失败模式。哈希不同 = 有人的东西会消失，必须停下来问。
  it('两个工具、同名、哈希不同 -> conflict，且绝不自动选', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].key).toBe('skills/foo')
    expect(plan.conflicts[0].candidates.map((c) => c.tool).sort()).toEqual([
      '.claude',
      '.codebuddy',
    ])
    expect(plan.resolved).toEqual({})
    expect(plan.skipped).toHaveLength(1)
    // 一个都不许动
    expect(opsOf(plan.ops, 'move')).toHaveLength(0)
    expect(opsOf(plan.ops, 'discard')).toHaveLength(0)
  })

  // WHY: 软链是目录级的。只要 .claude/skills/ 里还留着一个未裁决的 foo，这个目录就不能被替换成软链。
  // 用户以为「跳过一个 skill」，实际是「这个工具的 skills 整个没接上」。plan 必须先算出来，UI 才能讲清楚。
  it('未裁决的冲突 -> 该 (tool, dim) 被 block，不建链', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(0)
    expect(plan.blockedDims.map((b) => `${b.tool}/${b.dim}`).sort()).toEqual([
      '.claude/skills',
      '.codebuddy/skills',
    ])
  })

  it('裁决后 -> 赢家 move 进 .agents，输家 discard，两边都建链', async () => {
    const { plan } = await planFor(
      {
        '.claude/skills/foo/SKILL.md': 'A',
        '.codebuddy/skills/foo/SKILL.md': 'B',
      },
      { 'skills/foo': '.codebuddy' },
    )
    expect(plan.skipped).toEqual([])
    expect(plan.blockedDims).toEqual([])
    const moves = opsOf(plan.ops, 'move')
    expect(moves).toHaveLength(1)
    expect(moves[0].from).toContain('.codebuddy/skills/foo')
    expect(opsOf(plan.ops, 'discard')).toHaveLength(1) // .claude 那份
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(2)
  })

  it('.agents 已有内容且哈希不同 -> .agents 也是候选之一', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'ORIG',
      '.claude/skills/foo/SKILL.md': 'NEW',
    })
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].candidates.map((c) => c.tool).sort()).toEqual(['.agents', '.claude'])
  })

  it('裁决 .agents 赢 -> 不 move，只 discard 工具那份', async () => {
    const { plan } = await planFor(
      {
        '.agents/skills/foo/SKILL.md': 'ORIG',
        '.claude/skills/foo/SKILL.md': 'NEW',
      },
      { 'skills/foo': '.agents' },
    )
    expect(opsOf(plan.ops, 'move')).toHaveLength(0)
    expect(opsOf(plan.ops, 'discard')).toHaveLength(1)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
  })

  it('裁决工具赢、且 .agents 已有 -> 先 discard .agents 那份，再 move 进去', async () => {
    const { plan } = await planFor(
      {
        '.agents/skills/foo/SKILL.md': 'ORIG',
        '.claude/skills/foo/SKILL.md': 'NEW',
      },
      { 'skills/foo': '.claude' },
    )
    const discards = opsOf(plan.ops, 'discard')
    expect(discards).toHaveLength(1)
    expect(discards[0].path).toContain('.agents/skills/foo')
    const moves = opsOf(plan.ops, 'move')
    expect(moves[0].from).toContain('.claude/skills/foo')
    // discard 必须排在 move 前面，否则 move 的目标位置被占着
    expect(plan.ops.indexOf(discards[0])).toBeLessThan(plan.ops.indexOf(moves[0]))
  })

  it('absent 的维度 -> 只建链，不 move', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/settings.json': '{}',
    })
    expect(opsOf(plan.ops, 'move')).toHaveLength(0)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
  })

  it('drifted -> unlink 旧链 + symlink 新链', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      'elsewhere/keep.md': 'y',
      '.claude/skills': { symlink: '../elsewhere' },
    })
    expect(opsOf(plan.ops, 'unlink')).toHaveLength(1)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
  })

  it('linked -> 无 op（幂等）', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    expect(plan.ops).toEqual([])
  })

  it('op 顺序：mkdir -> move/discard -> rmdir/unlink -> symlink', async () => {
    const { plan } = await planFor({ '.claude/skills/foo/SKILL.md': 'x' })
    const rank: Record<Op['t'], number> = {
      mkdir: 0,
      discard: 1,
      move: 1,
      rmdir: 2,
      unlink: 2,
      symlink: 3,
    }
    const order = plan.ops.map((o) => rank[o.t])
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThanOrEqual(order[i - 1])
    }
  })

  // WHY: 回归。ops 为空有两种含义 ——「真的已经统一了」和「全被未裁决的冲突挡住了」。
  // 早先版本对后者也说「已经是统一状态，无需变更」，等于告诉用户一切正常，
  // 而事实是一件事都没干成。静默地什么都不做、还报成功，是这个工具最不该有的行为。
  it('全部被冲突挡住时，绝不说「已经是统一状态」', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    expect(plan.ops).toEqual([]) // 确实什么都不做
    expect(plan.skipped).toHaveLength(1) // 但不是因为没事可做
    expect(plan.benefits.join('\n')).not.toContain('已经是统一状态')
    expect(plan.benefits.join('\n')).not.toContain('无需变更')
  })

  it('真的已经统一时，才说「已经是统一状态」', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    expect(plan.ops).toEqual([])
    expect(plan.skipped).toEqual([])
    expect(plan.benefits.join('\n')).toContain('已经是统一状态')
  })

  it('工作区不干净 -> 产生风险提示', async () => {
    // 临时目录不是 git 仓库 -> gitClean=false
    const { plan } = await planFor({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(plan.risks.join('\n')).toContain('工作区')
  })

  // WHY: 整个 .claude 是一条指向别处的软链时，它下面的 skills/foo 属于软链另一头那个仓库。
  // 一旦给它发 op，move 就会把别的仓库的文件搬走 —— 用户从没同意过我们碰那个仓库。
  // 这是「只显示、不收敛」这条界线上唯一真正危险的失败模式。
  it('整个工具目录是软链 -> 一个 op 都不发给它', async () => {
    const { plan } = await planFor({
      'elsewhere/skills/foo/SKILL.md': 'x',
      '.claude': { symlink: 'elsewhere' },
    })
    expect(plan.ops).toEqual([])
  })
})
