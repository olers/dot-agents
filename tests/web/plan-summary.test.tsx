import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Change } from '../../src/core/types.js'
import { PlanSummary, planOutcome, ctaLabel } from '../../src/web/components/PlanSummary.js'
import { ResultView } from '../../src/web/components/ResultView.js'

const ROOT = '/repo'

const linkChange = (over: Partial<Change> = {}): Change => ({
  key: '.codex/skills',
  tool: '.codex',
  dim: 'skills',
  title: '.codex / skills',
  kind: 'link',
  before: '未接入（没有这个维度目录）',
  after: '软链 → ../.agents/skills',
  target: '../.agents/skills',
  reason: '接上唯一源；以后在任意工具目录里改动，都会写回同一处。',
  destructive: false,
  ops: [{ t: 'symlink', path: '/repo/.codex/skills', target: '../.agents/skills' }],
  ...over,
})

const clearChange = (): Change =>
  linkChange({
    key: '.codex/hooks',
    dim: 'hooks',
    title: '.codex / hooks',
    kind: 'clear',
    before: '空目录',
    after: '软链 → ../.agents/hooks',
    reason: '目录是空的，先删掉这个空壳才能换成软链；没有你的内容被删除。',
    ops: [
      { t: 'rmdir', path: '/repo/.codex/hooks' },
      { t: 'symlink', path: '/repo/.codex/hooks', target: '../.agents/hooks' },
    ],
  })

const loserChange = (): Change =>
  linkChange({
    key: '.claude/skills',
    tool: '.claude',
    title: '.claude / skills',
    kind: 'adopt',
    before: '本地有 1 个条目',
    after: '软链 → ../.agents/skills',
    reason: '同名条目内容不同，这份在你的裁决里落败：备份到 .attic 后删除。',
    destructive: true,
    ops: [
      { t: 'discard', path: '/repo/.claude/skills/foo' },
      { t: 'rmdir', path: '/repo/.claude/skills' },
      { t: 'symlink', path: '/repo/.claude/skills', target: '../.agents/skills' },
    ],
  })

const blockedChange = (): Change => ({
  key: '.claude/skills',
  tool: '.claude',
  dim: 'skills',
  title: '.claude / skills',
  kind: 'blocked',
  before: '本地有 1 个条目',
  after: '保持原样，不接软链',
  reason: '该维度下有未裁决的冲突条目。软链是目录级的，只要还有一个条目留在原地，整个目录就不能替换成软链。',
  blockedReason: '有未裁决的冲突',
  destructive: false,
  ops: [],
})

const html = (changes: Change[]) =>
  renderToStaticMarkup(<PlanSummary changes={changes} repoRoot={ROOT} />)

describe('planOutcome —— 结果陈述数的是可执行变更', () => {
  // WHY: 验收 fixture 的真相是「2 项变更」，不是 3 个操作。数错 = UI 在撒谎。
  it('两项非破坏变更 -> 说 2 个、没有内容被删', () => {
    const s = planOutcome([linkChange(), clearChange()])
    expect(s).toContain('2 个工具维度')
    expect(s).toContain('没有内容被删除')
  })
  it('有破坏性变更 -> 点出「移动或删除内容」', () => {
    const s = planOutcome([linkChange(), loserChange()])
    expect(s).toContain('移动或删除内容')
  })
  // WHY: 全被冲突挡住时绝不能说「已经统一」—— 那会让用户以为一切正常。
  it('只有 blocked -> 不说「已统一」，点出暂不执行', () => {
    const s = planOutcome([blockedChange()])
    expect(s).not.toContain('已经是统一状态')
    expect(s).toContain('暂不执行')
  })
  it('真的没有任何变更 -> 说已统一', () => {
    expect(planOutcome([])).toContain('已经是统一状态')
  })
})

describe('ctaLabel —— 按钮文案用语义变更数', () => {
  it('有变更 -> 「收敛 N 项变更」', () => {
    expect(ctaLabel(2)).toBe('收敛 2 项变更')
  })
  it('无变更 -> 「无需变更」', () => {
    expect(ctaLabel(0)).toBe('无需变更')
  })
})

describe('PlanSummary —— 每项变更答清 what / why / after / safety', () => {
  it('画出标题、现状→执行后、原因、安全徽标', () => {
    const out = html([linkChange()])
    expect(out).toContain('.codex / skills') // what（哪个维度）
    expect(out).toContain('未接入') // before
    expect(out).toContain('../.agents/skills') // after 目标（软链 chip）
    expect(out).toContain('接上唯一源') // why
    expect(out).toContain('不删除内容') // safety
  })

  // WHY: 破坏性动作必须一眼可见，不能藏在 hover 里。
  it('破坏性变更标「移动/删除内容 · 已备份」', () => {
    const out = html([loserChange()])
    expect(out).toContain('移动/删除内容 · 已备份')
  })

  // WHY: 技术细节要能展开看到每一个原子操作，否则「回执」是不完整的。
  it('技术细节展开列出原子操作', () => {
    const out = html([clearChange()])
    expect(out).toContain('技术细节')
    expect(out).toContain('删空壳 .codex/hooks/')
    expect(out).toContain('建软链 .codex/hooks → ../.agents/hooks')
  })

  // WHY: 被冲突挡住的维度真实存在，必须列出来 + 写原因，不能藏。
  it('blocked 变更单独成组、写出原因，且不进主列表', () => {
    const out = html([linkChange(), blockedChange()])
    expect(out).toContain('需要先裁决')
    expect(out).toContain('有未裁决的冲突')
  })
})

describe('ResultView —— 成功文案先报语义变更', () => {
  const ok = {
    ok: true as const,
    atticDir: '/repo/.agents/.attic/2026',
    undoScript: '/repo/.agents/.attic/2026/undo.sh',
    applied: [
      { t: 'rmdir' as const, path: '/repo/.codex/hooks' },
      { t: 'symlink' as const, path: '/repo/.codex/hooks', target: '../.agents/hooks' },
      { t: 'symlink' as const, path: '/repo/.codex/skills', target: '../.agents/skills' },
    ],
  }
  it('先报「N 项变更」，原子操作数退成技术旁注', () => {
    const out = renderToStaticMarkup(<ResultView result={ok} linkCount={2} changeCount={2} />)
    expect(out).toContain('2 项变更')
    expect(out).toContain('3 个原子操作') // 仍诚实报出底层步数，但不是主角
  })
})
