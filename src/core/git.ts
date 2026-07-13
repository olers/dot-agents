import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export async function gitIsClean(root: string): Promise<boolean> {
  try {
    const { stdout } = await run('git', ['status', '--porcelain'], { cwd: root })
    return stdout.trim() === ''
  } catch {
    // 不是 git 仓库 -> 没有 git 兜底可言，按「不干净」处理，逼用户显式 --force
    return false
  }
}

/** 返回 paths 里被 gitignore 的那些。 */
export async function gitCheckIgnored(root: string, paths: string[]): Promise<string[]> {
  if (paths.length === 0) return []
  try {
    // check-ignore 命中时 exit 0 并打印路径；一个都没命中时 exit 1 且无输出
    const { stdout } = await run('git', ['check-ignore', ...paths], { cwd: root })
    return stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
  } catch {
    return []
  }
}
