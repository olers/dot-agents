import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildLinkPlan } from '../../src/cli/render.js'
import { applyPlan } from '../../src/core/apply.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

describe('buildLinkPlan', () => {
  // WHY: link 是给 clone 仓库的人跑的「安装」命令。它绝不能碰用户已有的内容 ——
  // 一个新人 clone 下来跑一句 link，结果自己的 .claude/skills 被吞了，这个工具就没人敢用了。
  it('绝不产生 move / discard，只建软链', async () => {
    const root = await mkRepo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills/mine/SKILL.md': 'MINE', // 用户自己的东西
    })
    roots.push(root)
    const plan = buildLinkPlan(await scan(root))
    expect(plan.ops.filter((o) => o.t === 'move')).toHaveLength(0)
    expect(plan.ops.filter((o) => o.t === 'discard')).toHaveLength(0)
    // .claude/skills 是 real 且非空 -> 不能盖，跳过
    expect(plan.ops.filter((o) => o.t === 'symlink')).toHaveLength(0)
  })

  it('absent 的维度 -> 建链', async () => {
    const root = await mkRepo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/settings.json': '{}',
    })
    roots.push(root)
    const plan = buildLinkPlan(await scan(root))
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
  })

  it('幂等：已 linked 的不重复建', async () => {
    const root = await mkRepo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    roots.push(root)
    expect(buildLinkPlan(await scan(root)).ops).toEqual([])
  })
})
