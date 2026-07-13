import type { Dim } from './types.js'

/** 顺序即优先级：同哈希去重时，排在前面的当源。 */
export const TOOL_DIRS = [
  '.claude',
  '.codebuddy',
  '.codex',
  '.cursor',
  '.gemini',
  '.qoder',
  '.trae',
  '.windsurf',
] as const

/**
 * 枚举点目录时跳过的名字。
 *
 * .git    —— 不是 Agent 工具目录，列出来只是噪声。
 * .agents —— 唯一源本身。它是收敛的终点，不是收敛的来源。
 */
export const NOT_A_TOOL = new Set<string>(['.git', '.agents'])

export const DIMS: Dim[] = ['skills', 'commands', 'agents', 'hooks']

export const AGENTS_DIR = '.agents'
export const ATTIC_DIR = '.agents/.attic'
