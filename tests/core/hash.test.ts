import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { utimes } from 'node:fs/promises'
import { hashPath, listFiles } from '../../src/core/hash.js'
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

describe('hashPath', () => {
  // WHY: 哈希是「同名不同内容 = 冲突」的唯一判据。两份内容相同的 skill 必须哈希相同，
  // 否则用户会被迫裁决一堆根本没差别的条目，人会开始无脑点确认 —— 那时真冲突也就被点过去了。
  it('内容相同、路径不同的两个目录，哈希相同', async () => {
    const r = await repo({
      'a/foo/SKILL.md': 'hello',
      'a/foo/ref.md': 'world',
      'b/foo/SKILL.md': 'hello',
      'b/foo/ref.md': 'world',
    })
    expect(await hashPath(join(r, 'a/foo'))).toBe(await hashPath(join(r, 'b/foo')))
  })

  // WHY: mtime 每次 checkout / cp 都会变。若 mtime 进哈希，clone 下来的仓库会满屏假冲突。
  it('mtime 不影响哈希', async () => {
    const r = await repo({ 'a/foo/SKILL.md': 'hello', 'b/foo/SKILL.md': 'hello' })
    await utimes(join(r, 'b/foo/SKILL.md'), new Date(0), new Date(0))
    expect(await hashPath(join(r, 'a/foo'))).toBe(await hashPath(join(r, 'b/foo')))
  })

  // WHY: 文件内容一样但文件名不同 = 不同的 skill。只哈希内容会把它们判成相同 → 静默丢一份。
  it('文件名不同 -> 哈希不同', async () => {
    const r = await repo({ 'a/foo/SKILL.md': 'hello', 'b/foo/OTHER.md': 'hello' })
    expect(await hashPath(join(r, 'a/foo'))).not.toBe(await hashPath(join(r, 'b/foo')))
  })

  it('内容不同 -> 哈希不同', async () => {
    const r = await repo({ 'a/foo/SKILL.md': 'hello', 'b/foo/SKILL.md': 'HELLO' })
    expect(await hashPath(join(r, 'a/foo'))).not.toBe(await hashPath(join(r, 'b/foo')))
  })

  it('单个文件条目也能哈希', async () => {
    const r = await repo({ 'a/foo.md': 'hi', 'b/foo.md': 'hi' })
    expect(await hashPath(join(r, 'a/foo.md'))).toBe(await hashPath(join(r, 'b/foo.md')))
  })

  // WHY: 回归。真实的 ~/.agents 里就有悬空软链（指向已删除的文件）。
  // 早先的 walk 把「非目录的 dirent」一律当文件 readFile -> 跟着链走 -> ENOENT -> 整个 scan 崩，
  // 连带 /api/state 500，UI 一片空白。一条悬空软链不该让整个工具打不开。
  it('条目内的悬空软链不会让哈希崩掉', async () => {
    const r = await repo({
      'a/foo/SKILL.md': 'x',
      'a/foo/dangling.md': { symlink: './nowhere-at-all.md' },
    })
    const h = await hashPath(join(r, 'a/foo'))
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(await listFiles(join(r, 'a/foo'))).toEqual(['SKILL.md', 'dangling.md'])
  })

  // WHY: 软链的「内容」在 POSIX 语义下就是它的 target 字符串。指向不同目标 = 不同的东西。
  // 顺带：哈希 target 而不跟着走，软链成环时也不会无限递归。
  it('软链按 target 字符串哈希，target 不同则哈希不同', async () => {
    const r = await repo({
      'a/foo/link': { symlink: './x.md' },
      'b/foo/link': { symlink: './y.md' },
      'c/foo/link': { symlink: './x.md' },
    })
    expect(await hashPath(join(r, 'a/foo'))).not.toBe(await hashPath(join(r, 'b/foo')))
    expect(await hashPath(join(r, 'a/foo'))).toBe(await hashPath(join(r, 'c/foo')))
  })
})

describe('listFiles', () => {
  it('目录 -> 排序后的相对路径清单', async () => {
    const r = await repo({ 'a/foo/z.md': '1', 'a/foo/sub/a.md': '2' })
    expect(await listFiles(join(r, 'a/foo'))).toEqual(['sub/a.md', 'z.md'])
  })

  it('单文件 -> 只含自己的文件名', async () => {
    const r = await repo({ 'a/foo.md': 'hi' })
    expect(await listFiles(join(r, 'a/foo.md'))).toEqual(['foo.md'])
  })
})
