import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, symlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { peekFile, MAX_PEEK } from '../../src/core/peek.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

let root = ''
afterEach(async () => {
  if (root) await cleanupRepo(root)
  root = ''
})

/** 每条用例都在同一个仓库布局上跑 —— 差别只在请求哪个路径。 */
async function repo() {
  root = await mkRepo({
    '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n正文',
    '.claude/settings.json': '{"secret":1}',
    '.agents/commands/go.md': 'go',
    'package.json': '{"name":"victim"}',
    'secret.txt': 'TOP SECRET',
  })
  return root
}

const peek = (p: string) => peekFile([root], p)

describe('peekFile · 能读什么', () => {
  it('维度目录下的文件：读得到', async () => {
    await repo()
    const r = await peek(join(root, '.claude/skills/foo/SKILL.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.peek.content).toContain('我是 foo')
      expect(r.peek.binary).toBe(false)
      expect(r.peek.truncated).toBe(false)
    }
  })

  it('唯一源里的文件：一样读得到', async () => {
    await repo()
    const r = await peek(join(root, '.agents/commands/go.md'))
    expect(r.ok).toBe(true)
  })
})

describe('peekFile · 白名单', () => {
  // WHY: 这是整组测试里最重要的一条。白名单一旦退化成「只要在 repoRoot 之下就行」，
  // 这条就会变成 200 —— 那等于在 localhost 上开了个任意文件读取接口。
  it('仓库里但不在任何维度下的文件 -> 403', async () => {
    await repo()
    expect(await peek(join(root, 'package.json'))).toEqual({ ok: false, code: 403 })
  })

  // WHY: .claude/settings.json 是「工具专属，不碰」的东西，图上根本不展示它的内容。
  // 图上看不见的，接口也不该给读 —— 两边的视野必须一致。
  it('点目录下但不在维度下的文件（settings.json）-> 403', async () => {
    await repo()
    expect(await peek(join(root, '.claude/settings.json'))).toEqual({ ok: false, code: 403 })
  })

  it('路径遍历 -> 403', async () => {
    await repo()
    const evil = join(root, '.claude/skills/../../../etc/passwd')
    expect((await peek(evil)).ok).toBe(false)
  })

  // WHY: 前缀不以路径分隔符结尾时，`<root>/.claude/skillsEVIL/` 会命中
  // `<root>/.claude/skills` 这个前缀，白名单就漏了。
  it('前缀伪造：.claude/skillsEVIL/ -> 403', async () => {
    await repo()
    await mkdir(join(root, '.claude/skillsEVIL'), { recursive: true })
    await writeFile(join(root, '.claude/skillsEVIL/x.md'), 'leak', 'utf8')
    expect(await peek(join(root, '.claude/skillsEVIL/x.md'))).toEqual({ ok: false, code: 403 })
  })

  // WHY: 维度目录里的软链是用户数据（scan 把它记成 residue.symlink，不当条目、不连线）。
  // 跟着它走出白名单，就是把「不管理」变成了「可以读」。realpath 之后必须掉出去。
  it('软链逃逸出白名单 -> 403', async () => {
    await repo()
    await symlink(join(root, 'secret.txt'), join(root, '.claude/skills/evil'))
    expect(await peek(join(root, '.claude/skills/evil'))).toEqual({ ok: false, code: 403 })
  })

  it('相对路径 -> 403', async () => {
    await repo()
    expect(await peek('.claude/skills/foo/SKILL.md')).toEqual({ ok: false, code: 403 })
  })

  it('空路径 -> 403', async () => {
    await repo()
    expect(await peek('')).toEqual({ ok: false, code: 403 })
  })

  it('目录不给读 -> 403', async () => {
    await repo()
    expect(await peek(join(root, '.claude/skills/foo'))).toEqual({ ok: false, code: 403 })
  })

  it('不存在 -> 404', async () => {
    await repo()
    expect(await peek(join(root, '.claude/skills/foo/NOPE.md'))).toEqual({ ok: false, code: 404 })
  })

  // WHY: 生产环境的 repoRoot 来自 findRepoRoot()，它只 resolve 不 realpath。
  // 如果仓库路径上有一段软链（macOS 的 /tmp -> /private/tmp 就是），
  // realpath(请求路径) 和拼出来的前缀会对不上，合法请求被误判成 403。
  it('roots 自己带软链时，合法请求照样 200', async () => {
    await repo()
    const alias = join(dirname(root), `alias-${Date.now()}`)
    await symlink(root, alias)
    const r = await peekFile([alias], join(alias, '.claude/skills/foo/SKILL.md'))
    expect(r.ok).toBe(true)
  })
})

describe('peekFile · 内容', () => {
  it('含 NUL 的文件判定为二进制，不返回内容', async () => {
    await repo()
    const p = join(root, '.claude/skills/foo/blob.bin')
    await writeFile(p, Buffer.from([0x01, 0x00, 0x02]))
    const r = await peek(p)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.peek.binary).toBe(true)
      expect(r.peek.content).toBe('')
    }
  })

  it('超过 MAX_PEEK 的文件：截断，并明说截断了', async () => {
    await repo()
    const p = join(root, '.claude/skills/foo/big.md')
    await writeFile(p, 'a'.repeat(MAX_PEEK + 1000), 'utf8')
    const r = await peek(p)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.peek.truncated).toBe(true)
      expect(r.peek.content).toHaveLength(MAX_PEEK)
      expect(r.peek.size).toBe(MAX_PEEK + 1000)
    }
  })
})
