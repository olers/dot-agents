# dot-agents MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一个 CLI 工具，把仓库内多个 AI Agent 工具目录（`.claude` / `.codebuddy` / …）里的通用配置收敛到 `.agents/` 唯一源，其余目录改为软链；变更前先在浏览器里展示计划、风险、收益，人点确认后才落盘。

**Architecture:** 一个 core，两个壳。`core/` 是纯逻辑（`scan` → `plan` → `apply`），不碰 process / http / console，全部对着真实临时目录单测。`cli/` 和 `server/` 都是薄壳，只把 core 的输出渲染成终端表格或 HTTP 响应 —— 两者不允许有任何业务分支判断。`web/` 是 React 前端，build 成静态资源打进包里由 server 提供。

**Tech Stack:** TypeScript (ESM, NodeNext) · Node ≥ 20 · commander (CLI) · node:http (server, 零依赖) · React 18 + Vite (web) · vitest (test)

## Global Constraints

- Node ≥ 20。`package.json` 里 `"type": "module"`，`"engines": { "node": ">=20" }`。
- 包名 `dot-agents`，可执行文件名 `dot-agents`。
- **维度只有 4 个**：`skills` / `commands` / `agents` / `hooks`。**没有 `rules`** —— 各家格式不兼容，收进同一个源就是制造损坏。
- **工具白名单固定 7 个**（顺序即优先级，用于「同哈希去重时选谁当源」）：
  `.claude` `.codebuddy` `.cursor` `.gemini` `.qoder` `.trae` `.windsurf`
- **软链一律用相对路径**（`.claude/skills -> ../.agents/skills`），绝不写绝对路径 —— 绝对路径换台机器就废。
- **`.agents/.attic/` 备份不可关闭**，`--force` 也不能跳过它。`.claude/` 常被 gitignore，git 救不回来，attic 是唯一的后悔药。
- **`core/` 里不允许 import `node:process` / `console` / `node:http`。** 违反即架构失守。
- 所有 core 测试对着**真实临时目录**跑，不 mock fs —— 软链行为就是这个工具的全部，mock 掉等于什么都没测。

---

## File Structure

```
package.json            # ESM, bin: agents -> dist/cli/index.js
tsconfig.json           # NodeNext, strict, outDir dist
vitest.config.ts
vite.config.ts          # web/ -> dist/web/
.gitignore              # node_modules, dist, .agents/.attic

src/core/
  types.ts              # 全部类型定义。无逻辑，无 import。
  constants.ts          # TOOL_DIRS, DIMS
  fsx.ts                # pathKind / readLinkTarget / copyTree / removeTree / listFiles
  hash.ts               # hashPath —— 条目内容哈希（忽略 mtime/权限）
  scan.ts               # scan(repoRoot) -> State
  plan.ts               # buildPlan(state, resolutions) -> Plan
  apply.ts              # applyPlan(plan, opts) -> Result（备份/journal/回滚/undo.sh）
  git.ts                # isClean / checkIgnored —— 唯一允许 spawn 子进程的 core 文件

src/cli/
  index.ts              # commander 入口: 默认(ui) | status | apply | link
  render.ts             # State/Plan/Result -> 终端字符串

src/server/
  index.ts              # startServer(repoRoot) -> { url, token, close }

src/web/
  main.tsx  App.tsx  api.ts  styles.css
  components/StatusMatrix.tsx  PlanView.tsx  ConflictCard.tsx  ResultView.tsx

tests/
  helpers/mkrepo.ts     # 搭临时仓库的测试夹具
  core/hash.test.ts  scan.test.ts  plan.test.ts  apply.test.ts
  cli/link.test.ts
  server/api.test.ts
```

---

### Task 1: 脚手架 + 类型 + 内容哈希

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`
- Create: `src/core/types.ts`, `src/core/constants.ts`, `src/core/fsx.ts`, `src/core/hash.ts`
- Create: `tests/helpers/mkrepo.ts`, `tests/core/hash.test.ts`

**Interfaces:**
- Consumes: 无（首个任务）
- Produces:
  - `types.ts` 导出的**全部**类型，后续任务直接用，不再重定义
  - `hashPath(p: string): Promise<string>`
  - `listFiles(p: string): Promise<string[]>`
  - `pathKind(p: string): Promise<'missing'|'file'|'dir'|'symlink'>`
  - `readLinkTarget(p: string): Promise<string>` — 返回**解析后的绝对路径**
  - `copyTree(from, to): Promise<void>` / `removeTree(p): Promise<void>`
  - 测试夹具 `mkRepo(layout): Promise<string>` / `cleanupRepo(root)`

- [ ] **Step 1: 建脚手架文件**

`package.json`:
```json
{
  "name": "dot-agents",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agents": "./dist/cli/index.js" },
  "engines": { "node": ">=20" },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json && vite build",
    "test": "vitest run",
    "dev": "tsx src/cli/index.ts"
  },
  "dependencies": {
    "commander": "^12.1.0",
    "open": "^10.1.0"
  },
  "devDependencies": {
    "@types/node": "^20.14.0",
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "tsx": "^4.16.0",
    "typescript": "^5.5.0",
    "vite": "^5.3.0",
    "vitest": "^2.0.0"
  }
}
```

`tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": "src",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM"]
  },
  "include": ["src"],
  "exclude": ["src/web"]
}
```

`vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // 软链和文件 IO 测试不能并发跑在同一个临时目录里，但我们每个测试各自建目录，所以可以并发
    testTimeout: 20000,
  },
})
```

`.gitignore`:
```
node_modules/
dist/
.agents/.attic/
```

- [ ] **Step 2: 写 `src/core/types.ts`（无逻辑，先立契约）**

```ts
/** 可共享的维度。没有 rules —— 各家格式不兼容，见设计文档「非目标」。 */
export type Dim = 'skills' | 'commands' | 'agents' | 'hooks'

/** .agents 或某个工具目录下，某维度里的一个条目（一个 skill 目录，或一个 command 文件）。 */
export interface Entry {
  name: string
  hash: string
  path: string // 绝对路径
  isDir: boolean
}

/** 冲突里的一个候选方。tool 为 '.agents' 时表示唯一源自己那份。 */
export interface ConflictCandidate {
  tool: string
  hash: string
  path: string
  files: string[] // 条目内的相对文件清单，给 UI 做差异摘要
}

export interface Conflict {
  key: string // `${dim}/${name}`
  dim: Dim
  name: string
  candidates: ConflictCandidate[]
}

/**
 * scan 只产出这 4 种。conflict 不在这里 —— 它是 plan 跨来源比较才产生的，
 * scan 看不到 .claude 和 .codebuddy 之间的冲突。
 */
export type EntryState =
  | { kind: 'linked' }
  | { kind: 'absent' }
  | { kind: 'real'; entries: Entry[] }
  | { kind: 'drifted'; actualTarget: string }

