import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { realpath } from 'node:fs/promises'

/**
 * layout 的 key 是相对路径。
 * 值是 string -> 写文件；{ symlink: target } -> 建软链（相对路径）。
 */
export type Layout = Record<string, string | { symlink: string }>

export async function mkRepo(layout: Layout): Promise<string> {
  // macOS 的 /var/folders 是 /private/var/folders 的软链。不 realpath 的话，
  // scan 里 readLinkTarget 解析出的绝对路径和我们拼出来的期望路径会对不上。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dot-agents-test-')))
  for (const [rel, val] of Object.entries(layout)) {
    const abs = join(root, rel)
    await mkdir(dirname(abs), { recursive: true })
    if (typeof val === 'string') {
      await writeFile(abs, val, 'utf8')
    } else {
      await symlink(val.symlink, abs)
    }
  }
  return root
}

export async function cleanupRepo(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
