import { describe, it, expect, afterEach } from 'vitest'
import { scan } from '../../src/core/scan.js'
import { mkRepo, cleanupRepo, type Layout } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function repo(layout: Layout) {
  const r = await mkRepo(layout)
  roots.push(r)
  return r
}

describe('scan', () => {
  // WHY: 状态判错 -> plan 就会算错 -> apply 会破坏用户文件。这是整条链的地基。
  it('real: 工具目录下有真实内容', async () => {
    const r = await repo({ '.claude/skills/foo/SKILL.md': 'x' })
    const s = await scan(r)
    const st = s.tools['.claude'].dims.skills!
    expect(st.kind).toBe('real')
    expect(st.kind === 'real' && st.entries.map((e) => e.name)).toEqual(['foo'])
  })

  it('absent: 工具目录存在但没有该维度', async () => {
    const r = await repo({ '.claude/settings.json': '{}' })
    const s = await scan(r)
    expect(s.tools['.claude'].dims.skills!.kind).toBe('absent')
  })

  it('linked: 已软链到 .agents 的对应维度', async () => {
    const r = await repo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    const s = await scan(r)
    expect(s.tools['.claude'].dims.skills!.kind).toBe('linked')
  })

  // WHY: drifted 是「看起来已经接好了，其实指向别处」。当成 linked 处理会让用户以为统一了，
  // 实际两边内容完全不同 —— 这是最难自己发现的失败模式。
  it('drifted: 是软链但指向别处', async () => {
    const r = await repo({
      '.agents/skills/foo/SKILL.md': 'x',
      'elsewhere/skills/bar/SKILL.md': 'y',
      '.claude/skills': { symlink: '../elsewhere/skills' },
    })
    const s = await scan(r)
    const st = s.tools['.claude'].dims.skills!
    expect(st.kind).toBe('drifted')
    expect(st.kind === 'drifted' && st.actualTarget).toContain('elsewhere/skills')
  })

  // WHY: 白名单回答的是「哪个要收敛」，不是「这个仓库里有什么」。
  // 拿白名单当枚举器，没进白名单的点目录就整个从「现状」里消失了 —— 而它在磁盘上躺着。
  // 不收敛它是对的；不告诉用户它存在，是 bug。
  it('白名单外的点目录进 strangers —— 不收敛，但必须看得见', async () => {
    const r = await repo({ '.vscode/settings.json': '{}', '.superpowers/sdd/x.md': 'y' })
    const s = await scan(r)

    expect(s.tools['.vscode']).toBeUndefined()
    expect(s.strangers.map((x) => x.name).sort()).toEqual(['.superpowers', '.vscode'])
  })

  // WHY: .git 和 .agents 不是 Agent 工具目录。把它们列进「不认识的点目录」是噪声，
  // 会淹掉真正需要用户注意的那几个。
  it('.git 和 .agents 不算点目录', async () => {
    const r = await repo({ '.git/config': '', '.agents/skills/foo/SKILL.md': 'x' })
    const s = await scan(r)
    expect(s.strangers).toEqual([])
  })

  // WHY: worktree 里 `.claude -> ../.agents` 这种整目录软链很常见。
  // 老代码在这里 `pathKind !== 'dir' -> continue`，整个 .claude 从 state 里蒸发 ——
  // 用户在图上找不到自己的 .claude，会以为工具没看见它。
  it('整个工具目录是软链：认出来，标成 symlink，不进去看', async () => {
    const r = await repo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude': { symlink: '.agents' },
    })
    const s = await scan(r)
    const t = s.tools['.claude']

    expect(t).toBeDefined()
    expect(t.kind).toBe('symlink')
    expect(t.target).toContain('.agents')
    // 不进去看 = 不会把软链另一头的条目当成「本仓库 .claude 里的待收录内容」
    expect(t.dims).toEqual({})
    expect(t.only).toEqual([])
  })

  // WHY: 沉默地不处理 = bug。用户必须能看到「工具看见了 rules/ 和 settings.json，但故意没动」。
  it('only 列出所有不碰的东西（含 rules/），软链带上目标', async () => {
    const r = await repo({
      '.claude/settings.json': '{}',
      '.cursor/rules/foo.mdc': 'x',
      '.codebuddy/rules': { symlink: '../elsewhere' },
      'elsewhere/x.md': 'z',
      '.claude/skills/foo/SKILL.md': 'y',
    })
    const s = await scan(r)
    const names = (tool: string) => s.tools[tool].only.map((f) => f.name)

    expect(names('.claude')).toContain('settings.json')
    expect(names('.cursor')).toContain('rules')
    // skills 是被管理的维度，不该出现在 only 里
    expect(names('.claude')).not.toContain('skills')

    // 只报名字，用户看不出这个 rules 指向另一个仓库
    const rules = s.tools['.codebuddy'].only.find((f) => f.name === 'rules')!
    expect(rules.kind).toBe('symlink')
    expect(rules.target).toContain('elsewhere')
  })

  // WHY: .codex 只有 environments/，一个受管维度都没有。它照样是一个真实存在的点目录。
  it('一个受管维度都没有的工具目录，照样在 state 里', async () => {
    const r = await repo({ '.codex/environments/e.json': '{}' })
    const s = await scan(r)
    expect(s.tools['.codex'].kind).toBe('dir')
    expect(s.tools['.codex'].only.map((f) => f.name)).toEqual(['environments'])
  })

  it('.agents 的条目被收进 agentsDir.entries', async () => {
    const r = await repo({ '.agents/skills/foo/SKILL.md': 'x', '.agents/commands/c.md': 'y' })
    const s = await scan(r)
    expect(s.agentsDir.exists).toBe(true)
    expect(s.agentsDir.entries.skills.map((e) => e.name)).toEqual(['foo'])
    expect(s.agentsDir.entries.commands.map((e) => e.name)).toEqual(['c.md'])
  })
})