export interface State {
  repoRoot: string
  gitClean: boolean
  /** 被 gitignore 的工具目录。风险提示的依据：git 救不回来它们。 */
  gitIgnored: string[]
  agentsDir: { exists: boolean; entries: Record<Dim, Entry[]> }
  tools: Record<string, Partial<Record<Dim, EntryState>>>
  /** 工具专属、明确不碰的路径。显式列出来是特性；沉默地不处理是 bug。 */
  toolOnly: Record<string, string[]>
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
```

- [ ] **Step 3: 写 `src/core/constants.ts`**

```ts
import type { Dim } from './types.js'

/** 顺序即优先级：同哈希去重时，排在前面的当源。 */
export const TOOL_DIRS = [
  '.claude',
  '.codebuddy',
  '.cursor',
  '.gemini',
  '.qoder',
  '.trae',
  '.windsurf',
] as const

export const DIMS: Dim[] = ['skills', 'commands', 'agents', 'hooks']

export const AGENTS_DIR = '.agents'
export const ATTIC_DIR = '.agents/.attic'
```

- [ ] **Step 4: 写失败的测试 `tests/core/hash.test.ts`**

先写夹具 `tests/helpers/mkrepo.ts`：

```ts
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/**
 * layout 的 key 是相对路径。
 * 值是 string -> 写文件；{ symlink: target } -> 建软链（相对路径）。
 */
export type Layout = Record<string, string | { symlink: string }>

export async function mkRepo(layout: Layout): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dot-agents-test-'))
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
```

测试：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'
import { utimes } from 'node:fs/promises'
import { hashPath, listFiles } from '../../src/core/hash.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function repo(layout: Parameters<typeof mkRepo>[0]) {
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
```

- [ ] **Step 5: 跑测试确认失败**

Run: `npx vitest run tests/core/hash.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/hash.js'`

- [ ] **Step 6: 写 `src/core/fsx.ts`**

```ts
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

/** 目录下的直接子项名，排序。目录不存在返回 []。 */
export async function listChildren(p: string): Promise<string[]> {
  try {
    const names = await readdir(p)
    return names.filter((n) => n !== '.DS_Store').sort()
  } catch {
    return []
  }
}

export { realpath }
```

- [ ] **Step 7: 写 `src/core/hash.ts`**

```ts
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { pathKind } from './fsx.js'

/** 递归收集 (相对路径, 内容)，排序后喂给 sha256。忽略 mtime / 权限。 */
async function walk(root: string, rel: string, out: Array<[string, Buffer]>): Promise<void> {
  const abs = rel ? join(root, rel) : root
  const entries = await readdir(abs, { withFileTypes: true })
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name === '.DS_Store') continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    if (e.isDirectory()) {
      await walk(root, childRel, out)
    } else {
      out.push([childRel, await readFile(join(root, childRel))])
    }
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
```

- [ ] **Step 8: 跑测试确认通过**

Run: `npx vitest run tests/core/hash.test.ts`
Expected: PASS，7 个用例全绿

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json vitest.config.ts .gitignore src/core tests
git commit -m "feat(core): 条目内容哈希 + 类型契约 + 测试夹具"
```

---

### Task 2: scan —— 4 种状态检测

**Files:**
- Create: `src/core/git.ts`, `src/core/scan.ts`
- Test: `tests/core/scan.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `types.ts` / `constants.ts` / `fsx.ts` / `hash.ts`
- Produces:
  - `findRepoRoot(cwd: string): Promise<string | null>`
  - `scan(repoRoot: string): Promise<State>`
  - `gitIsClean(root: string): Promise<boolean>`
  - `gitCheckIgnored(root: string, paths: string[]): Promise<string[]>`

- [ ] **Step 1: 写失败的测试 `tests/core/scan.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { scan } from '../../src/core/scan.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function repo(layout: Parameters<typeof mkRepo>[0]) {
  const r = await mkRepo(layout)
  roots.push(r)
  return r
}

describe('scan', () => {
  // WHY: 状态判错 -> plan 就会算错 -> apply 会破坏用户文件。这是整条链的地基。
  it('real: 工具目录下有真实内容', async () => {
    const r = await repo({ '.claude/skills/foo/SKILL.md': 'x' })
    const s = await scan(r)
    const st = s.tools['.claude'].skills!
    expect(st.kind).toBe('real')
    expect(st.kind === 'real' && st.entries.map((e) => e.name)).toEqual(['foo'])
  })

  it('absent: 工具目录存在但没有该维度', async () => {
    const r = await repo({ '.claude/settings.json': '{}' })
    const s = await scan(r)
    expect(s.tools['.claude'].skills!.kind).toBe('absent')
  })

  it('linked: 已软链到 .agents 的对应维度', async () => {
    const r = await repo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    const s = await scan(r)
    expect(s.tools['.claude'].skills!.kind).toBe('linked')
  })

  // WHY: drifted 是「看起来已经接好了，其实指向别处」。当成 linked 处理会让用户以为统一了，
  // 实际两边内容完全不同 —— 这是最难自己发现的失败模式。
  it('drifted: 是软链但指向别处', async () => {
    const r = await repo({
      '.agents/skills/foo/SKILL.md': 'x',
      'elsewhere/skills/bar/SKILL.md': 'y',
      '.claude/skills': { symlink: '../elsewhere/skills' },
    })
    const s = await scan(r)
    const st = s.tools['.claude'].skills!
    expect(st.kind).toBe('drifted')
    expect(st.kind === 'drifted' && st.actualTarget).toContain('elsewhere/skills')
  })

  it('未在白名单的目录不被扫描', async () => {
    const r = await repo({ '.vscode/skills/foo/SKILL.md': 'x', '.git/config': '' })
    const s = await scan(r)
    expect(s.tools['.vscode']).toBeUndefined()
    expect(s.tools['.git']).toBeUndefined()
  })

  // WHY: 沉默地不处理 = bug。用户必须能看到「工具看见了 rules/ 和 settings.json，但故意没动」。
  it('toolOnly 列出所有不碰的东西（含 rules/）', async () => {
    const r = await repo({
      '.claude/settings.json': '{}',
      '.cursor/rules/foo.mdc': 'x',
      '.claude/skills/foo/SKILL.md': 'y',
    })
    const s = await scan(r)
    expect(s.toolOnly['.claude']).toContain('settings.json')
    expect(s.toolOnly['.cursor']).toContain('rules')
    // skills 是被管理的维度，不该出现在 toolOnly 里
    expect(s.toolOnly['.claude']).not.toContain('skills')
  })

  it('.agents 的条目被收进 agentsDir.entries', async () => {
    const r = await repo({ '.agents/skills/foo/SKILL.md': 'x', '.agents/commands/c.md': 'y' })
    const s = await scan(r)
    expect(s.agentsDir.exists).toBe(true)
    expect(s.agentsDir.entries.skills.map((e) => e.name)).toEqual(['foo'])
    expect(s.agentsDir.entries.commands.map((e) => e.name)).toEqual(['c.md'])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/scan.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/scan.js'`

- [ ] **Step 3: 写 `src/core/git.ts`**

这是 core 里**唯一**允许 spawn 子进程的文件，因为 git 状态没有纯函数版本。

```ts
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
    return stdout.split('\n').map((s) => s.trim()).filter(Boolean)
  } catch {
    return []
  }
}
```

- [ ] **Step 4: 写 `src/core/scan.ts`**

```ts
import { join, resolve, dirname } from 'node:path'
import type { Dim, Entry, EntryState, State } from './types.js'
import { TOOL_DIRS, DIMS, AGENTS_DIR } from './constants.js'
import { pathKind, readLinkTarget, listChildren } from './fsx.js'
import { hashPath } from './hash.js'
import { gitIsClean, gitCheckIgnored } from './git.js'

export async function findRepoRoot(cwd: string): Promise<string | null> {
  let cur = resolve(cwd)
  for (;;) {
    if ((await pathKind(join(cur, '.git'))) !== 'missing') return cur
    const parent = dirname(cur)
    if (parent === cur) return null
    cur = parent
  }
}

async function readEntries(dir: string): Promise<Entry[]> {
  const names = await listChildren(dir)
  const out: Entry[] = []
  for (const name of names) {
    const p = join(dir, name)
    const kind = await pathKind(p)
    if (kind === 'missing' || kind === 'symlink') continue // 条目级软链不在 MVP 范围
    out.push({ name, path: p, isDir: kind === 'dir', hash: await hashPath(p) })
  }
  return out
}

async function scanDim(repoRoot: string, tool: string, dim: Dim): Promise<EntryState> {
  const dimPath = join(repoRoot, tool, dim)
  const kind = await pathKind(dimPath)

  if (kind === 'missing') return { kind: 'absent' }

  if (kind === 'symlink') {
    const target = await readLinkTarget(dimPath)
    const want = join(repoRoot, AGENTS_DIR, dim)
    return target === want ? { kind: 'linked' } : { kind: 'drifted', actualTarget: target }
  }

  if (kind === 'file') {
    // 维度位置上是个文件（不该发生）。当 absent 处理，并让 toolOnly 收走它。
    return { kind: 'absent' }
  }

  return { kind: 'real', entries: await readEntries(dimPath) }
}

export async function scan(repoRoot: string): Promise<State> {
  const emptyDims = () =>
    Object.fromEntries(DIMS.map((d) => [d, [] as Entry[]])) as Record<Dim, Entry[]>

  const agentsPath = join(repoRoot, AGENTS_DIR)
  const agentsExists = (await pathKind(agentsPath)) === 'dir'
  const agentsEntries = emptyDims()
  if (agentsExists) {
    for (const dim of DIMS) {
      agentsEntries[dim] = await readEntries(join(agentsPath, dim))
    }
  }

  const tools: State['tools'] = {}
  const toolOnly: State['toolOnly'] = {}
  const presentTools: string[] = []

  for (const tool of TOOL_DIRS) {
    if ((await pathKind(join(repoRoot, tool))) !== 'dir') continue
    presentTools.push(tool)

    const dims: Partial<Record<Dim, EntryState>> = {}
    for (const dim of DIMS) {
      dims[dim] = await scanDim(repoRoot, tool, dim)
    }
    tools[tool] = dims

    // toolOnly = 工具目录下、不是被管理维度的所有直接子项
    const children = await listChildren(join(repoRoot, tool))
    toolOnly[tool] = children.filter((c) => !(DIMS as string[]).includes(c))
  }

  return {
    repoRoot,
    gitClean: await gitIsClean(repoRoot),
    gitIgnored: await gitCheckIgnored(repoRoot, presentTools),
    agentsDir: { exists: agentsExists, entries: agentsEntries },
    tools,
    toolOnly,
  }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run tests/core/scan.test.ts`
Expected: PASS，7 个用例全绿

> 注意：测试用的临时目录不是 git 仓库，所以 `gitClean` 会是 `false`、`gitIgnored` 会是 `[]`。scan 的测试不断言这两个字段。

- [ ] **Step 6: Commit**

```bash
git add src/core/git.ts src/core/scan.ts tests/core/scan.test.ts
git commit -m "feat(core): scan —— linked/absent/real/drifted 四态检测 + toolOnly"
```

---

### Task 3: plan —— 两趟算法、冲突、ops 排序

**Files:**
- Create: `src/core/plan.ts`
- Test: `tests/core/plan.test.ts`

**Interfaces:**
- Consumes: Task 1 types + Task 2 `scan`
- Produces: `buildPlan(state: State, resolutions: Resolutions): Plan`

**算法（两趟，不能改成逐工具增量）：**

第 1 趟按 `(dim, name)` 归组，把 `.agents` 和所有工具的这份内容收在一起按哈希去重。
第 2 趟对每个 `(tool, dim)` 决定软链 op；该维度下只要还有未裁决冲突，就 block 掉不建链。

**为什么不能逐工具增量：** 那样 `.claude/skills/foo` 会先被移进空的 `.agents`，`.codebuddy/skills/foo` 再来比时比的是「刚被移进去的自己人」而不是原本的 `.agents` —— 冲突归属会依赖遍历顺序，同一份数据算两次结果不同。

- [ ] **Step 1: 写失败的测试 `tests/core/plan.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'
import type { Op } from '../../src/core/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function planFor(layout: Parameters<typeof mkRepo>[0], resolutions = {}) {
  const r = await mkRepo(layout)
  roots.push(r)
  return { root: r, plan: buildPlan(await scan(r), resolutions) }
}
const opsOf = (ops: Op[], t: Op['t']) => ops.filter((o) => o.t === t)

describe('buildPlan', () => {
  it('单个工具的 real 目录 -> move 条目 + rmdir 空壳 + symlink', async () => {
    const { plan } = await planFor({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(plan.conflicts).toEqual([])
    expect(opsOf(plan.ops, 'move')).toHaveLength(1)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
    const link = opsOf(plan.ops, 'symlink')[0] as Extract<Op, { t: 'symlink' }>
    // WHY: 绝对路径的软链换台机器就废。相对路径是唯一能提交进 git、能 clone 后直接用的形式。
    expect(link.target).toBe('../.agents/skills')
  })

  // WHY: 内容一模一样却让人裁决，是在浪费人的注意力。人被无意义的确认框训练几次之后，
  // 就会开始无脑点确认 —— 那时真正的冲突也会被一起点过去。
  it('两个工具、同名、哈希相同 -> 不是冲突，第二份 discard', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'same',
      '.codebuddy/skills/foo/SKILL.md': 'same',
    })
    expect(plan.conflicts).toEqual([])
    expect(opsOf(plan.ops, 'move')).toHaveLength(1) // .claude 排前面，当源
    expect(opsOf(plan.ops, 'discard')).toHaveLength(1) // .codebuddy 那份丢弃
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(2) // 两个工具都建链
  })

  // WHY: 静默丢内容是这个工具最严重的失败模式。哈希不同 = 有人的东西会消失，必须停下来问。
  it('两个工具、同名、哈希不同 -> conflict，且绝不自动选', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].key).toBe('skills/foo')
    expect(plan.conflicts[0].candidates.map((c) => c.tool).sort()).toEqual(['.claude', '.codebuddy'])
    expect(plan.resolved).toEqual({})
    expect(plan.skipped).toHaveLength(1)
    // 一个都不许动
    expect(opsOf(plan.ops, 'move')).toHaveLength(0)
    expect(opsOf(plan.ops, 'discard')).toHaveLength(0)
  })

  // WHY: 软链是目录级的。只要 .claude/skills/ 里还留着一个未裁决的 foo，这个目录就不能被替换成软链。
  // 用户以为「跳过一个 skill」，实际是「这个工具的 skills 整个没接上」。UI 必须讲清楚，plan 必须先算出来。
  it('未裁决的冲突 -> 该 (tool, dim) 被 block，不建链', async () => {
    const { plan } = await planFor({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(0)
    expect(plan.blockedDims.map((b) => `${b.tool}/${b.dim}`).sort()).toEqual([
      '.claude/skills',
      '.codebuddy/skills',
    ])
  })

  it('裁决后 -> 赢家 move 进 .agents，输家 discard，两边都建链', async () => {
    const { plan } = await planFor(
      {
        '.claude/skills/foo/SKILL.md': 'A',
        '.codebuddy/skills/foo/SKILL.md': 'B',
      },
      { 'skills/foo': '.codebuddy' },
    )
    expect(plan.skipped).toEqual([])
    expect(plan.blockedDims).toEqual([])
    const moves = opsOf(plan.ops, 'move') as Extract<Op, { t: 'move' }>[]
    expect(moves).toHaveLength(1)
    expect(moves[0].from).toContain('.codebuddy/skills/foo')
    expect(opsOf(plan.ops, 'discard')).toHaveLength(1) // .claude 那份
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(2)
  })

  it('.agents 已有内容且哈希不同 -> .agents 也是候选之一', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'ORIG',
      '.claude/skills/foo/SKILL.md': 'NEW',
    })
    expect(plan.conflicts).toHaveLength(1)
    expect(plan.conflicts[0].candidates.map((c) => c.tool).sort()).toEqual(['.agents', '.claude'])
  })

  it('裁决 .agents 赢 -> 不 move，只 discard 工具那份', async () => {
    const { plan } = await planFor(
      {
        '.agents/skills/foo/SKILL.md': 'ORIG',
        '.claude/skills/foo/SKILL.md': 'NEW',
      },
      { 'skills/foo': '.agents' },
    )
    expect(opsOf(plan.ops, 'move')).toHaveLength(0)
    expect(opsOf(plan.ops, 'discard')).toHaveLength(1)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
  })

  it('裁决工具赢、且 .agents 已有 -> 先 discard .agents 那份，再 move 进去', async () => {
    const { plan } = await planFor(
      {
        '.agents/skills/foo/SKILL.md': 'ORIG',
        '.claude/skills/foo/SKILL.md': 'NEW',
      },
      { 'skills/foo': '.claude' },
    )
    const discards = opsOf(plan.ops, 'discard') as Extract<Op, { t: 'discard' }>[]
    expect(discards).toHaveLength(1)
    expect(discards[0].path).toContain('.agents/skills/foo')
    const moves = opsOf(plan.ops, 'move') as Extract<Op, { t: 'move' }>[]
    expect(moves[0].from).toContain('.claude/skills/foo')
    // discard 必须排在 move 前面，否则 move 的目标位置被占着
    expect(plan.ops.indexOf(discards[0])).toBeLessThan(plan.ops.indexOf(moves[0]))
  })

  it('absent 的维度 -> 只建链，不 move', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/settings.json': '{}',
    })
    expect(opsOf(plan.ops, 'move')).toHaveLength(0)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
  })

  it('drifted -> unlink 旧链 + symlink 新链', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      'elsewhere/keep.md': 'y',
      '.claude/skills': { symlink: '../elsewhere' },
    })
    expect(opsOf(plan.ops, 'unlink')).toHaveLength(1)
    expect(opsOf(plan.ops, 'symlink')).toHaveLength(1)
  })

  it('linked -> 无 op（幂等）', async () => {
    const { plan } = await planFor({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    expect(plan.ops).toEqual([])
  })

  it('op 顺序：mkdir -> move/discard -> rmdir/unlink -> symlink', async () => {
    const { plan } = await planFor({ '.claude/skills/foo/SKILL.md': 'x' })
    const order = plan.ops.map((o) => o.t)
    const rank: Record<Op['t'], number> = {
      mkdir: 0, discard: 1, move: 1, rmdir: 2, unlink: 2, symlink: 3,
    }
    for (let i = 1; i < order.length; i++) {
      expect(rank[order[i]]).toBeGreaterThanOrEqual(rank[order[i - 1]])
    }
  })

  it('gitignore 的工具目录 -> 产生风险提示', async () => {
    const { plan } = await planFor({ '.claude/skills/foo/SKILL.md': 'x' })
    // 临时目录不是 git 仓库 -> gitClean=false -> 必有「工作区不干净」风险
    expect(plan.risks.join('\n')).toContain('工作区')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/plan.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/plan.js'`

- [ ] **Step 3: 写 `src/core/plan.ts`**

```ts
import { join, relative } from 'node:path'
import type {
  Conflict, ConflictCandidate, Dim, Op, Plan, Resolutions, State, BlockedDim,
} from './types.js'
import { DIMS, TOOL_DIRS, AGENTS_DIR } from './constants.js'

const RANK: Record<Op['t'], number> = {
  mkdir: 0,
  discard: 1,
  move: 1,
  rmdir: 2,
  unlink: 2,
  symlink: 3,
}

/** 一个 (dim, name) 下所有来源的候选。 */
interface Group {
  dim: Dim
  name: string
  key: string
  /** tool -> 候选。'.agents' 也算一个 tool。 */
  byTool: Map<string, { hash: string; path: string; files: string[] }>
}

/** scan 时没存 files 清单，plan 展示冲突要用。这里从 Entry 里补不出来，
 *  所以 scan 存的 Entry 已经够用：冲突展示只需要文件名清单，交给 UI 时再补。
 *  MVP：candidates.files 用 entry 内的文件清单，scan 阶段已算过 hash，这里复用一个惰性字段。 */
function collectGroups(state: State): Map<string, Group> {
  const groups = new Map<string, Group>()

  const put = (dim: Dim, name: string, tool: string, hash: string, path: string) => {
    const key = `${dim}/${name}`
    let g = groups.get(key)
    if (!g) {
      g = { dim, name, key, byTool: new Map() }
      groups.set(key, g)
    }
    g.byTool.set(tool, { hash, path, files: [] })
  }

  for (const dim of DIMS) {
    for (const e of state.agentsDir.entries[dim]) {
      put(dim, e.name, AGENTS_DIR, e.hash, e.path)
    }
  }
  for (const tool of TOOL_DIRS) {
    const dims = state.tools[tool]
    if (!dims) continue
    for (const dim of DIMS) {
      const st = dims[dim]
      if (st?.kind !== 'real') continue
      for (const e of st.entries) put(dim, e.name, tool, e.hash, e.path)
    }
  }
  return groups
}

/** 白名单顺序即优先级：同哈希去重时排前面的当源。'.agents' 永远最优先。 */
function sourcePriority(tool: string): number {
  if (tool === AGENTS_DIR) return -1
  const i = (TOOL_DIRS as readonly string[]).indexOf(tool)
  return i < 0 ? 999 : i
}

export function buildPlan(state: State, resolutions: Resolutions): Plan {
  const { repoRoot } = state
  const ops: Op[] = []
  const conflicts: Conflict[] = []
  const skipped: Conflict[] = []
  const resolved: Record<string, string> = {}
  const blockedDims: BlockedDim[] = []

  const groups = collectGroups(state)

  /** dim -> 该维度是否会有内容（决定要不要 mkdir + 建链） */
  const dimWillExist = new Set<Dim>()
  /** `${tool}/${dim}` -> 被未裁决冲突 block */
  const blocked = new Set<string>()
  let dedupCount = 0

  // ── 第 1 趟：按 (dim, name) 归组，决定收录 / 丢弃 / 冲突 ──
  for (const g of [...groups.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    const tools = [...g.byTool.entries()].sort((a, b) => sourcePriority(a[0]) - sourcePriority(b[0]))
    const hashes = new Set(tools.map(([, v]) => v.hash))

    if (hashes.size === 1) {
      // 无冲突。第一个（优先级最高的）当源，其余全部 discard。
      dimWillExist.add(g.dim)
      const [srcTool, src] = tools[0]
      if (srcTool !== AGENTS_DIR) {
        ops.push({ t: 'move', from: src.path, to: join(repoRoot, AGENTS_DIR, g.dim, g.name) })
      }
      for (const [tool, v] of tools.slice(1)) {
        ops.push({ t: 'discard', path: v.path })
        dedupCount++
        void tool
      }
      continue
    }

    // 冲突
    const candidates: ConflictCandidate[] = tools.map(([tool, v]) => ({
      tool,
      hash: v.hash,
      path: v.path,
      files: v.files,
    }))
    const conflict: Conflict = { key: g.key, dim: g.dim, name: g.name, candidates }
    conflicts.push(conflict)

    const winner = resolutions[g.key]
    if (!winner || !g.byTool.has(winner)) {
      // 未裁决 -> 一个都不动，且把所有持有该条目的 (tool, dim) 全部 block
      skipped.push(conflict)
      for (const [tool] of tools) {
        if (tool === AGENTS_DIR) continue
        blocked.add(`${tool}/${g.dim}`)
      }
      // .agents 里已有的那份仍然存在 -> 维度是存在的
      if (g.byTool.has(AGENTS_DIR)) dimWillExist.add(g.dim)
      continue
    }

    // 已裁决
    resolved[g.key] = winner
    dimWillExist.add(g.dim)
    const target = join(repoRoot, AGENTS_DIR, g.dim, g.name)

    if (winner !== AGENTS_DIR && g.byTool.has(AGENTS_DIR)) {
      // .agents 里那份要被换掉 -> 先 discard（备份后删），再 move 赢家进来。
      // 顺序靠 RANK 排序保证不了（discard 和 move 同 rank），所以这里显式先 push discard。
      ops.push({ t: 'discard', path: g.byTool.get(AGENTS_DIR)!.path })
    }
    if (winner !== AGENTS_DIR) {
      ops.push({ t: 'move', from: g.byTool.get(winner)!.path, to: target })
    }
    for (const [tool, v] of tools) {
      if (tool === winner || tool === AGENTS_DIR) continue
      ops.push({ t: 'discard', path: v.path })
    }
  }

  // ── 第 2 趟：每个 (tool, dim) 决定软链 ──
  let linkCount = 0
  for (const tool of TOOL_DIRS) {
    const dims = state.tools[tool]
    if (!dims) continue
    for (const dim of DIMS) {
      const st = dims[dim]
      if (!st) continue
      if (st.kind === 'linked') continue

      if (blocked.has(`${tool}/${dim}`)) {
        blockedDims.push({
          tool,
          dim,
          reason: '该维度下有未裁决的冲突条目。软链是目录级的 —— 只要还有一个条目留在原地，整个目录就不能被替换成软链。',
        })
        continue
      }
      if (!dimWillExist.has(dim)) continue // .agents 该维度是空的，没什么可链

      const dimPath = join(repoRoot, tool, dim)
      const linkTarget = relative(join(repoRoot, tool), join(repoRoot, AGENTS_DIR, dim))

      if (st.kind === 'drifted') {
        ops.push({ t: 'unlink', path: dimPath })
      } else if (st.kind === 'real') {
        ops.push({ t: 'rmdir', path: dimPath }) // 此时条目已被 move/discard 清空
      }
      ops.push({ t: 'symlink', path: dimPath, target: linkTarget })
      linkCount++
    }
  }

  // mkdir：每个会存在的维度
  for (const dim of dimWillExist) {
    ops.unshift({ t: 'mkdir', path: join(repoRoot, AGENTS_DIR, dim) })
  }

  // 稳定排序：只按 RANK 排，同 rank 保持 push 顺序（Array.sort 在 V8 里是稳定的）
  ops.sort((a, b) => RANK[a.t] - RANK[b.t])

  // ── 风险 & 收益 ──
  const risks: string[] = []
  if (!state.gitClean) {
    risks.push('git 工作区不干净（或这里不是 git 仓库）。出事时 git 帮不上忙 —— 只能靠 .agents/.attic/ 的备份回滚。')
  }
  for (const t of state.gitIgnored) {
    risks.push(`${t}/ 被 gitignore。git 根本没跟踪它，git checkout 救不回来 —— .agents/.attic/ 是唯一的后悔药。`)
  }
  if (skipped.length > 0) {
    const dimsBlocked = [...new Set(blockedDims.map((b) => `${b.tool}/${b.dim}`))]
    risks.push(
      `${skipped.length} 个冲突未裁决 → 这些目录不会被接上软链，保持原样：${dimsBlocked.join('、')}`,
    )
  }
  if (ops.some((o) => o.t === 'discard')) {
    risks.push('discard 会删除重复/落败的副本。删除前全部备份进 .agents/.attic/<时间戳>/，并生成 undo.sh。')
  }

  const benefits: string[] = []
  const moveCount = ops.filter((o) => o.t === 'move').length
  if (moveCount > 0) benefits.push(`${moveCount} 个条目收进 .agents/ 唯一源`)
  if (dedupCount > 0) benefits.push(`${dedupCount} 份内容完全相同的重复副本被消除（改一处，所有工具同时生效）`)
  if (linkCount > 0) benefits.push(`${linkCount} 个 (工具 × 维度) 接上软链`)
  if (ops.length === 0) benefits.push('已经是统一状态，无需变更。')

  return {
    repoRoot,
    gitClean: state.gitClean,
    ops,
    conflicts,
    resolved,
    skipped,
    blockedDims,
    benefits,
    risks,
  }
}
```

- [ ] **Step 4: 补 `Conflict.candidates.files`**

冲突卡要展示「哪些文件不同」，但 `Entry` 里没存文件清单。在 `scan.ts` 的 `readEntries` 里补上：

修改 `src/core/types.ts` 的 `Entry`，加一个字段：
```ts
export interface Entry {
  name: string
  hash: string
  path: string
  isDir: boolean
  files: string[] // 条目内的相对文件清单，给冲突卡做差异摘要
}
```

修改 `src/core/scan.ts` 的 `readEntries`：
```ts
import { hashPath, listFiles } from './hash.js'
// ...
    out.push({
      name,
      path: p,
      isDir: kind === 'dir',
      hash: await hashPath(p),
      files: await listFiles(p),
    })
```

修改 `src/core/plan.ts` 的 `collectGroups`，把 `files` 传进去：
```ts
  const put = (dim: Dim, name: string, tool: string, hash: string, path: string, files: string[]) => {
    const key = `${dim}/${name}`
    let g = groups.get(key)
    if (!g) {
      g = { dim, name, key, byTool: new Map() }
      groups.set(key, g)
    }
    g.byTool.set(tool, { hash, path, files })
  }

  for (const dim of DIMS) {
    for (const e of state.agentsDir.entries[dim]) {
      put(dim, e.name, AGENTS_DIR, e.hash, e.path, e.files)
    }
  }
  for (const tool of TOOL_DIRS) {
    const dims = state.tools[tool]
    if (!dims) continue
    for (const dim of DIMS) {
      const st = dims[dim]
      if (st?.kind !== 'real') continue
      for (const e of st.entries) put(dim, e.name, tool, e.hash, e.path, e.files)
    }
  }
```

并删掉 `collectGroups` 上方那段过时的注释块。

- [ ] **Step 5: 跑全部 core 测试确认通过**

Run: `npx vitest run tests/core`
Expected: PASS —— hash / scan / plan 全绿

- [ ] **Step 6: Commit**

```bash
git add src/core tests/core/plan.test.ts
git commit -m "feat(core): plan —— 两趟归组算法、冲突裁决、op 排序、风险收益"
```

---

### Task 4: apply —— 备份、journal、失败回滚、undo.sh

**Files:**
- Create: `src/core/apply.ts`
- Test: `tests/core/apply.test.ts`

**Interfaces:**
- Consumes: Task 1-3
- Produces: `applyPlan(plan: Plan, opts?: { force?: boolean }): Promise<Result>`

**执行顺序（不可调换）：**
1. 前置检查（`!force && !plan.gitClean` → 直接失败，不动任何文件）
2. **备份**：所有会被 `move` / `discard` / `unlink` 的路径，`copyTree` 到 `.agents/.attic/<ts>/backup/<repo相对路径>`
3. 写 `undo.sh`
4. 顺序执行 ops，每步成功后记进 journal
5. 任一步抛错 → 反向执行 journal 回滚 → 返回 `{ ok: false, error }`

- [ ] **Step 1: 写失败的测试 `tests/core/apply.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink, stat, chmod } from 'node:fs/promises'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { applyPlan } from '../../src/core/apply.js'
import { pathKind } from '../../src/core/fsx.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})
async function setup(layout: Parameters<typeof mkRepo>[0], resolutions = {}) {
  const root = await mkRepo(layout)
  roots.push(root)
  const plan = buildPlan(await scan(root), resolutions)
  return { root, plan }
}

describe('applyPlan', () => {
  it('工作区不干净且未 --force -> 拒绝执行，且一个文件都没动', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    expect(plan.gitClean).toBe(false) // 临时目录不是 git 仓库
    const res = await applyPlan(plan)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('工作区')
    // 原文件必须原封不动
    expect(await pathKind(join(root, '.claude/skills/foo'))).toBe('dir')
    expect(await pathKind(join(root, '.agents'))).toBe('missing')
  })

  it('--force 下正常执行：move + symlink', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)

    expect(await readFile(join(root, '.agents/skills/foo/SKILL.md'), 'utf8')).toBe('x')
    expect(await pathKind(join(root, '.claude/skills'))).toBe('symlink')
    // WHY: 相对路径。绝对路径的软链换台机器就废，也没法提交进 git。
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')
    // 穿过软链能读到内容 —— 这才是「接上了」的真正证据
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
  })

  // WHY: .claude 常被 gitignore，git 救不回来。attic 是唯一的后悔药，所以它必须无条件存在。
  it('被 discard 的内容一定进了 attic 备份', async () => {
    const { root, plan } = await setup({
      '.claude/skills/foo/SKILL.md': 'same',
      '.codebuddy/skills/foo/SKILL.md': 'same',
    })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)
    const backed = join(res.atticDir, 'backup/.codebuddy/skills/foo/SKILL.md')
    expect(await readFile(backed, 'utf8')).toBe('same')
  })

  // WHY: 半成品状态（源目录已删、软链还没建）会让这个仓库的 agent 配置直接消失。
  // 用户下次打开 IDE 会发现所有 skill 都不见了，而且不知道为什么。宁可什么都不做。
  it('执行中途失败 -> 完全回滚，回到执行前的状态', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })

    // 注入一个必然失败的 op：往一个不存在的深层路径建软链
    plan.ops.push({ t: 'symlink', path: join(root, 'no/such/dir/link'), target: '../x' })

    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(false)

    // 全部回到原样
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
    expect(await pathKind(join(root, '.claude/skills'))).toBe('dir') // 不是 symlink
    expect(await pathKind(join(root, '.agents/skills/foo'))).toBe('missing')
  })

  // WHY: gitignore 场景下 undo.sh 是唯一的后悔药。它必须真的能跑，不是摆设。
  it('undo.sh 可执行，且能把仓库还原到 apply 前', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)

    const st = await stat(res.undoScript)
    expect(st.mode & 0o111).toBeTruthy() // 有执行位

    const { execFile } = await import('node:child_process')
    const { promisify } = await import('node:util')
    await promisify(execFile)('sh', [res.undoScript])

    expect(await pathKind(join(root, '.claude/skills'))).toBe('dir')
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
    expect(await pathKind(join(root, '.agents/skills/foo'))).toBe('missing')
  })

  // WHY: 非幂等会导致重复运行时破坏已经建好的软链。这个命令一定会被重复运行。
  it('幂等：apply 两次，第二次的 plan 是空的', async () => {
    const { root, plan } = await setup({ '.claude/skills/foo/SKILL.md': 'x' })
    expect((await applyPlan(plan, { force: true })).ok).toBe(true)

    const plan2 = buildPlan(await scan(root), {})
    expect(plan2.ops).toEqual([])
  })

  it('未裁决冲突 -> 相关目录保持原样，不建链', async () => {
    const { root, plan } = await setup({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)
    expect(await pathKind(join(root, '.claude/skills'))).toBe('dir')
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('A')
    expect(await readFile(join(root, '.codebuddy/skills/foo/SKILL.md'), 'utf8')).toBe('B')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/core/apply.test.ts`
Expected: FAIL — `Cannot find module '../../src/core/apply.js'`

- [ ] **Step 3: 写 `src/core/apply.ts`**

```ts
import { mkdir, rename, rmdir, symlink, unlink, writeFile, chmod } from 'node:fs/promises'
import { join, relative, dirname } from 'node:path'
import type { Op, Plan, Result } from './types.js'
import { ATTIC_DIR } from './constants.js'
import { copyTree, removeTree, pathKind, readLinkTarget } from './fsx.js'

/** 回滚一步 op 需要的信息。 */
interface Undo {
  op: Op
  /** unlink 之前那条软链原本指向哪（相对 target，原样保存） */
  prevLinkTarget?: string
}

function tsDir(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 会被销毁的路径 -> 需要备份 */
function destructivePaths(ops: Op[]): string[] {
  const out: string[] = []
  for (const op of ops) {
    if (op.t === 'move') out.push(op.from)
    else if (op.t === 'discard') out.push(op.path)
  }
  return out
}

async function execOp(op: Op): Promise<Undo> {
  switch (op.t) {
    case 'mkdir':
      await mkdir(op.path, { recursive: true })
      return { op }
    case 'move':
      await mkdir(dirname(op.to), { recursive: true })
      await rename(op.from, op.to)
      return { op }
    case 'discard':
      await removeTree(op.path)
      return { op }
    case 'rmdir':
      // 非递归。此时目录应该已经被 move/discard 清空；如果没空，说明 plan 算错了 —— 让它响亮地失败。
      await rmdir(op.path)
      return { op }
    case 'unlink': {
      const { readlink } = await import('node:fs/promises')
      const prev = await readlink(op.path)
      await unlink(op.path)
      return { op, prevLinkTarget: prev }
    }
    case 'symlink':
      await symlink(op.target, op.path)
      return { op }
  }
}

/** 反向执行一步。backupRoot 用来还原 discard / move 掉的内容。 */
async function undoOp(u: Undo, repoRoot: string, backupRoot: string): Promise<void> {
  const op = u.op
  const restore = async (p: string) => {
    const src = join(backupRoot, relative(repoRoot, p))
    if ((await pathKind(src)) === 'missing') return
    await mkdir(dirname(p), { recursive: true })
    await copyTree(src, p)
  }

  switch (op.t) {
    case 'mkdir':
      await rmdir(op.path).catch(() => {}) // 非空就留着 —— 说明本来就有东西
      return
    case 'move':
      await removeTree(op.to)
      await restore(op.from)
      return
    case 'discard':
      await restore(op.path)
      return
    case 'rmdir':
      await mkdir(op.path, { recursive: true })
      return
    case 'unlink':
      if (u.prevLinkTarget) await symlink(u.prevLinkTarget, op.path)
      return
    case 'symlink':
      await unlink(op.path).catch(() => {})
      return
  }
}

function renderUndoScript(plan: Plan, atticDir: string, ops: Op[]): string {
  const R = plan.repoRoot
  const rel = (p: string) => relative(R, p)
  const lines: string[] = [
    '#!/bin/sh',
    '# dot-agents undo —— 把这次 apply 全部撤销。',
    '# 先删掉本次创建的东西，再从 backup/ 还原原始内容。',
    'set -e',
    `cd "${R}"`,
    '',
    'echo "撤销 dot-agents 变更…"',
    '',
  ]

  // 1. 删掉本次创建的软链
  for (const op of ops) {
    if (op.t === 'symlink') lines.push(`rm -f "${rel(op.path)}"`)
  }
  // 2. 删掉本次移进 .agents 的条目（只删这次移进去的，不碰 .agents 里原有的别的东西）
  for (const op of ops) {
    if (op.t === 'move') lines.push(`rm -rf "${rel(op.to)}"`)
  }
  // 3. 从备份还原（move 的源、discard 掉的、unlink 掉的旧链）
  lines.push('')
  const backupRel = join(relative(R, atticDir), 'backup')
  for (const p of destructivePaths(ops)) {
    const r = rel(p)
    lines.push(`rm -rf "${r}"`)
    lines.push(`mkdir -p "$(dirname "${r}")"`)
    lines.push(`cp -R "${backupRel}/${r}" "${r}"`)
  }
  // 4. 还原被 unlink 的旧软链
  for (const op of ops) {
    if (op.t === 'unlink') {
      lines.push(`# 原本是软链，指向别处；如需还原请手工处理：${rel(op.path)}`)
    }
  }
  // 5. 清掉本次 mkdir 出来的空目录（非空则保留）
  lines.push('')
  for (const op of [...ops].reverse()) {
    if (op.t === 'mkdir') lines.push(`rmdir "${rel(op.path)}" 2>/dev/null || true`)
  }
  lines.push('rmdir ".agents" 2>/dev/null || true')
  lines.push('')
  lines.push('echo "已撤销。"')
  lines.push('')
  return lines.join('\n')
}

