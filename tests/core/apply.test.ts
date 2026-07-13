import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { applyPlan } from '../../src/core/apply.js'
import { pathKind } from '../../src/core/fsx.js'
import { mkRepo, cleanupRepo, type Layout } from '../helpers/mkrepo.js'
import type { Resolutions } from '../../src/core/types.js'

const run = promisify(execFile)

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function setup(layout: Layout, resolutions: Resolutions = {}) {
  const root = await mkRepo(layout)
  roots.push(root)
  const plan = buildPlan(await scan(root), resolutions)
  return { root, plan }
}

describe('applyPlan', () => {
  it('工作区不干净且未 --force -> 拒绝执行，且一个文件都没动', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(plan.gitClean).toBe(false) // 临时目录不是 git 仓库
    const res = await applyPlan(plan)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('工作区')
    // 原文件必须原封不动
    expect(await pathKind(join(root, '.claude/skills/foo'))).toBe('dir')
    expect(await pathKind(join(root, '.agents'))).toBe('missing')
  })

  it('--force 下正常执行：move + symlink', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)

    expect(await readFile(join(root, '.agents/skills/foo/SKILL.md'), 'utf8')).toBe('x')
    expect(await pathKind(join(root, '.claude/skills'))).toBe('symlink')
    // WHY: 相对路径。绝对路径的软链换台机器就废，也没法提交进 git。
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')
    // 穿过软链能读到内容 —— 这才是「接上了」的真正证据
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
  })

  // WHY: .claude 常被 gitignore，git 救不回来。attic 是唯一的后悔药，所以它必须无条件存在。
  it('被 discard 的内容一定进了 attic 备份', async () => {
    const { plan } = await setup({
      '.claude/skills/foo/SKILL.md': 'same',
      '.codebuddy/skills/foo/SKILL.md': 'same',
    })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)
    const backed = join(res.atticDir, 'backup/.codebuddy/skills/foo/SKILL.md')
    expect(await readFile(backed, 'utf8')).toBe('same')
  })

  // WHY: 半成品状态（源目录已删、软链还没建）会让这个仓库的 agent 配置直接消失。
  // 用户下次打开 IDE 会发现所有 skill 都不见了，而且不知道为什么。宁可什么都不做。
  it('执行中途失败 -> 完全回滚，回到执行前的状态', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })

    // 注入一个必然失败的 op：往一个不存在的深层路径建软链
    plan.ops.push({ t: 'symlink', path: join(root, 'no/such/dir/link'), target: '../x' })

    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(false)

    // 全部回到原样
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
    expect(await pathKind(join(root, '.claude/skills'))).toBe('dir') // 不是 symlink
    expect(await pathKind(join(root, '.agents/skills/foo'))).toBe('missing')
  })

  // WHY: gitignore 场景下 undo.sh 是唯一的后悔药。它必须真的能跑，不是摆设。
  it('undo.sh 可执行，且能把仓库还原到 apply 前', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)

    const st = await stat(res.undoScript)
    expect(st.mode & 0o111).toBeTruthy() // 有执行位

    await run('sh', [res.undoScript])

    expect(await pathKind(join(root, '.claude/skills'))).toBe('dir')
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
    expect(await pathKind(join(root, '.agents/skills/foo'))).toBe('missing')
  })

  // WHY: 非幂等会导致重复运行时破坏已经建好的软链。这个命令一定会被重复运行。
  it('幂等：apply 两次，第二次的 plan 是空的', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    expect((await applyPlan(plan, { force: true })).ok).toBe(true)

    const plan2 = buildPlan(await scan(root), {})
    expect(plan2.ops).toEqual([])
  })

  // WHY: attic 是本地的后悔药，不是仓库内容。不忽略它，用户就会把「被删掉的重复副本」
  // 提交进 git —— 体积大、纯噪音，而且下次 clone 的人还会以为那是有效配置。
  it('apply 会把 .agents/.attic/ 写进 .gitignore（幂等，不重复追加）', async () => {
    const { root, plan } = await setup({
      '.claude/skills/foo/SKILL.md': 'x',
      '.gitignore': 'node_modules/\n',
    })
    expect((await applyPlan(plan, { force: true })).ok).toBe(true)

    const gi = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gi).toContain('node_modules/') // 原有内容不能被吞掉
    expect(gi).toContain('.agents/.attic/')

    // 再跑一次（哪怕是空 plan）也不该重复追加
    const plan2 = buildPlan(await scan(root), {})
    await applyPlan({ ...plan2, ops: [{ t: 'mkdir', path: join(root, '.agents/skills') }] }, { force: true })
    const gi2 = await readFile(join(root, '.gitignore'), 'utf8')
    expect(gi2.split('\n').filter((l) => l.trim() === '.agents/.attic/')).toHaveLength(1)
  })

  it('没有 .gitignore 时会创建一个', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    expect((await applyPlan(plan, { force: true })).ok).toBe(true)
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.agents/.attic/')
  })

  it('未裁决冲突 -> 相关目录保持原样，不建链', async () => {
    const { root, plan } = await setup({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)
    expect(await pathKind(join(root, '.claude/skills'))).toBe('dir')
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('A')
    expect(await readFile(join(root, '.codebuddy/skills/foo/SKILL.md'), 'utf8')).toBe('B')
  })
})
