/** 可共享的维度。没有 rules —— 各家格式不兼容，见设计文档「非目标」。 */
export type Dim = 'skills' | 'commands' | 'agents' | 'hooks'

/** .agents 或某个工具目录下，某维度里的一个条目（一个 skill 目录，或一个 command 文件）。 */
export interface Entry {
  name: string
  hash: string
  path: string // 绝对路径
  isDir: boolean
  files: string[] // 条目内的相对文件清单，给冲突卡做差异摘要
  /** frontmatter 里的 description。没有 frontmatter、或里头没这个 key 时为 undefined。 */
  desc?: string
}

/** 冲突里的一个候选方。tool 为 '.agents' 时表示唯一源自己那份。 */
export interface ConflictCandidate {
  tool: string
  hash: string
  path: string
  files: string[]
}

export interface Conflict {
  key: string // `${dim}/${name}`
  dim: Dim
  name: string
  candidates: ConflictCandidate[]
}

/**
 * 维度目录下真实存在、但 dot-agents 不把它当条目的东西。
 *
 * 必须记下来，不能跳过。rmdir 是非递归的，它假设「plan 已经清空了这个目录」——
 * scan 只要有一次「跳过」，那个假设就破了，apply 会炸在 rmdir 上（ENOTEMPTY）。
 * 跳过 = 沉默地不处理 = bug。每个直接子项都得有明确归属。
 */
export interface Residue {
  name: string
  path: string
  /**
   * noise   —— OS / 编辑器留下的垃圾（.DS_Store）。备份后删，好让 rmdir 能进行。
   * symlink —— 条目级软链。用户数据，绝不碰；它会挡住整个维度换软链。
   */
  kind: 'noise' | 'symlink'
}

/**
 * scan 只产出这 4 种。conflict 不在这里 —— 它是 plan 跨来源比较才产生的，
 * scan 看不到 .claude 和 .codebuddy 之间的冲突。
 */
export type EntryState =
  | { kind: 'linked' }
  | { kind: 'absent' }
  | { kind: 'real'; entries: Entry[]; residue: Residue[] }
  | { kind: 'drifted'; actualTarget: string }

/** 点目录下、不属于任何受管维度的直接子项。看见了，故意不动。 */
export interface Foreign {
  name: string
  kind: 'dir' | 'file' | 'symlink'
  /** kind === 'symlink' 时的目标（绝对路径） */
  target?: string
}

/**
 * 一个已知工具的点目录整体状态。
 *
 * kind 必须在工具目录这一层就分清楚。整个 .claude 本身就是一条软链（用户自己接的，
 * 常见于 worktree）是真实存在的情况 —— 老版本在这里 `continue` 掉了它，
 * 于是它从 state、从图、从 CLI 表格里一起消失。看不见 = 用户以为它不存在。
 */
export interface ToolState {
  /** dir = 真实目录，参与收敛；symlink = 整个点目录是一条软链，只显示，绝不碰。 */
  kind: 'dir' | 'symlink'
  /** kind === 'symlink' 时的目标（绝对路径） */
  target?: string
  /** 受管维度的状态。kind === 'symlink' 时为空 —— 我们不进去看，更不会改。 */
  dims: Partial<Record<Dim, EntryState>>
  /** 该目录下不属于任何受管维度的直接子项。显式列出来是特性；沉默地不处理是 bug。 */
  only: Foreign[]
}

/** 白名单之外的点目录。dot-agents 不认识它，但它真实存在 —— 必须让用户看见。 */
export interface Stranger {
  name: string
  kind: 'dir' | 'symlink'
  target?: string
}

export interface State {
  repoRoot: string
  gitClean: boolean
  /** 被 gitignore 的工具目录。风险提示的依据：git 救不回来它们。 */
  gitIgnored: string[]
  /** only：唯一源里不属于任何受管维度的东西（docs/、plans/、.attic/）。它们执行后还在。 */
  agentsDir: { exists: boolean; entries: Record<Dim, Entry[]>; only: Foreign[] }
  /** 白名单里的、真实存在的点目录。 */
  tools: Record<string, ToolState>
  /** 白名单外的点目录。不碰，但要列出来 —— 否则「现状」这一列是在撒谎。 */
  strangers: Stranger[]
}

export type Op =
  | { t: 'mkdir'; path: string }
  | { t: 'move'; from: string; to: string }
  | { t: 'discard'; path: string }
  | { t: 'rmdir'; path: string }
  | { t: 'unlink'; path: string }
  | { t: 'symlink'; path: string; target: string } // target 一律相对路径

export interface BlockedDim {
  tool: string
  dim: Dim
  /** 一句话版本，给图上那一行用 */
  short: string
  reason: string
}

export interface Plan {
  repoRoot: string
  gitClean: boolean
  ops: Op[]
  conflicts: Conflict[]
  /** conflictKey -> 赢家 tool。未裁决的不在里面。 */
  resolved: Record<string, string>
  skipped: Conflict[]
  blockedDims: BlockedDim[]
  benefits: string[]
  risks: string[]
}

export interface Result {
  ok: boolean
  atticDir: string
  undoScript: string
  applied: Op[]
  error?: string
}

export type Resolutions = Record<string, string>

/** 一次文件内容窥视的结果。 */
export interface Peek {
  /** realpath 之后的真实路径 */
  path: string
  /** binary 为 true 时留空 */
  content: string
  /** 文件的完整字节数（不是 content 的长度 —— 可能被截断了） */
  size: number
  truncated: boolean
  binary: boolean
}

/** 403 = 不在白名单内 / 不是普通文件；404 = 不存在。 */
export type PeekResult = { ok: true; peek: Peek } | { ok: false; code: 403 | 404 }