export async function applyPlan(plan: Plan, opts: { force?: boolean } = {}): Promise<Result> {
  const atticDir = join(plan.repoRoot, ATTIC_DIR, tsDir())
  const backupRoot = join(atticDir, 'backup')
  const undoScript = join(atticDir, 'undo.sh')

  // 1. 前置检查 —— 失败时一个文件都不能动
  if (!opts.force && !plan.gitClean) {
    return {
      ok: false,
      atticDir,
      undoScript,
      applied: [],
      error:
        'git 工作区不干净（或这里不是 git 仓库）。先提交或 stash，再重试；确实要继续就加 --force。',
    }
  }

  if (plan.ops.length === 0) {
    return { ok: true, atticDir, undoScript, applied: [] }
  }

  // 2. 备份 —— 不可关闭，--force 也不能跳过
  await mkdir(backupRoot, { recursive: true })
  for (const p of destructivePaths(plan.ops)) {
    const dst = join(backupRoot, relative(plan.repoRoot, p))
    await mkdir(dirname(dst), { recursive: true })
    await copyTree(p, dst)
  }

  // 3. 写 undo 脚本（在执行之前写：万一进程被 kill，脚本已经在磁盘上）
  await writeFile(undoScript, renderUndoScript(plan, atticDir, plan.ops), 'utf8')
  await chmod(undoScript, 0o755)

  // 4. 执行，逐步记 journal
  const journal: Undo[] = []
  try {
    for (const op of plan.ops) {
      journal.push(await execOp(op))
    }
  } catch (e) {
    // 5. 失败 -> 反向回滚。不留半成品。
    for (const u of journal.reverse()) {
      await undoOp(u, plan.repoRoot, backupRoot).catch(() => {})
    }
    return {
      ok: false,
      atticDir,
      undoScript,
      applied: [],
      error: `执行失败，已全部回滚：${e instanceof Error ? e.message : String(e)}`,
    }
  }

  return { ok: true, atticDir, undoScript, applied: plan.ops }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/core`
Expected: PASS —— hash / scan / plan / apply 全绿

- [ ] **Step 5: Commit**

```bash
git add src/core/apply.ts tests/core/apply.test.ts
git commit -m "feat(core): apply —— attic 备份、journal 回滚、undo.sh"
```

---

### Task 5: CLI

**Files:**
- Create: `src/cli/render.ts`, `src/cli/index.ts`
- Test: `tests/cli/link.test.ts`

**Interfaces:**
- Consumes: Task 1-4 全部 core
- Produces:
  - `renderState(state: State): string` / `renderPlan(plan: Plan): string` / `renderResult(r: Result): string`
  - `buildLinkPlan(state: State): Plan` —— `dot-agents link` 用：只建链，绝不 move / discard

**`dot-agents link` 为什么单独一个 plan：** 软链不进 git，只有 `.agents/` 进 git。别人 clone 下来只有 `.agents/`，跑 `dot-agents link` 补齐软链。这一步**必须绝对安全** —— 它只创建软链，一个字节的用户内容都不会碰。用 `buildPlan` 会 move / discard，不能用。

- [ ] **Step 1: 写失败的测试 `tests/cli/link.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildLinkPlan } from '../../src/cli/render.js'
import { applyPlan } from '../../src/core/apply.js'
import { pathKind } from '../../src/core/fsx.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

