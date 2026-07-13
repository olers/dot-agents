import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { parseDesc, readDesc } from '../../src/core/meta.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

let root = ''
afterEach(async () => {
  if (root) await cleanupRepo(root)
  root = ''
})

describe('parseDesc', () => {
  it('裸值', () => {
    expect(parseDesc('---\nname: foo\ndescription: 收敛点目录\n---\n正文')).toBe('收敛点目录')
  })

  it('双引号 / 单引号都要剥掉 —— 引号是 YAML 的语法，不是描述的一部分', () => {
    expect(parseDesc('---\ndescription: "带引号"\n---\n')).toBe('带引号')
    expect(parseDesc("---\ndescription: '带引号'\n---\n")).toBe('带引号')
  })

  // WHY: skill 的 description 是写给模型做路由的，块标量多行是最常见的写法。
  // 不支持它，一大半真实 skill 会显示成空白。
  it('块标量 >- 的多行值，折成一行', () => {
    const t = '---\ndescription: >-\n  第一行\n  第二行\n---\n'
    expect(parseDesc(t)).toBe('第一行 第二行')
  })

  it('plain scalar 的缩进续行也算它的值', () => {
    const t = '---\ndescription: 第一行\n  第二行\nname: foo\n---\n'
    expect(parseDesc(t)).toBe('第一行 第二行')
  })

  it('下一个顶格 key 一到，description 就到此为止', () => {
    const t = '---\ndescription: 只有这句\nname: foo\nlicense: MIT\n---\n'
    expect(parseDesc(t)).toBe('只有这句')
  })

  it('没有 frontmatter -> undefined', () => {
    expect(parseDesc('# 标题\n正文')).toBeUndefined()
  })

  it('有 frontmatter 但没有 description -> undefined', () => {
    expect(parseDesc('---\nname: foo\n---\n')).toBeUndefined()
  })

  // WHY: 一个畸形 YAML 不能崩掉整个 scan —— 那会让用户连图都打不开。
  it('只有开头的 --- 没有闭合 -> undefined，不抛异常', () => {
    expect(parseDesc('---\ndescription: 悬着的\n没有闭合')).toBeUndefined()
  })

  it('超长的截断到 500 字加省略号', () => {
    const long = 'x'.repeat(900)
    const v = parseDesc(`---\ndescription: ${long}\n---\n`)!
    expect(v).toHaveLength(501)
    expect(v.endsWith('…')).toBe(true)
  })

  // WHY: 开头那行用 trim() 判断 '---'，闭合行如果只用精确匹配，
  // 两边不一致 —— 尾部带空格的合法闭合行会被误判成"没有闭合"。
  it('闭合的 --- 尾部带空格，也要认得出来', () => {
    expect(parseDesc('---\ndescription: 带尾空格的闭合\n---  \n正文')).toBe('带尾空格的闭合')
  })
})

describe('readDesc', () => {
  it('目录条目读它的 SKILL.md', async () => {
    root = await mkRepo({ '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n' })
    expect(await readDesc(join(root, '.claude/skills/foo'), true)).toBe('我是 foo')
  })

  it('目录条目没有 SKILL.md -> undefined，不抛异常', async () => {
    root = await mkRepo({ '.claude/skills/foo/other.md': 'x' })
    expect(await readDesc(join(root, '.claude/skills/foo'), true)).toBeUndefined()
  })

  it('文件条目读它自己（commands / agents 就是单个 .md）', async () => {
    root = await mkRepo({ '.claude/commands/go.md': '---\ndescription: 走你\n---\n' })
    expect(await readDesc(join(root, '.claude/commands/go.md'), false)).toBe('走你')
  })

  it('hooks 里的脚本没有 frontmatter -> undefined', async () => {
    root = await mkRepo({ '.claude/hooks/h.sh': '#!/bin/sh\necho hi\n' })
    expect(await readDesc(join(root, '.claude/hooks/h.sh'), false)).toBeUndefined()
  })
})
