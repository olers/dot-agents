import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { realpath } from 'node:fs/promises'
import { execSync } from 'node:child_process'

/**
 * layout 的 key 是相对路径。
 * 值是 string -> 写文件；{ symlink: target } -> 建软链（相对路径）；
 * { dir: true } -> 建一个空目录（key 末尾的 / 可有可无）。
 */
export type Layout = Record<string, string | { symlink: string } | { dir: true }>

export async function mkRepo(layout: Layout): Promise<string> {
  // macOS 的 /var/folders 是 /private/var/folders 的软链。不 realpath 的话，
  // scan 里 readLinkTarget 解析出的绝对路径和我们拼出来的期望路径会对不上。
  const root = await realpath(await mkdtemp(join(tmpdir(), 'dot-agents-test-')))
  for (const [rel, val] of Object.entries(layout)) {
    const abs = join(root, rel)
    if (typeof val === 'object' && 'dir' in val) {
      // 空目录：rmdir 那条路径要靠它才走得到（空 real 维度、空壳）。
      await mkdir(abs, { recursive: true })
      continue
    }
    await mkdir(dirname(abs), { recursive: true })
    if (typeof val === 'string') {
      await writeFile(abs, val, 'utf8')
    } else {
      await symlink(val.symlink, abs)
    }
  }
  return root
}

/** mkRepo + git init：给需要过 findRepoRoot 的 CLI/e2e 测试用 */
export async function mkGitRepo(layout: Layout): Promise<string> {
  const root = await mkRepo(layout)
  execSync('git init -q', { cwd: root })
  return root
}

export async function cleanupRepo(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true })
}