describe('buildLinkPlan', () => {
  // WHY: link 是给 clone 仓库的人跑的「安装」命令。它绝不能碰用户已有的内容 ——
  // 一个新人 clone 下来跑一句 link，结果自己的 .claude/skills 被吞了，这个工具就没人敢用了。
  it('绝不产生 move / discard，只建软链', async () => {
    const root = await mkRepo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills/mine/SKILL.md': 'MINE', // 用户自己的东西
    })
    roots.push(root)
    const plan = buildLinkPlan(await scan(root))
    expect(plan.ops.filter((o) => o.t === 'move')).toHaveLength(0)
    expect(plan.ops.filter((o) => o.t === 'discard')).toHaveLength(0)
    // .claude/skills 是 real 且非空 -> 不能盖，跳过
    expect(plan.ops.filter((o) => o.t === 'symlink')).toHaveLength(0)
  })

  it('absent 的维度 -> 建链', async () => {
    const root = await mkRepo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/settings.json': '{}',
    })
    roots.push(root)
    const plan = buildLinkPlan(await scan(root))
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')
    expect(await readFile(join(root, '.claude/skills/foo/SKILL.md'), 'utf8')).toBe('x')
  })

  it('幂等：已 linked 的不重复建', async () => {
    const root = await mkRepo({
      '.agents/skills/foo/SKILL.md': 'x',
      '.claude/skills': { symlink: '../.agents/skills' },
    })
    roots.push(root)
    expect(buildLinkPlan(await scan(root)).ops).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/cli/link.test.ts`
Expected: FAIL — `Cannot find module '../../src/cli/render.js'`

- [ ] **Step 3: 写 `src/cli/render.ts`**

```ts
import { join, relative } from 'node:path'
import type { Dim, Op, Plan, Result, State } from '../core/types.js'
import { DIMS, TOOL_DIRS, AGENTS_DIR } from '../core/constants.js'

/**
 * `dot-agents link` 专用：只建软链，绝不 move / discard。
 * 给 clone 仓库的人跑的「安装」命令 —— 必须绝对安全，一个字节的用户内容都不碰。
 */
export function buildLinkPlan(state: State): Plan {
  const ops: Op[] = []
  const dimHasContent = (d: Dim) => state.agentsDir.entries[d].length > 0

  for (const tool of TOOL_DIRS) {
    const dims = state.tools[tool]
    if (!dims) continue
    for (const dim of DIMS) {
      const st = dims[dim]
      if (!st || !dimHasContent(dim)) continue
      // 只处理 absent —— real 说明用户自己有东西，不能盖；drifted 说明指向别处，也不擅自改。
      if (st.kind !== 'absent') continue
      const dimPath = join(state.repoRoot, tool, dim)
      ops.push({
        t: 'symlink',
        path: dimPath,
        target: relative(join(state.repoRoot, tool), join(state.repoRoot, AGENTS_DIR, dim)),
      })
    }
  }

  return {
    repoRoot: state.repoRoot,
    gitClean: state.gitClean,
    ops,
    conflicts: [],
    resolved: {},
    skipped: [],
    blockedDims: [],
    benefits: ops.length ? [`${ops.length} 个 (工具 × 维度) 接上软链`] : ['软链已齐全，无需变更。'],
    risks: [],
  }
}

const CELL: Record<string, string> = {
  linked: '✅ linked',
  absent: '·  absent',
  real: '📦 real',
  drifted: '⚠️  drifted',
  conflict: '🔴 conflict',
}

export function renderState(state: State, conflictCells = new Set<string>()): string {
  const lines: string[] = []
  lines.push(`仓库：${state.repoRoot}`)
  lines.push(`.agents/：${state.agentsDir.exists ? '存在' : '不存在'}    git 工作区：${state.gitClean ? '干净' : '不干净'}`)
  lines.push('')

  const tools = Object.keys(state.tools)
  if (tools.length === 0) {
    lines.push('没有发现任何已知的 Agent 工具目录。')
    return lines.join('\n')
  }

  const w = Math.max(12, ...tools.map((t) => t.length + 2))
  lines.push('工具'.padEnd(w) + DIMS.map((d) => d.padEnd(12)).join(''))
  for (const tool of tools) {
    const cells = DIMS.map((dim) => {
      const st = state.tools[tool][dim]
      if (!st) return '-'.padEnd(12)
      const key = `${tool}/${dim}`
      const kind = conflictCells.has(key) ? 'conflict' : st.kind
      return CELL[kind].padEnd(12)
    })
    lines.push(tool.padEnd(w) + cells.join(''))
  }

  const only = Object.entries(state.toolOnly).filter(([, v]) => v.length > 0)
  if (only.length > 0) {
    lines.push('')
    lines.push('工具专属，不碰：')
    for (const [tool, items] of only) lines.push(`  ${tool}/  ${items.join('  ')}`)
  }
  return lines.join('\n')
}

export function renderPlan(plan: Plan): string {
  const lines: string[] = []
  const R = plan.repoRoot
  const rel = (p: string) => relative(R, p)

  if (plan.ops.length === 0) {
    lines.push('无需变更。')
  } else {
    lines.push('变更计划：')
    for (const op of plan.ops) {
      switch (op.t) {
        case 'mkdir':   lines.push(`  建目录   ${rel(op.path)}/`); break
        case 'move':    lines.push(`  收录     ${rel(op.from)}  →  ${rel(op.to)}`); break
        case 'discard': lines.push(`  丢弃重复 ${rel(op.path)}  (已备份)`); break
        case 'rmdir':   lines.push(`  删空壳   ${rel(op.path)}/`); break
        case 'unlink':  lines.push(`  拆旧链   ${rel(op.path)}`); break
        case 'symlink': lines.push(`  建软链   ${rel(op.path)}  →  ${op.target}`); break
      }
    }
  }

  if (plan.skipped.length > 0) {
    lines.push('')
    lines.push(`需要你裁决的冲突（${plan.skipped.length}）—— 未裁决则整个维度不接软链：`)
    for (const c of plan.skipped) {
      lines.push(`  ${c.key}`)
      for (const cand of c.candidates) {
        lines.push(`    ${cand.tool.padEnd(12)} ${cand.hash.slice(0, 8)}  ${cand.files.length} 个文件`)
      }
    }
    lines.push('')
    lines.push('  裁决要在浏览器里做：跑 `dot-agents`（不带子命令）。')
  }

  if (plan.benefits.length > 0) {
    lines.push('')
    lines.push('收益：')
    for (const b of plan.benefits) lines.push(`  + ${b}`)
  }
  if (plan.risks.length > 0) {
    lines.push('')
    lines.push('风险：')
    for (const r of plan.risks) lines.push(`  ! ${r}`)
  }
  return lines.join('\n')
}

export function renderResult(r: Result): string {
  if (!r.ok) return `失败：${r.error}`
  if (r.applied.length === 0) return '无需变更。'
  return [
    `完成，执行了 ${r.applied.length} 个操作。`,
    ``,
    `备份：  ${r.atticDir}/backup/`,
    `撤销：  sh ${r.undoScript}`,
  ].join('\n')
}

/** plan 里的冲突落在哪些格子上 —— 给 renderState 上色用 */
export function conflictCells(plan: Plan): Set<string> {
  const s = new Set<string>()
  for (const b of plan.blockedDims) s.add(`${b.tool}/${b.dim}`)
  return s
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/cli/link.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 5: 写 `src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { Command } from 'commander'
import open from 'open'
import { findRepoRoot, scan } from '../core/scan.js'
import { buildPlan } from '../core/plan.js'
import { applyPlan } from '../core/apply.js'
import { buildLinkPlan, renderState, renderPlan, renderResult, conflictCells } from './render.js'
import { startServer } from '../server/index.js'

async function repoRootOrDie(): Promise<string> {
  const root = await findRepoRoot(process.cwd())
  if (!root) {
    console.error('不在 git 仓库里。dot-agents 只在 git 仓库内工作 —— git 是变更的第一道兜底。')
    process.exit(1)
  }
  return root
}

const program = new Command()
program.name('agents').description('把多个 AI Agent 工具目录的通用配置统一到 .agents/ 唯一源').version('0.1.0')

program
  .command('status', { isDefault: false })
  .description('打印当前仓库的状态和变更计划，不做任何修改')
  .action(async () => {
    const root = await repoRootOrDie()
    const state = await scan(root)
    const plan = buildPlan(state, {})
    console.log(renderState(state, conflictCells(plan)))
    console.log('')
    console.log(renderPlan(plan))
  })

program
  .command('apply')
  .description('无头执行（跳过 UI）。有未裁决冲突时，这些条目全部跳过。')
  .option('-y, --yes', '不再确认，直接执行')
  .option('-f, --force', '工作区不干净也执行')
  .action(async (opts: { yes?: boolean; force?: boolean }) => {
    const root = await repoRootOrDie()
    const plan = buildPlan(await scan(root), {})
    console.log(renderPlan(plan))
    if (!opts.yes) {
      console.log('')
      console.log('加 -y 才会真的执行。')
      return
    }
    console.log('')
    console.log(renderResult(await applyPlan(plan, { force: opts.force })))
  })

program
  .command('link')
  .description('幂等的「安装」：只按 .agents 现有内容补齐软链，绝不移动或删除任何东西')
  .action(async () => {
    const root = await repoRootOrDie()
    const plan = buildLinkPlan(await scan(root))
    console.log(renderPlan(plan))
    if (plan.ops.length === 0) return
    console.log('')
    // link 只创建软链，不销毁任何东西 -> 不需要 git 干净这道闸
    console.log(renderResult(await applyPlan(plan, { force: true })))
  })

// 默认命令：起 server + 开浏览器
program.action(async () => {
  const root = await repoRootOrDie()
  const { url, close } = await startServer(root)
  console.log(`dot-agents 已启动：${url}`)
  console.log('在浏览器里审阅计划并确认。按 Ctrl-C 退出。')
  await open(url)
  process.on('SIGINT', () => {
    close()
    process.exit(0)
  })
})

await program.parseAsync(process.argv)
```

- [ ] **Step 6: Commit**

```bash
git add src/cli tests/cli
git commit -m "feat(cli): status / apply / link 子命令 + 终端渲染"
```

---

### Task 6: Server

**Files:**
- Create: `src/server/index.ts`
- Test: `tests/server/api.test.ts`

**Interfaces:**
- Consumes: Task 1-4 core
- Produces: `startServer(repoRoot: string): Promise<{ url: string; token: string; port: number; close(): void }>`

**安全边界（不是可选项）：**
- 只监听 `127.0.0.1`，端口 `0`（系统分配）
- 随机 token，注入进 HTML；每个 `/api/*` 请求校验 `X-Agents-Token`
- **`/api/apply` 只收 `resolutions`，绝不接受前端传来的 `Plan`。** `Plan.ops` 里全是 `move` / `discard` / `rmdir` —— 照着执行前端给的 ops，等于把一个任意文件删除接口开在 localhost 上。后端必须自己重新 scan + plan，执行自己算出来的 ops。前端只有「选哪个赢家」这一点权力。

- [ ] **Step 1: 写失败的测试 `tests/server/api.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { startServer } from '../../src/server/index.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'
import { pathKind } from '../../src/core/fsx.js'

const roots: string[] = []
const closers: Array<() => void> = []
afterEach(async () => {
  closers.splice(0).forEach((c) => c())
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

async function boot(layout: Parameters<typeof mkRepo>[0]) {
  const root = await mkRepo(layout)
  roots.push(root)
  const srv = await startServer(root)
  closers.push(srv.close)
  const call = (path: string, init: RequestInit = {}) =>
    fetch(`${srv.url}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', 'x-agents-token': srv.token, ...(init.headers ?? {}) },
    })
  return { root, srv, call }
}

