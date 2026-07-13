import { lstat, readlink, readdir, cp, rm, realpath } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

export type PathKind = 'missing' | 'file' | 'dir' | 'symlink'

export async function pathKind(p: string): Promise<PathKind> {
  try {
    const st = await lstat(p)
    if (st.isSymbolicLink()) return 'symlink'
    if (st.isDirectory()) return 'dir'
    return 'file'
  } catch {
    return 'missing'
  }
}

/** 读软链，把相对 target 解析成绝对路径。不 follow 到底，只解一层。 */
export async function readLinkTarget(p: string): Promise<string> {
  const raw = await readlink(p)
  return resolve(dirname(p), raw)
}

export async function copyTree(from: string, to: string): Promise<void> {
  await cp(from, to, { recursive: true, verbatimSymlinks: true })
}

export async function removeTree(p: string): Promise<void> {
  await rm(p, { recursive: true, force: true })
}

/** OS / 编辑器留下的垃圾。不是用户内容，但它真实存在，会挡住 rmdir。 */
const NOISE = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

export const isNoise = (name: string): boolean => NOISE.has(name)

/**
 * 目录下的直接子项名，排序。目录不存在返回 []。
 *
 * 这里一个都不过滤。过滤会让调用方以为「没有」，可 rmdir 面对的是真实的文件系统 ——
 * 视图和现实一旦分叉，apply 就会炸在 rmdir 上。要不要忽略某个名字，由调用方显式决定。
 */
export async function listChildren(p: string): Promise<string[]> {
  try {
    return (await readdir(p)).sort()
  } catch {
    return []
  }
}

export { realpath }
