import { createHash } from 'node:crypto'
import { readFile, readdir, readlink } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { pathKind } from './fsx.js'

/**
 * 递归收集 (相对路径, 内容)，排序后喂给 sha256。忽略 mtime / 权限。
 *
 * 软链按 target 字符串哈希，不跟着走：
 * - POSIX 语义下软链的「内容」本来就是它的 target 字符串
 * - 悬空软链（指向已删除的文件）跟着走会 ENOENT，一条就能崩掉整个 scan
 * - 软链成环时跟着走会无限递归
 */
async function walk(root: string, rel: string, out: Array<[string, Buffer]>): Promise<void> {
  const abs = rel ? join(root, rel) : root
  const entries = await readdir(abs, { withFileTypes: true })
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === '.DS_Store') continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const childAbs = join(root, childRel)

    if (e.isSymbolicLink()) {
      out.push([childRel, Buffer.from(`symlink:${await readlink(childAbs)}`)])
    } else if (e.isDirectory()) {
      await walk(root, childRel, out)
    } else if (e.isFile()) {
      out.push([childRel, await readFile(childAbs)])
    }
    // 其余（socket / fifo / 块设备）在 skill 目录里没有意义，跳过。
  }
}

export async function hashPath(p: string): Promise<string> {
  const kind = await pathKind(p)
  const h = createHash('sha256')

  if (kind === 'file') {
    // 单文件条目：文件名也进哈希 —— 内容相同但文件名不同是两个不同的东西
    h.update(basename(p))
    h.update('\0')
    h.update(await readFile(p))
    return h.digest('hex')
  }

  const files: Array<[string, Buffer]> = []
  await walk(p, '', files)
  files.sort((a, b) => a[0].localeCompare(b[0]))
  for (const [rel, buf] of files) {
    h.update(rel)
    h.update('\0')
    h.update(buf)
    h.update('\0')
  }
  return h.digest('hex')
}

/** 条目内的相对文件清单，给 UI 做差异摘要。 */
export async function listFiles(p: string): Promise<string[]> {
  const kind = await pathKind(p)
  if (kind === 'file') return [basename(p)]
  const files: Array<[string, Buffer]> = []
  await walk(p, '', files)
  return files.map(([rel]) => rel).sort()
}