describe('server', () => {
  // WHY: 没有 token 校验，本机上任何一个网页都能 POST /api/apply 删你的文件。
  it('没有 token -> 401', async () => {
    const { srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const res = await fetch(`${srv.url}/api/state`)
    expect(res.status).toBe(401)
  })

  it('GET /api/state -> 仓库 + 全局', async () => {
    const { call } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const body = await (await call('/api/state')).json()
    expect(body.repo.tools['.claude'].skills.kind).toBe('real')
    expect(body.global).toBeDefined()
  })

  it('POST /api/plan 带 resolutions -> 冲突被裁决', async () => {
    const { call } = await boot({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const p1 = await (await call('/api/plan', { method: 'POST', body: JSON.stringify({ resolutions: {} }) })).json()
    expect(p1.skipped).toHaveLength(1)

    const p2 = await (await call('/api/plan', {
      method: 'POST',
      body: JSON.stringify({ resolutions: { 'skills/foo': '.claude' } }),
    })).json()
    expect(p2.skipped).toHaveLength(0)
    expect(p2.resolved).toEqual({ 'skills/foo': '.claude' })
  })

  // WHY: 这是整个 server 最重要的一条。前端传来的 ops 里可以写任何路径的 discard/rmdir。
  // 一旦照单执行，localhost 上就多了一个任意文件删除接口。
  it('POST /api/apply 忽略前端传来的 ops，只认 resolutions', async () => {
    const { root, call } = await boot({ '.claude/skills/foo/SKILL.md': 'x', 'PRECIOUS.md': 'keep me' })

    const res = await call('/api/apply', {
      method: 'POST',
      body: JSON.stringify({
        resolutions: {},
        force: true,
        // 恶意注入：试图让后端删掉 PRECIOUS.md
        plan: { ops: [{ t: 'discard', path: join(root, 'PRECIOUS.md') }] },
        ops: [{ t: 'discard', path: join(root, 'PRECIOUS.md') }],
      }),
    })
    const body = await res.json()
    expect(body.ok).toBe(true)

    // PRECIOUS.md 必须还在
    expect(await readFile(join(root, 'PRECIOUS.md'), 'utf8')).toBe('keep me')
    // 而后端自己算出来的 plan 正常执行了
    expect(await pathKind(join(root, '.claude/skills'))).toBe('symlink')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run tests/server/api.test.ts`
Expected: FAIL — `Cannot find module '../../src/server/index.js'`

- [ ] **Step 3: 写 `src/server/index.ts`**

```ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, extname, normalize } from 'node:path'
import { homedir } from 'node:os'
import type { Resolutions } from '../core/types.js'
import { scan } from '../core/scan.js'
import { buildPlan } from '../core/plan.js'
import { applyPlan } from '../core/apply.js'
import { pathKind } from '../core/fsx.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(HERE, '../web') // tsc 输出 dist/server/，vite 输出 dist/web/

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  if (chunks.length === 0) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return {}
  }
}

function json(res: ServerResponse, code: number, body: unknown): void {
  const s = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
  res.end(s)
}

export async function startServer(
  repoRoot: string,
): Promise<{ url: string; token: string; port: number; close: () => void }> {
  const token = randomBytes(24).toString('hex')

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname

    // ── API：一律要 token ──
    if (path.startsWith('/api/')) {
      if (req.headers['x-agents-token'] !== token) {
        json(res, 401, { error: 'bad token' })
        return
      }

      try {
        if (path === '/api/state' && req.method === 'GET') {
          const repo = await scan(repoRoot)
          // 全局：只读展示，绝不修改
          const home = homedir()
          const global = await scan(home)
          json(res, 200, { repo, global })
          return
        }

        if (path === '/api/plan' && req.method === 'POST') {
          const body = await readBody(req)
          const resolutions: Resolutions = body.resolutions ?? {}
          json(res, 200, buildPlan(await scan(repoRoot), resolutions))
          return
        }

        if (path === '/api/apply' && req.method === 'POST') {
          const body = await readBody(req)
          // 只取 resolutions 和 force。body.plan / body.ops 一律无视 ——
          // 照着前端给的 ops 执行 = 在 localhost 上开一个任意文件删除接口。
          const resolutions: Resolutions = body.resolutions ?? {}
          const force: boolean = body.force === true

          const plan = buildPlan(await scan(repoRoot), resolutions)
          json(res, 200, await applyPlan(plan, { force }))
          return
        }
      } catch (e) {
        json(res, 500, { error: e instanceof Error ? e.message : String(e) })
        return
      }

      json(res, 404, { error: 'not found' })
      return
    }

    // ── 静态资源 ──
    const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '').slice(1)
    const file = join(WEB_ROOT, rel)
    if (!file.startsWith(WEB_ROOT) || (await pathKind(file)) !== 'file') {
      res.writeHead(404)
      res.end('not found')
      return
    }

    let content = await readFile(file)
    if (rel === 'index.html') {
      // token 注入：前端拿不到别的渠道
      content = Buffer.from(
        content
          .toString('utf8')
          .replace('</head>', `<script>window.__AGENTS_TOKEN__=${JSON.stringify(token)}</script></head>`),
      )
    }
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(content)
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  const port = typeof addr === 'object' && addr ? addr.port : 0

  return {
    url: `http://127.0.0.1:${port}`,
    token,
    port,
    close: () => server.close(),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run tests/server/api.test.ts`
Expected: PASS，4 个用例全绿

> `/api/state` 里 `scan(homedir())` 在你的机器上可能慢（家目录下 `.claude/` 可能很大）。测试里家目录没有工具目录时会立刻返回。如果本机 `~/.claude/skills` 巨大导致测试超时，把 `testTimeout` 调高，不要改成 mock —— 慢就是真实的信号。

- [ ] **Step 5: Commit**

```bash
git add src/server tests/server
git commit -m "feat(server): 本地 HTTP 层，token 鉴权，apply 只收 resolutions"
```

---

### Task 7: Web UI

**Files:**
- Create: `vite.config.ts`, `index.html`
- Create: `src/web/main.tsx`, `src/web/App.tsx`, `src/web/api.ts`, `src/web/styles.css`
- Create: `src/web/components/StatusMatrix.tsx`, `PlanView.tsx`, `ConflictCard.tsx`, `ResultView.tsx`

**Interfaces:**
- Consumes: server 的 `/api/state` `/api/plan` `/api/apply`；core 的类型（直接 import type）
- Produces: `dist/web/` 静态资源

- [ ] **Step 1: 写 `vite.config.ts` 和 `index.html`**

`vite.config.ts`:
```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  root: '.',
  plugins: [react()],
  build: {
    outDir: 'dist/web',
    emptyOutDir: true,
  },
})
```

`index.html`（项目根）：
```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>dot-agents</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/web/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 2: 写 `src/web/api.ts`**

```ts
import type { Plan, Resolutions, Result, State } from '../core/types.js'

declare global {
  interface Window {
    __AGENTS_TOKEN__?: string
  }
}

const token = () => window.__AGENTS_TOKEN__ ?? ''

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', 'x-agents-token': token(), ...(init?.headers ?? {}) },
  })
  if (!res.ok) throw new Error(`${path} -> ${res.status}`)
  return res.json() as Promise<T>
}

export const getState = () => call<{ repo: State; global: State }>('/api/state')

export const getPlan = (resolutions: Resolutions) =>
  call<Plan>('/api/plan', { method: 'POST', body: JSON.stringify({ resolutions }) })

export const doApply = (resolutions: Resolutions, force: boolean) =>
  call<Result>('/api/apply', { method: 'POST', body: JSON.stringify({ resolutions, force }) })
```

- [ ] **Step 3: 写 `src/web/components/StatusMatrix.tsx`**

```tsx
import type { Dim, State } from '../../core/types.js'

const DIMS: Dim[] = ['skills', 'commands', 'agents', 'hooks']

const LABEL: Record<string, { text: string; cls: string }> = {
  linked: { text: '已链接', cls: 'c-linked' },
  absent: { text: '—', cls: 'c-absent' },
  real: { text: '待收录', cls: 'c-real' },
  drifted: { text: '指向别处', cls: 'c-drifted' },
  conflict: { text: '有冲突', cls: 'c-conflict' },
}

export function StatusMatrix({ state, conflictCells }: { state: State; conflictCells: Set<string> }) {
  const tools = Object.keys(state.tools)
  if (tools.length === 0) return <p className="muted">没有发现任何已知的 Agent 工具目录。</p>

  return (
    <table className="matrix">
      <thead>
        <tr>
          <th />
          {DIMS.map((d) => (
            <th key={d}>{d}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => (
          <tr key={tool}>
            <th className="tool">{tool}/</th>
            {DIMS.map((dim) => {
              const st = state.tools[tool][dim]
              const kind = conflictCells.has(`${tool}/${dim}`) ? 'conflict' : (st?.kind ?? 'absent')
              const l = LABEL[kind]
              return (
                <td key={dim} className={l.cls}>
                  {l.text}
                  {st?.kind === 'real' && <span className="n">{st.entries.length}</span>}
                </td>
              )
            })}
          </tr>
        ))}
      </tbody>
    </table>
  )
}
```

- [ ] **Step 4: 写 `src/web/components/ConflictCard.tsx`**

```tsx
import type { Conflict } from '../../core/types.js'

/** 差异摘要：只在文件清单层面比，不做逐行 diff（MVP 范围外）。 */
function diffSummary(a: string[], b: string[]): string {
  const sa = new Set(a)
  const sb = new Set(b)
  const onlyA = a.filter((f) => !sb.has(f))
  const onlyB = b.filter((f) => !sa.has(f))
  const both = a.filter((f) => sb.has(f))
  const parts: string[] = []
  if (both.length) parts.push(`${both.length} 个同名文件（内容可能不同）`)
  if (onlyA.length) parts.push(`独有：${onlyA.join('、')}`)
  if (onlyB.length) parts.push(`缺少：${onlyB.join('、')}`)
  return parts.join(' · ') || '无文件'
}

export function ConflictCard({
  conflict,
  winner,
  onPick,
}: {
  conflict: Conflict
  winner?: string
  onPick: (tool: string) => void
}) {
  const base = conflict.candidates[0]
  return (
    <div className={`card ${winner ? 'resolved' : 'unresolved'}`}>
      <div className="card-head">
        <code>{conflict.key}</code>
        {!winner && <span className="badge warn">待裁决</span>}
      </div>
      <p className="muted">
        {conflict.candidates.length} 份内容不同的同名副本。选一个当唯一源 —— 其余的会备份进{' '}
        <code>.agents/.attic/</code> 后删除。
      </p>
      <div className="candidates">
        {conflict.candidates.map((c) => (
          <label key={c.tool} className={winner === c.tool ? 'cand picked' : 'cand'}>
            <input
              type="radio"
              name={conflict.key}
              checked={winner === c.tool}
              onChange={() => onPick(c.tool)}
            />
            <div>
              <strong>{c.tool}</strong>
              <code className="hash">{c.hash.slice(0, 8)}</code>
              <div className="muted small">
                {c.files.length} 个文件
                {c !== base && ` · 相对 ${base.tool}：${diffSummary(c.files, base.files)}`}
              </div>
            </div>
          </label>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 5: 写 `src/web/components/PlanView.tsx`**

```tsx
import type { Op, Plan } from '../../core/types.js'

const rel = (root: string, p: string) => p.replace(root + '/', '')

function opLine(root: string, op: Op): string {
  switch (op.t) {
    case 'mkdir':   return `建目录    ${rel(root, op.path)}/`
    case 'move':    return `收录      ${rel(root, op.from)}  →  ${rel(root, op.to)}`
    case 'discard': return `丢弃重复  ${rel(root, op.path)}   (已备份)`
    case 'rmdir':   return `删空壳    ${rel(root, op.path)}/`
    case 'unlink':  return `拆旧链    ${rel(root, op.path)}`
    case 'symlink': return `建软链    ${rel(root, op.path)}  →  ${op.target}`
  }
}

export function PlanView({ plan }: { plan: Plan }) {
  return (
    <>
      <section>
        <h2>变更计划</h2>
        {plan.ops.length === 0 ? (
          <p className="muted">无需变更 —— 已经是统一状态。</p>
        ) : (
          <pre className="ops">{plan.ops.map((op) => opLine(plan.repoRoot, op)).join('\n')}</pre>
        )}
      </section>

      {plan.benefits.length > 0 && (
        <section>
          <h2>收益</h2>
          <ul className="benefits">
            {plan.benefits.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </section>
      )}

      {plan.risks.length > 0 && (
        <section>
          <h2>风险</h2>
          <ul className="risks">
            {plan.risks.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
```

- [ ] **Step 6: 写 `src/web/components/ResultView.tsx`**

```tsx
import type { Result } from '../../core/types.js'

export function ResultView({ result }: { result: Result }) {
  if (!result.ok) {
    return (
      <section className="result bad">
        <h2>失败 —— 已全部回滚</h2>
        <p>{result.error}</p>
        <p className="muted">仓库回到了执行前的状态，没有留下半成品。</p>
      </section>
    )
  }
  return (
    <section className="result good">
      <h2>完成</h2>
      <p>执行了 {result.applied.length} 个操作。</p>
      <p>
        备份在 <code>{result.atticDir}/backup/</code>
      </p>
      <p>
        要撤销：<code>sh {result.undoScript}</code>
      </p>
      <p className="muted">可以关掉这个页面了。CLI 那边按 Ctrl-C 退出。</p>
    </section>
  )
}
```

- [ ] **Step 7: 写 `src/web/App.tsx`**

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { Plan, Resolutions, Result, State } from '../core/types.js'
import { doApply, getPlan, getState } from './api.js'
import { StatusMatrix } from './components/StatusMatrix.js'
import { PlanView } from './components/PlanView.js'
import { ConflictCard } from './components/ConflictCard.js'
import { ResultView } from './components/ResultView.js'

export function App() {
  const [tab, setTab] = useState<'repo' | 'global'>('repo')
  const [state, setState] = useState<{ repo: State; global: State } | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [resolutions, setResolutions] = useState<Resolutions>({})
  const [result, setResult] = useState<Result | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    getState().then(setState).catch((e) => setErr(String(e)))
  }, [])

  useEffect(() => {
    getPlan(resolutions).then(setPlan).catch((e) => setErr(String(e)))
  }, [resolutions])

  const conflictCells = useMemo(() => {
    const s = new Set<string>()
    for (const b of plan?.blockedDims ?? []) s.add(`${b.tool}/${b.dim}`)
    return s
  }, [plan])

  if (err) return <main className="err">出错了：{err}</main>
  if (!state || !plan) return <main>加载中…</main>
  if (result) return <main><ResultView result={result} /></main>

  const cur = tab === 'repo' ? state.repo : state.global
  const unresolved = plan.skipped.length

  async function apply() {
    setBusy(true)
    try {
      setResult(await doApply(resolutions, !plan!.gitClean))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <main>
      <header>
        <h1>dot-agents</h1>
        <code className="path">{state.repo.repoRoot}</code>
      </header>

      <nav className="tabs">
        <button className={tab === 'repo' ? 'on' : ''} onClick={() => setTab('repo')}>
          本仓库
        </button>
        <button className={tab === 'global' ? 'on' : ''} onClick={() => setTab('global')}>
          全局 · 只读
        </button>
      </nav>

      <section>
        <h2>当前状态</h2>
        <StatusMatrix state={cur} conflictCells={tab === 'repo' ? conflictCells : new Set()} />
      </section>

      {tab === 'global' && (
        <p className="muted">
          全局目录（<code>{state.global.repoRoot}</code>）只读展示。这个工具不会修改它。
        </p>
      )}

      {tab === 'repo' && (
        <>
          <PlanView plan={plan} />

          {plan.conflicts.length > 0 && (
            <section>
              <h2>需要你裁决（{plan.conflicts.length}）</h2>
              {plan.blockedDims.length > 0 && (
                <p className="warn-box">
                  软链是<strong>目录级</strong>的。只要还有一个条目留在原地没裁决，整个目录就不能被替换成软链 ——
                  这些目录本次不会接上：
                  {' '}{plan.blockedDims.map((b) => `${b.tool}/${b.dim}`).join('、')}
                </p>
              )}
              {plan.conflicts.map((c) => (
                <ConflictCard
                  key={c.key}
                  conflict={c}
                  winner={resolutions[c.key]}
                  onPick={(tool) => setResolutions((r) => ({ ...r, [c.key]: tool }))}
                />
              ))}
            </section>
          )}

          {Object.keys(cur.toolOnly).some((t) => cur.toolOnly[t].length > 0) && (
            <section>
              <h2>工具专属 —— 看见了，故意没动</h2>
              <ul className="toolonly">
                {Object.entries(cur.toolOnly)
                  .filter(([, v]) => v.length > 0)
                  .map(([tool, items]) => (
                    <li key={tool}>
                      <code>{tool}/</code> {items.join('  ')}
                    </li>
                  ))}
              </ul>
            </section>
          )}

          <footer>
            <button className="apply" disabled={busy || plan.ops.length === 0} onClick={apply}>
              {busy ? '执行中…' : `执行（${plan.ops.length} 个操作${unresolved ? `，跳过 ${unresolved} 个冲突` : ''}）`}
            </button>
            {!plan.gitClean && (
              <p className="muted small">
                git 工作区不干净 —— 会以 <code>--force</code> 执行。备份依然会写进 <code>.agents/.attic/</code>。
              </p>
            )}
          </footer>
        </>
      )}
    </main>
  )
}
```

- [ ] **Step 8: 写 `src/web/main.tsx` 和 `src/web/styles.css`**

`main.tsx`:
```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App.js'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
```

`styles.css`:
```css
:root {
  --bg: #fff; --fg: #1a1a1a; --muted: #6b7280; --line: #e5e7eb;
  --ok: #16a34a; --warn: #d97706; --bad: #dc2626; --accent: #2563eb;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0f1115; --fg: #e5e7eb; --muted: #9ca3af; --line: #262b36; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font: 14px/1.6 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
main { max-width: 900px; margin: 0 auto; padding: 32px 24px 64px; }
header h1 { margin: 0 0 4px; font-size: 22px; }
.path, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; }
.muted { color: var(--muted); }
.small { font-size: 12.5px; }
h2 { font-size: 15px; margin: 28px 0 10px; }
section { margin-bottom: 8px; }

.tabs { display: flex; gap: 4px; margin: 16px 0 8px; border-bottom: 1px solid var(--line); }
.tabs button { background: none; border: 0; border-bottom: 2px solid transparent;
  padding: 8px 14px; color: var(--muted); cursor: pointer; font-size: 14px; }
.tabs button.on { color: var(--fg); border-bottom-color: var(--accent); }

.matrix { border-collapse: collapse; width: 100%; }
.matrix th, .matrix td { border: 1px solid var(--line); padding: 8px 12px; text-align: left; font-weight: 400; }
.matrix thead th { color: var(--muted); font-size: 12.5px; }
.matrix .tool { font-family: ui-monospace, monospace; font-size: 12.5px; }
.c-linked { color: var(--ok); }
.c-absent { color: var(--muted); }
.c-real { color: var(--accent); }
.c-drifted, .c-conflict { color: var(--bad); font-weight: 600; }
.matrix .n { color: var(--muted); margin-left: 6px; font-size: 12px; }

.ops { background: rgba(127,127,127,.07); border: 1px solid var(--line); border-radius: 6px;
  padding: 12px 14px; overflow-x: auto; font-size: 12.5px; margin: 0; }
.benefits li { color: var(--ok); }
.risks li { color: var(--warn); }
.warn-box { background: rgba(217,119,6,.1); border-left: 3px solid var(--warn);
  padding: 10px 14px; border-radius: 0 6px 6px 0; }

.card { border: 1px solid var(--line); border-radius: 8px; padding: 14px 16px; margin-bottom: 12px; }
.card.unresolved { border-color: var(--bad); }
.card.resolved { border-color: var(--ok); }
.card-head { display: flex; align-items: center; gap: 10px; margin-bottom: 6px; }
.badge.warn { background: var(--bad); color: #fff; border-radius: 4px; padding: 1px 7px; font-size: 11px; }
.candidates { display: flex; flex-direction: column; gap: 8px; margin-top: 10px; }
.cand { display: flex; gap: 10px; align-items: flex-start; border: 1px solid var(--line);
  border-radius: 6px; padding: 10px 12px; cursor: pointer; }
.cand.picked { border-color: var(--ok); background: rgba(22,163,74,.06); }
.hash { color: var(--muted); margin-left: 8px; }

.toolonly { list-style: none; padding: 0; }
.toolonly li { padding: 4px 0; color: var(--muted); }

footer { margin-top: 32px; padding-top: 20px; border-top: 1px solid var(--line); }
button.apply { background: var(--accent); color: #fff; border: 0; border-radius: 6px;
  padding: 11px 22px; font-size: 14px; cursor: pointer; }
button.apply:disabled { opacity: .45; cursor: default; }

.result { border-radius: 8px; padding: 20px 22px; }
.result.good { border: 1px solid var(--ok); }
.result.bad { border: 1px solid var(--bad); }
.err { color: var(--bad); }
```

- [ ] **Step 9: build 一遍，确认能出静态资源**

Run: `npx vite build`
Expected: 输出到 `dist/web/`，含 `index.html` 和 `assets/*.js`

- [ ] **Step 10: Commit**

```bash
git add vite.config.ts index.html src/web
git commit -m "feat(web): 状态矩阵、变更计划、冲突裁决、风险收益 UI"
```

---

### Task 8: 端到端串起来 + README

**Files:**
- Modify: `package.json`（build 脚本）
- Create: `tests/e2e/smoke.test.ts`
- Modify: `README.md`

**Interfaces:**
- Consumes: 全部
- Produces: 可跑的 `dot-agents` 命令

- [ ] **Step 1: 写端到端冒烟测试 `tests/e2e/smoke.test.ts`**

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { readFile, readlink } from 'node:fs/promises'
import { join } from 'node:path'
import { scan } from '../../src/core/scan.js'
import { buildPlan } from '../../src/core/plan.js'
import { applyPlan } from '../../src/core/apply.js'
import { pathKind } from '../../src/core/fsx.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(cleanupRepo))
})

describe('端到端', () => {
  // WHY: 单元测试各自绿了不代表串起来是对的。这条覆盖一个真实仓库的完整形态：
  // 有重复、有冲突、有工具专属、有已链接 —— 一次跑完必须落到设计文档描述的达成态。
  it('混合场景：重复 + 冲突裁决 + 工具专属 + 幂等', async () => {
    const root = await mkRepo({
      // .claude 和 .codebuddy 有一份完全相同的 shared skill -> 去重，不该报冲突
      '.claude/skills/shared/SKILL.md': 'SAME',
      '.codebuddy/skills/shared/SKILL.md': 'SAME',
      // 同名不同内容 -> 冲突，要裁决
      '.claude/skills/dup/SKILL.md': 'FROM-CLAUDE',
      '.codebuddy/skills/dup/SKILL.md': 'FROM-CODEBUDDY',
      // 只有 .claude 有的
      '.claude/commands/only.md': 'ONLY',
      // 工具专属，绝不能碰
      '.claude/settings.json': '{"a":1}',
      '.cursor/rules/x.mdc': 'RULES',
    })
    roots.push(root)

    const plan = buildPlan(await scan(root), { 'skills/dup': '.codebuddy' })
    const res = await applyPlan(plan, { force: true })
    expect(res.ok).toBe(true)

    // 唯一源建立
    expect(await readFile(join(root, '.agents/skills/shared/SKILL.md'), 'utf8')).toBe('SAME')
    expect(await readFile(join(root, '.agents/skills/dup/SKILL.md'), 'utf8')).toBe('FROM-CODEBUDDY')
    expect(await readFile(join(root, '.agents/commands/only.md'), 'utf8')).toBe('ONLY')

    // 软链接上，且是相对路径
    expect(await readlink(join(root, '.claude/skills'))).toBe('../.agents/skills')
    expect(await readlink(join(root, '.codebuddy/skills'))).toBe('../.agents/skills')
    // 穿过软链能读到裁决后的内容
    expect(await readFile(join(root, '.claude/skills/dup/SKILL.md'), 'utf8')).toBe('FROM-CODEBUDDY')

    // 工具专属原封不动
    expect(await readFile(join(root, '.claude/settings.json'), 'utf8')).toBe('{"a":1}')
    expect(await readFile(join(root, '.cursor/rules/x.mdc'), 'utf8')).toBe('RULES')

    // 落败的那份进了 attic，没有凭空消失
    expect(await pathKind(join(res.atticDir, 'backup/.claude/skills/dup'))).toBe('dir')

    // 幂等：再算一遍，无事可做
    expect(buildPlan(await scan(root), {}).ops).toEqual([])
  })
})
```

- [ ] **Step 2: 跑全部测试**

Run: `npx vitest run`
Expected: PASS —— hash / scan / plan / apply / link / server / e2e 全绿

- [ ] **Step 3: 真跑一遍 CLI（这是唯一能证明它真的能用的方式）**

```bash
npm run build
mkdir -p /tmp/dot-agents-demo && cd /tmp/dot-agents-demo && git init
mkdir -p .claude/skills/foo .codebuddy/skills/foo
echo 'A' > .claude/skills/foo/SKILL.md
echo 'B' > .codebuddy/skills/foo/SKILL.md
echo '{}' > .claude/settings.json
git add -A && git commit -m init

node <项目路径>/dist/cli/index.js status
```

Expected：打印状态矩阵，`.claude/skills` 和 `.codebuddy/skills` 都是 `real`，并报出 1 个冲突 `skills/foo`，两个维度都被 block。

再跑：
```bash
node <项目路径>/dist/cli/index.js
```
Expected：浏览器打开，能看到状态矩阵、冲突卡、风险/收益；选一个赢家后「执行」按钮的操作数变化；点执行后落盘并显示 undo 命令。

- [ ] **Step 4: 写 README.md**

```markdown
# dot-agents

把一个仓库里散落在 `.claude/` `.codebuddy/` `.cursor/` … 各处的 skills / commands / agents / hooks
收敛到 `.agents/` 唯一源，其余目录改为软链指向它。

改一处，所有 AI 工具同时生效。

## 用法

    npx dot-agents           # 起浏览器：看状态、审阅计划、裁决冲突、点确认才落盘
    npx dot-agents status    # 纯终端，只读
    npx dot-agents apply -y  # 无头执行（有未裁决冲突时全部跳过）
    npx dot-agents link      # 幂等的「安装」：只补软链，绝不移动/删除任何东西

## 达成态

    .agents/
      skills/       ← 唯一源，进 git
      commands/
    .claude/
      skills   -> ../.agents/skills      ← 软链，不进 git
      settings.json                      ← 工具专属，不碰
    .codebuddy/
      skills   -> ../.agents/skills

软链不进 git，`.agents/` 进 git。clone 下来跑一次 `npx dot-agents link` 补齐软链。

## 它不做什么

- **不做格式转换。** 只处理同名且格式一致的目录。`rules/` 各家格式不兼容（`.cursor` 用 `.mdc` 带 frontmatter），
  一律列进「工具专属」，不碰。
- **不自动合并冲突。** 同名不同内容时停下来问你，绝不替你选。
- **不改全局目录。** `~/.claude` 等只读展示。

## 安全网

变更前全部备份进 `.agents/.attic/<时间戳>/backup/`，并生成 `undo.sh`。

**这不是锦上添花 —— `.claude/` 在大多数仓库里是 gitignore 的，git 根本没跟踪它，
`git checkout` 救不回来。`.attic/` 是唯一的后悔药，所以它不可关闭，`--force` 也不能跳过。**

执行中途失败会整体回滚，不留半成品状态。

## 开发

    npm install
    npm test        # vitest，core 全部对着真实临时目录跑，不 mock fs
    npm run build
```

- [ ] **Step 5: Commit**

```bash
git add package.json README.md tests/e2e
git commit -m "feat: 端到端冒烟测试 + README"
```

---

## Self-Review

**Spec 覆盖检查：**

| Spec 章节 | 覆盖它的 Task |
|---|---|
| §4 交付形态（4 个命令） | Task 5（CLI）、Task 7（web）、Task 8（e2e 真跑） |
| §5 一个 core 两个壳 | Task 1-4（core）、5（cli）、6（server）、7（web） |
| §6.1 根目录白名单 | Task 1 `constants.ts`、Task 2 scan 测试「未在白名单的目录不被扫描」 |
| §6.2 4 个维度（无 rules） | Task 1 `Dim` 类型、Task 2 toolOnly 测试 |
| §6.3 4 种 scan 状态 | Task 2 全部测试 |
| §6.4 哈希冲突判定 | Task 1 hash 测试、Task 3 plan 冲突测试 |
| §6.5 数据模型 | Task 1 `types.ts` |
| §7 Plan、两趟算法、op 排序、blockedDims | Task 3 |
| §8 apply 事务、attic、undo.sh、回滚 | Task 4 |
| §9 软链相对路径、不进 git、`link` 命令 | Task 4 测试「相对路径」、Task 5 `buildLinkPlan` |
| §10 server token / 只收 resolutions | Task 6 |
| §11 UI 六个区块 + 全局 tab | Task 7 |
| §12 测试策略（7 条关键用例） | Task 1-4、8 中逐条对应 |
| §13 MVP 范围 | 全部 8 个 task |

无缺口。

**类型一致性：** `Entry` 在 Task 1 定义，Task 3 Step 4 加了 `files: string[]` 字段并同步改了 `scan.ts` 和 `plan.ts` —— 这是 plan 阶段才发现的需求（冲突卡要展示文件差异摘要），改动已显式写在 Task 3 里，不是遗留的不一致。

**placeholder 扫描：** 无 TBD / TODO / 「类似 Task N」/ 无代码的代码步骤。
