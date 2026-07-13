import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { applyPlan } from '../../src/core/apply.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

let root = ''
afterEach(async () => {
  if (root) await cleanupRepo(root)
  root = ''
})

/**
 * 维度目录里的「残留物」—— scan 不把它当条目，但它真实存在。
 *
 * rmdir 是非递归的，它假设「plan 已经把这个目录清空了」。
 * 只要 scan 有任何一种「跳过」，这个假设就破了，apply 会在 rmdir 上炸 ENOTEMPTY。
 * 跳过 = 沉默地不处理 = bug。每个直接子项都必须有明确归属。
 */
describe('维度目录里的残留物', () => {
  it('.DS_Store 不会让 apply 炸在 rmdir 上，而且它被备份了', async () => {
    root = await mkRepo({
      '.claude/skills/caveman/SKILL.md': 'caveman',
      '.claude/skills/.DS_Store': 'macOS 的垃圾',
    })

    const plan = buildPlan(await scan(root), {})
    const result = await applyPlan(plan, { force: true })

    // 之前这里是 ENOTEMPTY: directory not empty, rmdir '.../.claude/skills'
    expect(result.error).toBeUndefined()
    expect(result.ok).toBe(true)

    // skills/ 换成了软链
    expect((await lstat(join(root, '.claude/skills'))).isSymbolicLink()).toBe(true)
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')

    // 删之前必须备份。这个工具对用户的承诺是「删除前全部备份」——
    // 垃圾文件也一样，不能因为「我觉得它不重要」就破例。
    const backed = join(result.atticDir, 'backup', '.claude/skills/.DS_Store')
    expect(await readFile(backed, 'utf8')).toBe('macOS 的垃圾')
  })

  it('条目级软链会挡住整个维度，绝不被沉默删除', async () => {
    root = await mkRepo({
      '.claude/skills/caveman/SKILL.md': 'caveman',
      '外部/真身/SKILL.md': '不在管理范围内的东西',
      '.claude/skills/借来的': { symlink: '../../外部/真身' },
    })

    const plan = buildPlan(await scan(root), {})

    // 软链是目录级的：skills/ 里还有个 dot-agents 不认识的条目，
    // 整个 skills/ 就不能被替换成软链 —— 否则那个软链会被连带删掉。
    const blocked = plan.blockedDims.find((b) => b.tool === '.claude' && b.dim === 'skills')
    expect(blocked).toBeDefined()
    expect(blocked!.reason).toContain('借来的')

    expect(plan.ops.some((o) => o.t === 'rmdir')).toBe(false)
    expect(plan.ops.some((o) => o.t === 'symlink')).toBe(false)

    const result = await applyPlan(plan, { force: true })
    expect(result.ok).toBe(true)

    // 用户的软链原封不动
    expect(await readlink(join(root, '.claude/skills/借来的'))).toBe('../../外部/真身')
  })

  it('残留物必须出现在 plan 里，不能沉默处理', async () => {
    root = await mkRepo({
      '.claude/skills/caveman/SKILL.md': 'caveman',
      '.claude/skills/.DS_Store': '垃圾',
    })

    const plan = buildPlan(await scan(root), {})

    // 它会被删，那它就得出现在操作清单里 —— 用户有权在执行前看见每一个删除。
    expect(
      plan.ops.some((o) => o.t === 'discard' && o.path.endsWith('.claude/skills/.DS_Store')),
    ).toBe(true)
  })

  it('维度本来就被冲突挡住时，不去动它的残留物', async () => {
    root = await mkRepo({
      '.claude/skills/caveman/SKILL.md': 'A',
      '.codebuddy/skills/caveman/SKILL.md': 'B 不一样',
      '.claude/skills/.DS_Store': '垃圾',
    })

    const plan = buildPlan(await scan(root), {})

    // skills/ 因为未裁决的冲突不会变成软链 -> 也就不会 rmdir -> 没有理由去删它的 .DS_Store。
    // 无谓的改动就是噪音，用户会问「我又没让你动这个」。
    expect(plan.ops.some((o) => o.t === 'discard' && o.path.endsWith('.DS_Store'))).toBe(false)
  })
})
