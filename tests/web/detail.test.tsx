import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Peek } from '../../src/core/types.js'
import type { EntryRef } from '../../src/web/graph.js'
import { DetailView, defaultFile, fileAbs } from '../../src/web/components/Detail.js'

const dirEntry: EntryRef = {
  key: 'skills/foo',
  dim: 'skills',
  name: 'foo',
  path: '/repo/.claude/skills/foo',
  isDir: true,
  files: ['reference.md', 'SKILL.md'],
  desc: '我是 foo',
  from: '.claude',
}

const fileEntry: EntryRef = {
  key: 'commands/go',
  dim: 'commands',
  name: 'go.md',
  path: '/repo/.claude/commands/go.md',
  isDir: false,
  files: ['go.md'],
  from: '.claude',
}

const ok = (content: string, extra: Partial<Peek> = {}): Peek => ({
  path: '/x',
  content,
  size: content.length,
  truncated: false,
  binary: false,
  ...extra,
})

const view = (p: Partial<Parameters<typeof DetailView>[0]>) =>
  renderToStaticMarkup(
    <DetailView
      entry={dirEntry}
      file="SKILL.md"
      peek={null}
      loading={false}
      err={null}
      onPick={() => {}}
      onClose={() => {}}
      {...p}
    />,
  )

describe('defaultFile', () => {
  // WHY: SKILL.md 就是这个条目的门面。点开侧栏先看到 reference.md，等于还得再点一次。
  it('有 SKILL.md 就先看它，不管它排第几', () => {
    expect(defaultFile(['reference.md', 'SKILL.md'])).toBe('SKILL.md')
  })
  it('没有 SKILL.md 就看第一个', () => {
    expect(defaultFile(['a.md', 'b.md'])).toBe('a.md')
  })
  it('一个文件都没有 -> undefined', () => {
    expect(defaultFile([])).toBeUndefined()
  })
})

describe('fileAbs', () => {
  it('目录条目：拼子路径', () => {
    expect(fileAbs(dirEntry, 'SKILL.md')).toBe('/repo/.claude/skills/foo/SKILL.md')
  })
  // WHY: 单文件条目的 path 本身就是那个文件。再拼一次 basename 会得到
  // /repo/.claude/commands/go.md/go.md —— 必然 404。
  it('单文件条目：path 就是它自己，不再拼', () => {
    expect(fileAbs(fileEntry, 'go.md')).toBe('/repo/.claude/commands/go.md')
  })
})

describe('DetailView', () => {
  it('画出条目名、来源、绝对路径、描述、文件清单', () => {
    const html = view({ peek: ok('# Foo') })
    expect(html).toContain('foo')
    expect(html).toContain('.claude')
    expect(html).toContain('/repo/.claude/skills/foo')
    expect(html).toContain('我是 foo')
    expect(html).toContain('SKILL.md')
    expect(html).toContain('reference.md')
    expect(html).toContain('# Foo')
  })

  it('没有描述时明说没有，不留一片空白', () => {
    const html = view({ entry: fileEntry, file: 'go.md', peek: ok('go') })
    expect(html).toContain('无 frontmatter 描述')
  })

  it('加载中 / 出错各有状态，不白屏', () => {
    expect(view({ loading: true })).toContain('加载中')
    expect(view({ err: '/api/file -> 403' })).toContain('403')
  })

  // WHY: 二进制 toString 出来是一屏替换字符。明说「是二进制」比装作能显示要诚实。
  it('二进制：明说不展示', () => {
    const html = view({ peek: ok('', { binary: true }) })
    expect(html).toContain('二进制')
  })

  // WHY: 截断了不说，用户会以为他看到的就是全部 —— 那是在撒谎。
  it('截断了必须说出来', () => {
    const html = view({ peek: ok('a'.repeat(10), { truncated: true, size: 999999 }) })
    expect(html).toContain('已截断')
  })

  // WHY: 两个文件按钮长得一样，不标出「你正在看哪个」，用户点了几下就不知道自己在哪儿了。
  it('当前查看的文件是选中态，别的不是', () => {
    const html = view({ file: 'SKILL.md', peek: ok('x') })
    expect(html).toContain('<button class="dfile" aria-pressed="true" type="button">SKILL.md</button>')
    expect(html).toContain(
      '<button class="dfile" aria-pressed="false" type="button">reference.md</button>',
    )
  })
})
