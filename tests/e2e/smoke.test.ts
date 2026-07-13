import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { applyPlan } from '../../src/core/apply.js'
import { pathKind } from '../../src/core/fsx.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

describe('端到端', () => {
  // WHY: 单元测试各自绿了不代表串起来是对的。这条覆盖一个真实仓库的完整形态：
  // 有重复、有冲突、有工具专属 —— 一次跑完必须落到设计文档描述的达成态。
  it('混合场景：重复去重 + 冲突裁决 + 工具专属不碰 + 幂等', async () => {
    const root = await mkRepo({
      // .claude 和 .codebuddy 有一份完全相同的 shared -> 去重，不该报冲突
      '.claude/skills/shared/SKILL.md': 'SAME',
      '.codebuddy/skills/shared/SKILL.md': 'SAME',
      // 同名不同内容 -> 冲突，要裁决
      '.claude/skills/dup/SKILL.md': 'FROM-CLAUDE',
      '.codebuddy/skills/dup/SKILL.md': 'FROM-CODEBUDDY',
      // 只有 .claude 有的
      '.claude/commands/only.md': 'ONLY',
      // 工具专属，绝不能碰
      '.claude/settings.json': '{"a":1}',
      '.cursor/rules/x.mdc': 'RULES',
    })
    roots.push(root)

    const plan = buildPlan(await scan(root), { 'skills/dup': '.codebuddy' })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)

    // 唯一源建立
    expect(await readFile(join(root, '.agents/skills/shared/SKILL.md'), 'utf8')).toBe('SAME')
    expect(await readFile(join(root, '.agents/skills/dup/SKILL.md'), 'utf8')).toBe('FROM-CODEBUDDY')
    expect(await readFile(join(root, '.agents/commands/only.md'), 'utf8')).toBe('ONLY')

    // 软链接上，且是相对路径
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')
    expect(await readlink(join(root, '.codebuddy/skills'))).toBe('../.agents/skills')
    // 穿过软链能读到裁决后的内容 —— 这才是「接上了」的真正证据
    expect(await readFile(join(root, '.claude/skills/dup/SKILL.md'), 'utf8')).toBe('FROM-CODEBUDDY')

    // 工具专属原封不动
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe('{"a":1}')
    expect(await readFile(join(root, '.cursor/rules/x.mdc'), 'utf8')).toBe('RULES')

    // 落败的那份进了 attic，没有凭空消失
    expect(await pathKind(join(res.atticDir, 'backup/.claude/skills/dup'))).toBe('dir')

    // 幂等：再算一遍，无事可做
    expect(buildPlan(await scan(root), {}).ops).toEqual([])
  })
})
