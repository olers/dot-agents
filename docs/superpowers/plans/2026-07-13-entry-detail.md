# 条目详情（描述预览 + 内容侧栏）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图上的每个条目行 hover 能看到它的 frontmatter 描述，点击能在右侧滑出侧栏，看到来源路径、完整描述、文件清单和逐个文件的内容。

**Architecture:** `scan` 顺手解析 frontmatter 把 `desc` 塞进 `Entry`（随 `/api/state` 一起到前端，零额外请求）；文件内容懒加载，走一个新的只读接口 `GET /api/file`，路径白名单和 scan 的视野严格一致；`graph.ts` 给每个可点的 `Row` 挂一个指回真实条目的 `ref`；hover 提示用绝对定位，不进文档流，行高不变，接线柱不用重量。

**Tech Stack:** TypeScript / Node 20 / React 18 / Vite / Vitest。运行时依赖只有 `commander` 和 `open` —— **本计划不新增任何依赖**。

## Global Constraints

- **不新增任何 npm 依赖。** frontmatter 解析手写（只认 `description:` 一个 key），不引 YAML parser。测试不引 jsdom / testing-library —— 组件测试沿用现有的 `renderToStaticMarkup` 路子。
- **注释用中文**，写「为什么」，不写「这行干什么」。匹配现有文件的注释密度和语气。
- **测试对着真实临时目录跑，不 mock fs。** 沿用 `tests/helpers/mkrepo.ts` 的 `mkRepo` / `cleanupRepo`。
- **`/api/file` 是本次改动引入的唯一攻击面。** 白名单必须写死：真实路径（`realpath` 之后）必须落在 `<root>/<dotdir>/<dim>/` 之下，`root ∈ {repoRoot, homedir}`，`dotdir ∈ TOOL_DIRS ∪ {.agents}`，`dim ∈ DIMS`，前缀以路径分隔符结尾。
- `MAX_PEEK = 256 * 1024`，`MAX_DESC = 500`。
- 每个任务跑 `npm test` 全绿再提交。commit message 不带任何 Co-Authored-By 尾注。

**设计文档：** `docs/superpowers/specs/2026-07-13-entry-detail-design.md`

**与设计文档的一处补充：** `EntryRef` 比 spec 里多一个 `isDir: boolean` 字段。侧栏要靠它决定
读文件时是拼 `${path}/${file}`（目录条目）还是直接用 `path`（单文件条目）。`Entry` 本来就有这个字段。

## 文件结构

| 文件 | 职责 |
|---|---|
| `src/core/meta.ts` | 新增。**只做一件事**：从一段文本里抓出 frontmatter 的 `description`。纯函数 + 一个读文件的薄壳。 |
| `src/core/peek.ts` | 新增。**只做一件事**：判断一个绝对路径能不能读，能读就读出来。全部安全边界集中在这里，所以它能被单独、彻底地测。 |
| `src/core/types.ts` | 加 `Entry.desc?`、`Peek`、`PeekResult`。 |
| `src/core/scan.ts` | `readDim` 里给每个 Entry 填 `desc`。 |
| `src/server/index.ts` | 加 `GET /api/file`，把校验完全委托给 `peek.ts`，自己只做 HTTP 翻译。 |
| `src/web/api.ts` | 加 `getFile(path)`。 |
| `src/web/graph.ts` | 加 `EntryRef` / `Row.ref` / `refId()`，建 `path -> entry` 索引。 |
| `src/web/components/Boxes.tsx` | `RowView` 支持点击和 hover 提示；`onOpen` / `activeId` 透传。 |
| `src/web/components/Detail.tsx` | 新增。`Detail`（容器，管 fetch 和状态）+ `DetailView`（纯展示，可被 `renderToStaticMarkup` 直接测）+ 两个纯函数 `defaultFile` / `fileAbs`。 |
| `src/web/App.tsx` | 持有 `detail` 状态，挂载侧栏。 |
| `src/web/styles.css` | `.row` 定位、`.tip`、`.detail`。 |

---

### Task 1: frontmatter description 解析

**Files:**
- Create: `src/core/meta.ts`
- Modify: `src/core/types.ts`（`Entry` 加 `desc?`）
- Modify: `src/core/scan.ts:44-50`（`readDim` 里填 `desc`）
- Test: `tests/core/meta.test.ts`（新建）

**Interfaces:**
- Consumes: `src/core/fsx.ts` 的 `pathKind`（不直接用，`readDesc` 靠 `isDir` 参数）。
- Produces:
  - `parseDesc(text: string): string | undefined`
  - `readDesc(entryPath: string, isDir: boolean): Promise<string | undefined>`
  - `Entry.desc?: string` —— Task 4 会把它塞进 `EntryRef`。

- [ ] **Step 1: 写失败的测试**

新建 `tests/core/meta.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run tests/core/meta.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/core/meta.js"`

- [ ] **Step 3: 写 `src/core/meta.ts`**

```ts
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * description 的长度上限。
 *
 * 有些 skill 的 description 长达上千字 —— 它本来就是写给模型做路由的，不是写给人看的。
 * 原样塞进 hover 提示，会糊掉半张图。
 */
const MAX_DESC = 500

/** frontmatter 不可能有 1MB。超过就当它没有，别把一个巨型文件读进内存。 */
const MAX_HEAD = 1024 * 1024

/**
 * 从一段文本里抓 frontmatter 的 description。
 *
 * 不引 YAML 依赖：我们不需要通用 YAML，只需要认出这一个 key。
 * 任何解析不出来的情况一律返回 undefined —— 一个畸形 frontmatter 不能崩掉整个 scan。
 */
export function parseDesc(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined

  const end = lines.indexOf('---', 1)
  if (end < 0) return undefined // 没有闭合，那它就不是 frontmatter

  const body = lines.slice(1, end)
  const i = body.findIndex((l) => /^description:/.test(l)) // 顶格才算 key
  if (i < 0) return undefined

  const first = body[i].slice('description:'.length).trim()

  // 块标量（>- | > |- 之类）：值全在后面的缩进行里，头一行只是个标记
  const isBlock = /^[|>][-+]?$/.test(first)
  const parts: string[] = isBlock || first === '' ? [] : [first]

  // 续行：缩进的行。plain scalar 和块标量都靠这个吃多行；
  // 一遇到顶格的行（下一个 key，或别的什么），description 就到此为止。
  for (let j = i + 1; j < body.length; j++) {
    if (!/^\s+\S/.test(body[j])) break
    parts.push(body[j].trim())
  }

  // 折成一行 —— hover 提示是个小方块，多行换行符在里头没有意义
  let v = parts.join(' ').trim()
  v = v.replace(/^"([\s\S]*)"$/, '$1').replace(/^'([\s\S]*)'$/, '$1')
  if (!v) return undefined

  return v.length > MAX_DESC ? v.slice(0, MAX_DESC) + '…' : v
}

/**
 * 一个条目的描述。
 *
 * 目录条目（skills）读 `SKILL.md`；文件条目（commands / agents / hooks）读它自己。
 * 读不到、没有 frontmatter、frontmatter 里没有 description —— 都不是错误，就是「没有描述」。
 */
export async function readDesc(entryPath: string, isDir: boolean): Promise<string | undefined> {
  const file = isDir ? join(entryPath, 'SKILL.md') : entryPath
  try {
    const buf = await readFile(file)
    if (buf.length > MAX_HEAD) return undefined
    return parseDesc(buf.toString('utf8'))
  } catch {
    return undefined
  }
}
```

- [ ] **Step 4: 把 `desc` 接进 `Entry` 和 `scan`**

`src/core/types.ts` —— 在 `Entry` 里加最后一个字段：

```ts
export interface Entry {
  name: string
  hash: string
  path: string
  isDir: boolean
  files: string[] // 条目内的相对文件清单，给冲突卡做差异摘要
  /** frontmatter 里的 description。没有 frontmatter、或里头没这个 key 时为 undefined。 */
  desc?: string
}
```

`src/core/scan.ts` —— 顶部 import 加一行：

```ts
import { readDesc } from './meta.js'
```

`readDim` 里那个 `entries.push({...})` 改成（`scan.ts:44-50`）：

```ts
    entries.push({
      name,
      path: p,
      isDir: kind === 'dir',
      hash: await hashPath(p),
      files: await listFiles(p),
      // scan 已经为了算 hash 读过这个条目的全部文件，多读一个 SKILL.md 的成本可以忽略。
      desc: await readDesc(p, kind === 'dir'),
    })
```

- [ ] **Step 5: 跑测试**

Run: `npm test`
Expected: 全绿。`tests/core/meta.test.ts` 里 13 条全过；既有的 scan / plan / apply 测试不受影响
（`desc` 是可选字段，`hash` 不含它，所以去重和冲突判定的行为一个字都没变）。

- [ ] **Step 6: 提交**

```bash
git add src/core/meta.ts src/core/types.ts src/core/scan.ts tests/core/meta.test.ts
git commit -m "feat(core): scan 解析 frontmatter description"
```

---

### Task 2: `peekFile` —— 路径白名单

这是本次改动里唯一有安全后果的一块。它被单独拆成一个任务，就是为了让它的测试能被单独审。

**Files:**
- Create: `src/core/peek.ts`
- Modify: `src/core/types.ts`（加 `Peek` / `PeekResult`）
- Test: `tests/core/peek.test.ts`（新建）

**Interfaces:**
- Consumes: `src/core/constants.ts` 的 `TOOL_DIRS` / `DIMS` / `AGENTS_DIR`；`src/core/fsx.ts` 的 `realpath`。
- Produces:
  - `MAX_PEEK: number`（= 262144）
  - `peekFile(roots: string[], requested: string): Promise<PeekResult>`
  - `interface Peek { path: string; content: string; size: number; truncated: boolean; binary: boolean }`
  - `type PeekResult = { ok: true; peek: Peek } | { ok: false; code: 403 | 404 }`
  - Task 3 的 server 直接用这三样。

- [ ] **Step 1: 写失败的测试**

新建 `tests/core/peek.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { writeFile, symlink, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { peekFile, MAX_PEEK } from '../../src/core/peek.js'
import { mkRepo, cleanupRepo } from '../helpers/mkrepo.js'

let root = ''
afterEach(async () => {
  if (root) await cleanupRepo(root)
  root = ''
})

/** 每条用例都在同一个仓库布局上跑 —— 差别只在请求哪个路径。 */
async function repo() {
  root = await mkRepo({
    '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n正文',
    '.claude/settings.json': '{"secret":1}',
    '.agents/commands/go.md': 'go',
    'package.json': '{"name":"victim"}',
    'secret.txt': 'TOP SECRET',
  })
  return root
}

const peek = (p: string) => peekFile([root], p)

describe('peekFile · 能读什么', () => {
  it('维度目录下的文件：读得到', async () => {
    await repo()
    const r = await peek(join(root, '.claude/skills/foo/SKILL.md'))
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.peek.content).toContain('我是 foo')
      expect(r.peek.binary).toBe(false)
      expect(r.peek.truncated).toBe(false)
    }
  })

  it('唯一源里的文件：一样读得到', async () => {
    await repo()
    const r = await peek(join(root, '.agents/commands/go.md'))
    expect(r.ok).toBe(true)
  })
})

describe('peekFile · 白名单', () => {
  // WHY: 这是整组测试里最重要的一条。白名单一旦退化成「只要在 repoRoot 之下就行」，
  // 这条就会变成 200 —— 那等于在 localhost 上开了个任意文件读取接口。
  it('仓库里但不在任何维度下的文件 -> 403', async () => {
    await repo()
    expect(await peek(join(root, 'package.json'))).toEqual({ ok: false, code: 403 })
  })

  // WHY: .claude/settings.json 是「工具专属，不碰」的东西，图上根本不展示它的内容。
  // 图上看不见的，接口也不该给读 —— 两边的视野必须一致。
  it('点目录下但不在维度下的文件（settings.json）-> 403', async () => {
    await repo()
    expect(await peek(join(root, '.claude/settings.json'))).toEqual({ ok: false, code: 403 })
  })

  it('路径遍历 -> 403', async () => {
    await repo()
    const evil = join(root, '.claude/skills/../../../etc/passwd')
    expect((await peek(evil)).ok).toBe(false)
  })

  // WHY: 前缀不以路径分隔符结尾时，`<root>/.claude/skillsEVIL/` 会命中
  // `<root>/.claude/skills` 这个前缀，白名单就漏了。
  it('前缀伪造：.claude/skillsEVIL/ -> 403', async () => {
    await repo()
    await mkdir(join(root, '.claude/skillsEVIL'), { recursive: true })
    await writeFile(join(root, '.claude/skillsEVIL/x.md'), 'leak', 'utf8')
    expect(await peek(join(root, '.claude/skillsEVIL/x.md'))).toEqual({ ok: false, code: 403 })
  })

  // WHY: 维度目录里的软链是用户数据（scan 把它记成 residue.symlink，不当条目、不连线）。
  // 跟着它走出白名单，就是把「不管理」变成了「可以读」。realpath 之后必须掉出去。
  it('软链逃逸出白名单 -> 403', async () => {
    await repo()
    await symlink(join(root, 'secret.txt'), join(root, '.claude/skills/evil'))
    expect(await peek(join(root, '.claude/skills/evil'))).toEqual({ ok: false, code: 403 })
  })

  it('相对路径 -> 403', async () => {
    await repo()
    expect(await peek('.claude/skills/foo/SKILL.md')).toEqual({ ok: false, code: 403 })
  })

  it('空路径 -> 403', async () => {
    await repo()
    expect(await peek('')).toEqual({ ok: false, code: 403 })
  })

  it('目录不给读 -> 403', async () => {
    await repo()
    expect(await peek(join(root, '.claude/skills/foo'))).toEqual({ ok: false, code: 403 })
  })

  it('不存在 -> 404', async () => {
    await repo()
    expect(await peek(join(root, '.claude/skills/foo/NOPE.md'))).toEqual({ ok: false, code: 404 })
  })

  // WHY: 生产环境的 repoRoot 来自 findRepoRoot()，它只 resolve 不 realpath。
  // 如果仓库路径上有一段软链（macOS 的 /tmp -> /private/tmp 就是），
  // realpath(请求路径) 和拼出来的前缀会对不上，合法请求被误判成 403。
  it('roots 自己带软链时，合法请求照样 200', async () => {
    await repo()
    const alias = join(dirname(root), `alias-${Date.now()}`)
    await symlink(root, alias)
    const r = await peekFile([alias], join(alias, '.claude/skills/foo/SKILL.md'))
    expect(r.ok).toBe(true)
  })
})

describe('peekFile · 内容', () => {
  it('含 NUL 的文件判定为二进制，不返回内容', async () => {
    await repo()
    const p = join(root, '.claude/skills/foo/blob.bin')
    await writeFile(p, Buffer.from([0x01, 0x00, 0x02]))
    const r = await peek(p)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.peek.binary).toBe(true)
      expect(r.peek.content).toBe('')
    }
  })

  it('超过 MAX_PEEK 的文件：截断，并明说截断了', async () => {
    await repo()
    const p = join(root, '.claude/skills/foo/big.md')
    await writeFile(p, 'a'.repeat(MAX_PEEK + 1000), 'utf8')
    const r = await peek(p)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.peek.truncated).toBe(true)
      expect(r.peek.content).toHaveLength(MAX_PEEK)
      expect(r.peek.size).toBe(MAX_PEEK + 1000)
    }
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run tests/core/peek.test.ts`
Expected: FAIL —— `Failed to resolve import "../../src/core/peek.js"`

- [ ] **Step 3: 写 `src/core/types.ts` 里的两个类型**

追加到文件末尾：

```ts
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
```

- [ ] **Step 4: 写 `src/core/peek.ts`**

```ts
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, normalize, sep } from 'node:path'
import type { PeekResult } from './types.js'
import { AGENTS_DIR, DIMS, TOOL_DIRS } from './constants.js'
import { realpath } from './fsx.js'

/** 单次读取上限。侧栏是拿来看 skill 的，不是拿来看 dump 的。 */
export const MAX_PEEK = 256 * 1024

/**
 * 允许被读的路径前缀。
 *
 * 白名单和 scan 的视野严格一致：**图上看得见的才读得到，图上没有的一律 403。**
 * 不能退化成「只要在 root 之下就行」—— 那等于顺手在 localhost 上开了个读
 * .env / .git/config 的口子。.claude/settings.json 也读不到：它在点目录下，
 * 但不在任何维度下，图上本来也只是「工具专属，不碰」的一行。
 */
async function allowedPrefixes(roots: string[]): Promise<string[]> {
  const dirs = [AGENTS_DIR, ...TOOL_DIRS]
  const out: string[] = []

  for (const root of roots) {
    // root 自己也要 realpath。生产环境的 repoRoot 来自 findRepoRoot()，它只 resolve
    // 不 realpath；仓库路径上只要有一段软链（macOS 的 /tmp -> /private/tmp 就是），
    // realpath(请求路径) 和这里拼出的前缀就会对不上，合法请求被误判成 403。
    const real = await realpath(root).catch(() => null)
    if (!real) continue

    for (const d of dirs) {
      for (const dim of DIMS) {
        // 前缀必须以分隔符结尾。否则 <root>/.claude/skillsEVIL/x.md
        // 会命中 <root>/.claude/skills 这个前缀，白名单就漏了。
        out.push(join(real, d, dim) + sep)
      }
    }
  }
  return out
}

/**
 * 读一个条目里的文件。这是整个 server 上唯一的读文件出口 ——
 * 所有边界都在这里，别在调用方再加一层「应该没问题吧」。
 */
export async function peekFile(roots: string[], requested: string): Promise<PeekResult> {
  if (!requested || !isAbsolute(requested)) return { ok: false, code: 403 }

  // 先解析到底，之后所有判断都基于软链解析后的真实路径。
  // 先比前缀再 realpath 的话，一条指向仓库外的软链就能穿过去。
  const real = await realpath(normalize(requested)).catch(() => null)
  if (!real) return { ok: false, code: 404 }

  const prefixes = await allowedPrefixes(roots)
  if (!prefixes.some((p) => real.startsWith(p))) return { ok: false, code: 403 }

  const st = await stat(real)
  if (!st.isFile()) return { ok: false, code: 403 } // 目录不给读

  const buf = await readFile(real)
  const truncated = buf.length > MAX_PEEK
  const head = truncated ? buf.subarray(0, MAX_PEEK) : buf
  const binary = head.includes(0)

  return {
    ok: true,
    peek: {
      path: real,
      // 二进制原样 toString 会喷出一屏替换字符。明说「是二进制」比装作能显示要诚实。
      content: binary ? '' : head.toString('utf8'),
      size: buf.length,
      truncated,
      binary,
    },
  }
}
```

- [ ] **Step 5: 跑测试**

Run: `npx vitest run tests/core/peek.test.ts`
Expected: PASS，15 条全过。

- [ ] **Step 6: 全量测试 + 提交**

Run: `npm test`
Expected: 全绿。

```bash
git add src/core/peek.ts src/core/types.ts tests/core/peek.test.ts
git commit -m "feat(core): peekFile —— 条目文件读取与路径白名单"
```

---

### Task 3: `GET /api/file`

**Files:**
- Modify: `src/server/index.ts:54-87`（API 分支里加一条）
- Modify: `src/web/api.ts`（加 `getFile`）
- Test: `tests/server/api.test.ts`（追加 4 条）

**Interfaces:**
- Consumes: Task 2 的 `peekFile` / `MAX_PEEK`，`src/core/types.ts` 的 `Peek`。
- Produces: `getFile(path: string): Promise<Peek>` —— Task 6 的侧栏用它。

- [ ] **Step 1: 写失败的测试**

在 `tests/server/api.test.ts` 的 `describe('server', ...)` 里追加：

```ts
  // WHY: /api/file 是这个 server 上唯一的读文件出口。没有 token 校验，
  // 本机上任何一个网页都能拿它读你 ~/.claude 下的东西。
  it('GET /api/file 没有 token -> 401', async () => {
    const { root, srv } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const p = encodeURIComponent(join(root, '.claude/skills/foo/SKILL.md'))
    const res = await fetch(`${srv.url}/api/file?path=${p}`)
    expect(res.status).toBe(401)
  })

  it('GET /api/file 读维度下的文件 -> 200', async () => {
    const { root, call } = await boot({ '.claude/skills/foo/SKILL.md': 'hello foo' })
    const p = encodeURIComponent(join(root, '.claude/skills/foo/SKILL.md'))
    const body = await (await call(`/api/file?path=${p}`)).json()
    expect(body.content).toBe('hello foo')
    expect(body.binary).toBe(false)
  })

  // WHY: 和 POST /api/apply 那条同等重要。前端可以在 path 里写任何东西 ——
  // 后端必须自己判，不能信。
  it('GET /api/file 读维度之外的文件 -> 403', async () => {
    const { root, call } = await boot({
      '.claude/skills/foo/SKILL.md': 'x',
      'PRECIOUS.md': 'keep me',
    })
    const p = encodeURIComponent(join(root, 'PRECIOUS.md'))
    const res = await call(`/api/file?path=${p}`)
    expect(res.status).toBe(403)
  })

  it('GET /api/file 读不存在的文件 -> 404', async () => {
    const { root, call } = await boot({ '.claude/skills/foo/SKILL.md': 'x' })
    const p = encodeURIComponent(join(root, '.claude/skills/foo/NOPE.md'))
    const res = await call(`/api/file?path=${p}`)
    expect(res.status).toBe(404)
  })
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run tests/server/api.test.ts`
Expected: FAIL —— 200 的那条拿到 404（`not found`），403 / 404 的两条也拿到 404。
（401 那条会误过 —— 因为 token 分支在前。这没关系，实现完它仍然得过。）

- [ ] **Step 3: 加 server 分支**

`src/server/index.ts` 顶部 import 加：

```ts
import { peekFile } from '../core/peek.js'
```

在 `/api/apply` 分支之后、`json(res, 404, { error: 'not found' })` 之前插入：

```ts
        if (path === '/api/file' && req.method === 'GET') {
          // 只读、只 GET。所有路径校验都在 peekFile 里 —— server 只做 HTTP 翻译，
          // 一个字节的「应该没问题吧」都不在这里加。
          const want = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('path') ?? ''
          const r = await peekFile([repoRoot, homedir()], want)
          if (!r.ok) {
            json(res, r.code, { error: r.code === 404 ? 'not found' : 'forbidden' })
            return
          }
          json(res, 200, r.peek)
          return
        }
```

`homedir()` 已经在这个文件里 import 过了（`/api/state` 用它扫全局）。全局页是只读展示，
它的条目也要能点开看 —— 所以 roots 里必须有它。

- [ ] **Step 4: 加前端 `getFile`**

`src/web/api.ts` —— import 那行加上 `Peek`，文件末尾加：

```ts
import type { Peek, Plan, Resolutions, Result, State } from '../core/types.js'

// …既有代码不动…

export const getFile = (path: string) => call<Peek>(`/api/file?path=${encodeURIComponent(path)}`)
```

- [ ] **Step 5: 跑测试**

Run: `npm test`
Expected: 全绿，`tests/server/api.test.ts` 现在有 8 条。

- [ ] **Step 6: 提交**

```bash
git add src/server/index.ts src/web/api.ts tests/server/api.test.ts
git commit -m "feat(server): GET /api/file 读条目内的文件"
```

---

### Task 4: `Row.ref` —— 把行连回真实条目

**Files:**
- Modify: `src/web/graph.ts`
- Test: `tests/web/graph.test.ts`（追加一个 describe）

**Interfaces:**
- Consumes: Task 1 的 `Entry.desc`。
- Produces:
  - `interface EntryRef { key: string; dim: Dim; name: string; path: string; isDir: boolean; files: string[]; desc?: string; from: string }`
  - `Row.ref?: EntryRef`
  - `refId(r: EntryRef): string` —— 同名条目在多个盒子里都有，`key` 不唯一，选中态得靠 `from|key`。
  - Task 5 的 `RowView` 和 Task 6 的 `Detail` 都吃 `EntryRef`。

- [ ] **Step 1: 写失败的测试**

`tests/web/graph.test.ts` 已经有 `root` / `mkRepo` / `cleanupRepo` / `scan` / `buildPlan` /
`buildGraph`。改它顶部的两行 import：

```ts
import { join } from 'node:path'                                    // 新增这一行
import { buildGraph, anchorItem, anchorSrcItem, refId, FOLD_CAP } from '../../src/web/graph.js'
```

然后在文件末尾追加：

```ts
describe('Row.ref —— 行连回真实条目', () => {
  it('「现在」列的条目行带 ref，指向它在磁盘上的真实路径', async () => {
    root = await mkRepo({ '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n' })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const row = g.now.find((b) => b.tool === '.claude')!.dims[0].entries[0]
    expect(row.ref).toBeDefined()
    expect(row.ref!.path).toBe(join(root, '.claude/skills/foo'))
    expect(row.ref!.from).toBe('.claude')
    expect(row.ref!.isDir).toBe(true)
    expect(row.ref!.desc).toBe('我是 foo')
    expect(row.ref!.files).toEqual(['SKILL.md'])
  })

  // WHY: 唯一源那一列是**预测** —— 文件还没搬过去，.agents/skills/foo 在磁盘上根本不存在。
  // ref 指向目标路径的话，点开侧栏必然 404。它得指向「内容将会来自哪儿」。
  it('唯一源列的条目：ref 指向源路径，不是 .agents 下那个还不存在的目标', async () => {
    root = await mkRepo({ '.claude/skills/foo/SKILL.md': 'x' })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const row = g.src.dims.find((d) => d.dim === 'skills')!.entries[0]
    expect(row.ref!.path).toBe(join(root, '.claude/skills/foo'))
    expect(row.ref!.path).not.toContain('.agents')
    expect(row.ref!.from).toBe('.claude')
  })

  // WHY: 用户最想点开的恰恰是「我要删掉的这份」。不给它 ref，等于让用户闭着眼睛删。
  it('冲突里落败的、和被静默去重的条目，一样可以点开', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
      '.cursor/skills/bar/SKILL.md': 'same',
      '.trae/skills/bar/SKILL.md': 'same',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, { 'skills/foo': '.claude' }))

    const loser = g.now
      .find((b) => b.tool === '.codebuddy')!
      .dims[0].entries.find((r) => r.text === 'foo')!
    expect(loser.tone).toBe('loser')
    expect(loser.ref!.path).toBe(join(root, '.codebuddy/skills/foo'))

    const dropped = g.now
      .find((b) => b.tool === '.trae')!
      .dims[0].entries.find((r) => r.text === 'bar')!
    expect(dropped.tone).toBe('dropped')
    expect(dropped.ref).toBeDefined()
  })

  // WHY: 未裁决的冲突在唯一源列里只是一个赭石占位行，它没有唯一的内容来源 ——
  // 那正是「未裁决」的含义。给它 ref = 替用户选了一份，而这个工具的第一原则就是绝不替他选。
  it('未裁决冲突的占位行没有 ref，点不开', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const row = g.src.dims.find((d) => d.dim === 'skills')!.entries.find((r) => r.text === 'foo')!
    expect(row.tone).toBe('dup')
    expect(row.ref).toBeUndefined()
  })

  it('不管理的东西（only / residue / 软链行）都没有 ref', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'x',
      '.claude/settings.json': '{}',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const box = g.now.find((b) => b.tool === '.claude')!
    expect(box.only.every((r) => r.ref === undefined)).toBe(true)
  })

  // WHY: 同一个 name 在 .claude 和 .codebuddy 里都有，key 都是 skills/foo。
  // 拿 key 当选中态的标识，点开左边那份，右边那份也会跟着高亮 —— 那是在撒谎。
  it('refId 用 from + key，同名条目在不同盒子里不会互相冒充', async () => {
    root = await mkRepo({
      '.claude/skills/foo/SKILL.md': 'A',
      '.codebuddy/skills/foo/SKILL.md': 'B',
    })
    const state = await scan(root)
    const g = buildGraph(state, buildPlan(state, {}))

    const a = g.now.find((b) => b.tool === '.claude')!.dims[0].entries[0].ref!
    const b = g.now.find((b) => b.tool === '.codebuddy')!.dims[0].entries[0].ref!
    expect(a.key).toBe(b.key)
    expect(refId(a)).not.toBe(refId(b))
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run tests/web/graph.test.ts`
Expected: FAIL —— `refId` 不存在；`row.ref` 是 `undefined`。

- [ ] **Step 3: 改 `src/web/graph.ts`**

3a. import 加 `Entry`：

```ts
import type { Dim, Entry, Foreign, Plan, State } from '../core/types.js'
```

3b. 在 `Row` 上面加 `EntryRef`，并给 `Row` 加一个字段：

```ts
/**
 * 一行背后的真实条目。**有 ref = 这一行可以点开看详情。**
 *
 * 「执行后·唯一源」那一列是预测：文件还没搬过去，.agents/<dim>/<name> 在磁盘上并不存在。
 * 所以那一列的 ref 指向的是**内容将会来自的那个源路径**，不是目标路径。
 */
export interface EntryRef {
  key: string // `${dim}/${name}`
  dim: Dim
  name: string
  /** 内容当前所在的绝对路径 */
  path: string
  /** 目录条目（skills）还是单文件条目（commands / agents / hooks）。侧栏靠它拼子路径。 */
  isDir: boolean
  files: string[]
  desc?: string
  /** 这份内容现在躺在哪个目录里（'.claude' / '.agents' / …）。 */
  from: string
}

/**
 * 选中态的唯一标识。
 * 不能用 key —— .claude/skills/foo 和 .codebuddy/skills/foo 的 key 是同一个，
 * 点开一份、两份一起高亮，那是在图上撒谎。
 */
export const refId = (r: EntryRef) => `${r.from}|${r.key}`

export interface Row {
  kind: 'dir' | 'item' | 'link' | 'note'
  text: string
  /** link 行的目标 */
  target?: string
  note?: string
  tone: Tone
  /** 连线锚点。没有锚点 = 这一行不连线。 */
  anchor?: string
  pt: Pt
  /** 有 ref = 可以点开详情。不管理的东西（only / residue / 软链行）一律没有。 */
  ref?: EntryRef
}
```

3c. `buildGraph` 里，在 `// ── 把 plan.ops 索引成几张表 ──` 那段**之前**，先建一张
`path -> 条目` 的索引，并把 `landed` 从存 name 改成存 ref：

```ts
  // path -> 条目。唯一源那一列的行要指回「内容将会来自哪儿」——
  // plan.ops 里 move 的 from 就是源路径，一查这张表就拿到它的 files / desc。
  // 不需要反推，也不该反推。
  const byPath = new Map<string, { e: Entry; tool: string }>()
  for (const dim of DIMS) {
    for (const e of state.agentsDir.entries[dim]) byPath.set(e.path, { e, tool: AGENTS_DIR })
  }
  for (const [tool, t] of Object.entries(state.tools)) {
    for (const dim of DIMS) {
      const st = t.dims[dim]
      if (st?.kind === 'real') for (const e of st.entries) byPath.set(e.path, { e, tool })
    }
  }

  const refOf = (tool: string, dim: Dim, e: Entry): EntryRef => ({
    key: `${dim}/${e.name}`,
    dim,
    name: e.name,
    path: e.path,
    isDir: e.isDir,
    files: e.files,
    desc: e.desc,
    from: tool,
  })

  // ── 把 plan.ops 索引成几张表。这是唯一的事实来源。 ──
  const discarded = new Set<string>()
  const newLinks = new Set<string>() // `${tool}/${dim}`
  const landed = new Map<Dim, Map<string, EntryRef | undefined>>() // 搬进唯一源的条目 -> 它的来源

  for (const op of plan.ops) {
    if (op.t === 'move') {
      const [head, dim, name] = rel(op.to).split('/')
      if (head === AGENTS_DIR && dim && name) {
        const d = dim as Dim
        if (!landed.has(d)) landed.set(d, new Map())
        const src = byPath.get(op.from)
        landed.get(d)!.set(name, src ? refOf(src.tool, d, src.e) : undefined)
      }
    } else if (op.t === 'discard') {
      discarded.add(op.path)
    } else if (op.t === 'symlink') {
      newLinks.add(rel(op.path))
    }
  }
```

3d. `entryRow` 改成收完整的 `Entry`，并给每个分支挂上 ref：

```ts
  const entryRow = (tool: string, dim: Dim, e: Entry): Row => {
    const key = `${dim}/${e.name}`
    const ref = refOf(tool, dim, e)

    if (conflicts.has(key)) {
      if (unresolved.has(key)) {
        return item(e.name, 'dup', anchorItem(tool, key), ref)
      }
      const winner = plan.resolved[key]
      if (winner === tool) return item(e.name, 'won', anchorItem(tool, key), ref)
      // 落败：它不会进唯一源，所以它没有线。但它照样点得开 ——
      // 「我要删掉的这份到底是什么」恰恰是用户最想知道的。
      return item(e.name, 'loser', undefined, ref)
    }

    // 内容完全相同的重复副本 —— 静默去重，删掉，不连线。同样点得开。
    if (discarded.has(e.path)) return item(e.name, 'dropped', undefined, ref)

    return item(e.name, 'plain', anchorItem(tool, key), ref)
  }
```

3e. 唯一源那一列（`/* ── 列 3 ── */` 那段），两处 `srcItem` 调用带上 ref：

```ts
    // 本来就在里面、这次没被换掉的
    for (const e of state.agentsDir.entries[dim]) {
      if (!discarded.has(e.path)) {
        rows.set(e.name, srcItem(dim, e.name, 'plain', refOf(AGENTS_DIR, dim, e)))
      }
    }
    // 这次搬进来的：ref 指向它的**源路径** —— .agents/<dim>/<name> 还不存在
    for (const [name, ref] of landed.get(dim) ?? []) {
      rows.set(name, srcItem(dim, name, 'plain', ref))
    }
```

未裁决冲突那个占位行**不动**（它本来就不传 ref，保持点不开）。

3f. 文件末尾两个 helper 加参数：

```ts
function item(name: string, tone: Tone, anchor?: string, ref?: EntryRef): Row {
  return { kind: 'item', text: name, tone, anchor, pt: 'r', ref }
}

function srcItem(dim: Dim, name: string, tone: Tone, ref?: EntryRef): Row {
  return {
    kind: 'item',
    text: name,
    tone,
    pt: 'l',
    anchor: anchorSrcItem(`${dim}/${name}`),
    ref,
  }
}
```

- [ ] **Step 4: 跑测试**

Run: `npm test`
Expected: 全绿。既有的 `graph.test.ts` / `boxes.test.tsx` 不受影响 —— `ref` 是新增的可选字段，
锚点、tone、行数一个都没变。

- [ ] **Step 5: 提交**

```bash
git add src/web/graph.ts tests/web/graph.test.ts
git commit -m "feat(web): Row 挂上 EntryRef，把行连回真实条目"
```

---

### Task 5: 可点的行 + hover 描述预览

**Files:**
- Modify: `src/web/components/Boxes.tsx`
- Modify: `src/web/styles.css`（`.row` 定位、`.tip`）
- Test: `tests/web/boxes.test.tsx`（追加一个 describe）

**Interfaces:**
- Consumes: Task 4 的 `EntryRef` / `Row.ref` / `refId`。
- Produces:
  - `RowView({ row, onOpen?, active? })`
  - `NowBoxView({ box, delay, fold, onOpen?, activeId? })`
  - `SrcBoxView({ dims, only, fold, onOpen?, activeId? })`
  - Task 6 的 `App` 用后两个的新 props。

**注意：** 组件测试用 `renderToStaticMarkup`，没有 jsdom，**测不了 click 事件**。
所以这里测的是「markup 上有没有可点的凭据」：`role="button"` / `tabindex` / tooltip 文本。
这不是偷懒 —— 一个不带 `role="button"` 的 div 对键盘和读屏用户来说本来就是不可点的，
它比 onClick 有没有绑上更接近「这一行能不能被点开」这个问题本身。

- [ ] **Step 1: 写失败的测试**

在 `tests/web/boxes.test.tsx` 末尾追加：

```tsx
describe('可点的行 + 描述预览', () => {
  it('带 ref 的条目行：有 role=button 和 tabindex，键盘能停上去', async () => {
    const g = await graphOf({ '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!

    const html = renderToStaticMarkup(
      <NowBoxView box={box} delay={0} fold={fold} onOpen={() => {}} />,
    )
    expect(html).toContain('role="button"')
    expect(html).toContain('tabindex="0"')
    expect(html).toContain('clickable')
  })

  // WHY: 有描述才浮提示。没有 desc 还渲染一个空方块，hover 上去是一片空白 —— 那比没有更糟。
  it('有 desc -> 渲染 tooltip；没有 desc -> 一个 tip 节点都不渲染', async () => {
    const withDesc = await graphOf({
      '.claude/skills/foo/SKILL.md': '---\ndescription: 我是 foo\n---\n',
    })
    const f1 = { big: withDesc.bigDims, open: new Set<never>(), onToggle: () => {} }
    const h1 = renderToStaticMarkup(
      <NowBoxView
        box={withDesc.now.find((b) => b.tool === '.claude')!}
        delay={0}
        fold={f1}
        onOpen={() => {}}
      />,
    )
    expect(h1).toContain('class="tip"')
    expect(h1).toContain('我是 foo')

    const noDesc = await graphOf({ '.claude/skills/foo/SKILL.md': '没有 frontmatter' })
    const f2 = { big: noDesc.bigDims, open: new Set<never>(), onToggle: () => {} }
    const h2 = renderToStaticMarkup(
      <NowBoxView
        box={noDesc.now.find((b) => b.tool === '.claude')!}
        delay={0}
        fold={f2}
        onOpen={() => {}}
      />,
    )
    expect(h2).not.toContain('class="tip"')
  })

  // WHY: only 里是 dot-agents 不管理的东西。让它们看起来可点、点了却什么都没有，
  // 等于告诉用户「这里有内容」——而我们压根不读它们。
  it('不管理的行（only）不可点：没有 role=button', async () => {
    const g = await graphOf({ '.claude/settings.json': '{}' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!

    const html = renderToStaticMarkup(
      <NowBoxView box={box} delay={0} fold={fold} onOpen={() => {}} />,
    )
    expect(html).toContain('settings.json')
    expect(html).not.toContain('role="button"')
  })

  // WHY: 不传 onOpen（比如某个只读视图不想要侧栏）时，行不该假装可点。
  it('没传 onOpen -> 行不可点', async () => {
    const g = await graphOf({ '.claude/skills/foo/SKILL.md': 'x' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!

    const html = renderToStaticMarkup(<NowBoxView box={box} delay={0} fold={fold} />)
    expect(html).not.toContain('role="button"')
  })

  it('activeId 命中的那一行带 active 类', async () => {
    const g = await graphOf({ '.claude/skills/foo/SKILL.md': 'x' })
    const fold = { big: g.bigDims, open: new Set<never>(), onToggle: () => {} }
    const box = g.now.find((b) => b.tool === '.claude')!
    const id = refId(box.dims[0].entries[0].ref!)

    const html = renderToStaticMarkup(
      <NowBoxView box={box} delay={0} fold={fold} onOpen={() => {}} activeId={id} />,
    )
    expect(html).toContain('active')
  })
})
```

文件顶部的 import 补上 `refId`：

```tsx
import { buildGraph, anchorFold, refId, FOLD_CAP } from '../../src/web/graph.js'
```

`graphOf` 的签名当前是 `Record<string, string>`，本任务的用例都只写文件，不用改。

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run tests/web/boxes.test.tsx`
Expected: FAIL —— `NowBoxView` 不认识 `onOpen` / `activeId`；markup 里没有 `role="button"`，也没有 `tip`。

- [ ] **Step 3: 改 `src/web/components/Boxes.tsx`**

3a. import：

```tsx
import { useState } from 'react'
import type { Dim } from '../../core/types.js'
import {
  anchorFold,
  refId,
  type DistBox,
  type EntryRef,
  type NowBox,
  type Row,
  type SrcBlock,
} from '../graph.js'
```

3b. `RowView` 整个替换：

```tsx
/**
 * 一行。文字一律左对齐（目录树就该这么读）——
 * 换边的只有接线柱，因为它决定线从哪儿出发。
 */
export function RowView({
  row,
  onOpen,
  active,
}: {
  row: Row
  onOpen?: (r: EntryRef) => void
  active?: boolean
}) {
  const ref = row.ref
  const clickable = !!(ref && onOpen)

  const cls = [
    'row',
    row.kind,
    row.tone,
    row.pt.includes('l') ? 'hasl' : '',
    clickable ? 'clickable' : '',
    active ? 'active' : '',
  ]
    .filter(Boolean)
    .join(' ')

  // 行是 div 不是 button —— .row 的 flex 布局和一整套 tone class 都挂在它身上。
  // 但「可点」必须对键盘和读屏用户同样成立，所以补上 role / tabIndex / 键盘响应。
  const act = clickable
    ? {
        role: 'button',
        tabIndex: 0,
        onClick: () => onOpen!(ref!),
        onKeyDown: (e: React.KeyboardEvent) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault() // 空格默认是滚屏
            onOpen!(ref!)
          }
        },
      }
    : {}

  return (
    <div className={cls} data-a={row.anchor} {...act}>
      {row.pt.includes('l') && <span className="pt l" />}
      <span className="tx">
        {row.kind === 'link' ? (
          <>
            <span className="rname">{row.text}</span>
            <span className="rarrow">→</span>
            <span className="rtarget">{row.target}</span>
          </>
        ) : (
          <span className="rname">{row.text}</span>
        )}
        {row.note && <span className="rnote">{row.note}</span>}
      </span>
      {row.pt.includes('r') && <span className="pt r" />}
      {/* 描述预览。
          必须是 .row 的直接子级：.tx 有 overflow:hidden（给名字做 ellipsis 用的），
          塞进去会被裁掉。
          必须绝对定位：进了文档流就会改行高，而线是靠 DOM 锚点实时量出来的 ——
          行高一变，所有接线柱都得重量。 */}
      {ref?.desc && <span className="tip">{ref.desc}</span>}
    </div>
  )
}
```

3c. `Entries` 加两个 prop 并透传：

```tsx
function Entries({
  rows,
  dim,
  tool,
  side,
  folded,
  onToggle,
  onOpen,
  activeId,
}: {
  rows: Row[]
  dim: Dim
  tool: string
  side: 'l' | 'r'
  folded: boolean
  onToggle: (d: Dim) => void
  onOpen?: (r: EntryRef) => void
  activeId?: string
}) {
  if (folded && rows.length) {
    return (
      <FoldRow
        n={rows.length}
        anchor={anchorFold(tool, dim)}
        side={side}
        onClick={() => onToggle(dim)}
      />
    )
  }
  return (
    <>
      {rows.map((r, i) => (
        <RowView
          key={i}
          row={r}
          onOpen={onOpen}
          active={!!(r.ref && activeId && refId(r.ref) === activeId)}
        />
      ))}
    </>
  )
}
```

`FoldRow` / `Collapse` / `Only` 不动 —— 它们渲染的行本来就没有 ref。

3d. `NowBoxView` 和 `SrcBoxView` 加 props，并把它们传给 `Entries`：

```tsx
export function NowBoxView({
  box,
  delay,
  fold,
  onOpen,
  activeId,
}: {
  box: NowBox
  delay: number
  fold: Fold
  onOpen?: (r: EntryRef) => void
  activeId?: string
}) {
```

`NowBoxView` 里那个 `<Entries ... />` 补上 `onOpen={onOpen} activeId={activeId}`。

```tsx
export function SrcBoxView({
  dims,
  only,
  fold,
  onOpen,
  activeId,
}: {
  dims: SrcBlock[]
  only: Row[]
  fold: Fold
  onOpen?: (r: EntryRef) => void
  activeId?: string
}) {
```

`SrcBoxView` 里那个 `<Entries ... />` 同样补上 `onOpen={onOpen} activeId={activeId}`。

`DistBoxView` 不动 —— 列 4 全是软链行和 only 行，没有条目。

- [ ] **Step 4: 加 CSS**

`src/web/styles.css` —— 在 `.row { … }` 那个块里加一行 `position: relative`
（tooltip 的定位上下文），然后紧跟着 `.row .rnote { … }` 之后插入：

```css
/* ── 可点的行 ── */
.row.clickable {
  cursor: pointer;
  border-radius: 4px;
}
.row.clickable:hover {
  background: color-mix(in srgb, var(--ink) 5%, transparent);
}
.row.active {
  background: color-mix(in srgb, var(--moss) 13%, transparent);
}
.row.clickable:focus-visible {
  outline: 1px solid var(--moss);
  outline-offset: 1px;
}

/* 描述预览。
   绝对定位不是审美选择：进了文档流就会改行高，而线是靠 DOM 锚点实时量出来的 ——
   行高一变，四列图上所有接线柱都得重量。 */
.tip {
  position: absolute;
  left: 0;
  top: calc(100% - 3px);
  z-index: 20;
  max-width: 320px;
  white-space: normal;
  line-height: 1.5;
  font-family: 'Avenir Next', -apple-system, 'PingFang SC', sans-serif;
  font-size: 11px;
  color: var(--ink);
  background: var(--paper);
  border: 1px solid var(--hair);
  border-radius: 5px;
  padding: 6px 9px;
  box-shadow: 0 4px 14px rgb(0 0 0 / 0.09);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.15s ease;
}
.row:hover > .tip,
.row:focus-visible > .tip {
  opacity: 1;
}
```

- [ ] **Step 5: 跑测试**

Run: `npm test`
Expected: 全绿。既有的折叠测试不受影响 —— 折叠行没有 ref，markup 里的锚点一个没变。

- [ ] **Step 6: 提交**

```bash
git add src/web/components/Boxes.tsx src/web/styles.css tests/web/boxes.test.tsx
git commit -m "feat(web): 条目行可点，hover 浮出描述"
```

---

### Task 6: 详情侧栏

**Files:**
- Create: `src/web/components/Detail.tsx`
- Modify: `src/web/App.tsx`
- Modify: `src/web/styles.css`（`.detail`）
- Modify: `README.md`
- Test: `tests/web/detail.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 3 的 `getFile`，Task 4 的 `EntryRef` / `refId`，Task 5 的 `NowBoxView` / `SrcBoxView` 的 `onOpen` / `activeId`。
- Produces: `Detail({ entry, onClose })`、`DetailView(...)`、`defaultFile(files)`、`fileAbs(entry, file)`。

**为什么拆成 `Detail` + `DetailView`：** 组件测试没有 jsdom，跑不了 `useEffect` 和 `fetch`。
把「取数据」和「画出来」分开，`DetailView` 就是个纯函数，`renderToStaticMarkup` 能把它的
每一种状态（加载中 / 出错 / 二进制 / 截断 / 正常）都渲染出来验。容器 `Detail` 只剩几行接线代码。

- [ ] **Step 1: 写失败的测试**

新建 `tests/web/detail.test.tsx`：

```tsx
import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { Peek } from '../../src/core/types.js'
import type { EntryRef } from '../../src/web/graph.js'
import { DetailView, defaultFile, fileAbs } from '../../src/web/components/Detail.js'

const dirEntry: EntryRef = {
  key: 'skills/foo',
  dim: 'skills',
  name: 'foo',
  path: '/repo/.claude/skills/foo',
  isDir: true,
  files: ['reference.md', 'SKILL.md'],
  desc: '我是 foo',
  from: '.claude',
}

const fileEntry: EntryRef = {
  key: 'commands/go',
  dim: 'commands',
  name: 'go.md',
  path: '/repo/.claude/commands/go.md',
  isDir: false,
  files: ['go.md'],
  from: '.claude',
}

const ok = (content: string, extra: Partial<Peek> = {}): Peek => ({
  path: '/x',
  content,
  size: content.length,
  truncated: false,
  binary: false,
  ...extra,
})

const view = (p: Partial<Parameters<typeof DetailView>[0]>) =>
  renderToStaticMarkup(
    <DetailView
      entry={dirEntry}
      file="SKILL.md"
      peek={null}
      loading={false}
      err={null}
      onPick={() => {}}
      onClose={() => {}}
      {...p}
    />,
  )

describe('defaultFile', () => {
  // WHY: SKILL.md 就是这个条目的门面。点开侧栏先看到 reference.md，等于还得再点一次。
  it('有 SKILL.md 就先看它，不管它排第几', () => {
    expect(defaultFile(['reference.md', 'SKILL.md'])).toBe('SKILL.md')
  })
  it('没有 SKILL.md 就看第一个', () => {
    expect(defaultFile(['a.md', 'b.md'])).toBe('a.md')
  })
  it('一个文件都没有 -> undefined', () => {
    expect(defaultFile([])).toBeUndefined()
  })
})

describe('fileAbs', () => {
  it('目录条目：拼子路径', () => {
    expect(fileAbs(dirEntry, 'SKILL.md')).toBe('/repo/.claude/skills/foo/SKILL.md')
  })
  // WHY: 单文件条目的 path 本身就是那个文件。再拼一次 basename 会得到
  // /repo/.claude/commands/go.md/go.md —— 必然 404。
  it('单文件条目：path 就是它自己，不再拼', () => {
    expect(fileAbs(fileEntry, 'go.md')).toBe('/repo/.claude/commands/go.md')
  })
})

describe('DetailView', () => {
  it('画出条目名、来源、绝对路径、描述、文件清单', () => {
    const html = view({ peek: ok('# Foo') })
    expect(html).toContain('foo')
    expect(html).toContain('.claude')
    expect(html).toContain('/repo/.claude/skills/foo')
    expect(html).toContain('我是 foo')
    expect(html).toContain('SKILL.md')
    expect(html).toContain('reference.md')
    expect(html).toContain('# Foo')
  })

  it('没有描述时明说没有，不留一片空白', () => {
    const html = view({ entry: fileEntry, file: 'go.md', peek: ok('go') })
    expect(html).toContain('无 frontmatter 描述')
  })

  it('加载中 / 出错各有状态，不白屏', () => {
    expect(view({ loading: true })).toContain('加载中')
    expect(view({ err: '/api/file -> 403' })).toContain('403')
  })

  // WHY: 二进制 toString 出来是一屏替换字符。明说「是二进制」比装作能显示要诚实。
  it('二进制：明说不展示', () => {
    const html = view({ peek: ok('', { binary: true }) })
    expect(html).toContain('二进制')
  })

  // WHY: 截断了不说，用户会以为他看到的就是全部 —— 那是在撒谎。
  it('截断了必须说出来', () => {
    const html = view({ peek: ok('a'.repeat(10), { truncated: true, size: 999999 }) })
    expect(html).toContain('已截断')
  })

  it('当前查看的文件是选中态', () => {
    const html = view({ file: 'SKILL.md', peek: ok('x') })
    expect(html).toMatch(/aria-pressed="true"[^>]*>SKILL\.md|SKILL\.md/)
  })
})
```

- [ ] **Step 2: 跑测试，确认它失败**

Run: `npx vitest run tests/web/detail.test.tsx`
Expected: FAIL —— `Failed to resolve import "../../src/web/components/Detail.js"`

- [ ] **Step 3: 写 `src/web/components/Detail.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { Peek } from '../../core/types.js'
import type { EntryRef } from '../graph.js'
import { getFile } from '../api.js'

/** 打开侧栏先看哪个文件。SKILL.md 是这个条目的门面 —— 先看它，省用户一次点击。 */
export function defaultFile(files: string[]): string | undefined {
  return files.find((f) => f === 'SKILL.md') ?? files[0]
}

/**
 * 一个文件的绝对路径。
 *
 * 单文件条目（commands / agents / hooks）的 path 本身就是那个文件，
 * 再拼一次 basename 会得到 …/go.md/go.md —— 必然 404。
 */
export function fileAbs(entry: EntryRef, file: string): string {
  return entry.isDir ? `${entry.path}/${file}` : entry.path
}

interface ViewProps {
  entry: EntryRef
  file?: string
  peek: Peek | null
  loading: boolean
  err: string | null
  onPick: (f: string) => void
  onClose: () => void
}

/**
 * 纯展示。把取数据和画出来分开 —— 这样每一种状态
 * （加载中 / 出错 / 二进制 / 截断 / 正常）都能被单独渲染出来验，不用 jsdom。
 */
export function DetailView({ entry, file, peek, loading, err, onPick, onClose }: ViewProps) {
  return (
    <aside className="detail" role="dialog" aria-label={`${entry.key} 详情`}>
      <div className="detail-h">
        <div className="detail-id">
          <div className="detail-t">{entry.name}</div>
          <div className="detail-sub">
            <span className="badge">{entry.dim}</span>
            <span className="detail-from">{entry.from}/</span>
          </div>
        </div>
        <button className="detail-x" onClick={onClose} aria-label="关闭详情" type="button">
          ×
        </button>
      </div>

      <div className="detail-path">{entry.path}</div>

      {entry.desc ? (
        <p className="detail-desc">{entry.desc}</p>
      ) : (
        <p className="detail-desc muted">无 frontmatter 描述</p>
      )}

      <div className="detail-files">
        {entry.files.map((f) => (
          <button
            key={f}
            className="dfile"
            aria-pressed={f === file}
            onClick={() => onPick(f)}
            type="button"
          >
            {f}
          </button>
        ))}
      </div>

      <div className="detail-body">
        {err ? (
          <p className="err">读取失败：{err}</p>
        ) : loading ? (
          <p className="muted">加载中…</p>
        ) : !file ? (
          <p className="muted">这个条目里没有文件</p>
        ) : peek?.binary ? (
          <p className="muted">二进制文件，不展示内容</p>
        ) : peek ? (
          <pre className="detail-pre">{peek.content}</pre>
        ) : null}
      </div>

      {/* 截断了不说，用户会以为他看到的就是全部。 */}
      {peek?.truncated && <div className="detail-cut">已截断，仅显示前 256KB</div>}
    </aside>
  )
}

export function Detail({ entry, onClose }: { entry: EntryRef; onClose: () => void }) {
  const [file, setFile] = useState<string | undefined>(() => defaultFile(entry.files))
  const [peek, setPeek] = useState<Peek | null>(null)
  const [loading, setLoading] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  // 换了个条目：回到它自己的默认文件。不重置的话，上一个条目选中的
  // reference.md 会被带到下一个条目上，而它可能根本没有这个文件。
  useEffect(() => {
    setFile(defaultFile(entry.files))
  }, [entry])

  useEffect(() => {
    if (!file) {
      setPeek(null)
      return
    }
    let dead = false
    setLoading(true)
    setErr(null)
    getFile(fileAbs(entry, file))
      .then((p) => {
        if (dead) return // 请求还在飞的时候用户又点了别的 —— 别让旧结果覆盖新的
        setPeek(p)
        setLoading(false)
      })
      .catch((e) => {
        if (dead) return
        setErr(String(e))
        setLoading(false)
      })
    return () => {
      dead = true
    }
  }, [entry, file])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <DetailView
      entry={entry}
      file={file}
      peek={peek}
      loading={loading}
      err={err}
      onPick={setFile}
      onClose={onClose}
    />
  )
}
```

- [ ] **Step 4: 接进 `src/web/App.tsx`**

4a. import：

```tsx
import { buildGraph, readOnlyPlan, refId, type EntryRef } from './graph.js'
import { Detail } from './components/Detail.js'
```

4b. 在别的 `useState` 旁边加：

```tsx
  const [detail, setDetail] = useState<EntryRef | null>(null)
```

4c. 在 `if (tab === 'global')` 之前算一次：

```tsx
  const activeId = detail ? refId(detail) : undefined
```

（放在早退分支之后、`const busy = …` 之前也行，但全局页也要用，所以要在 `if (tab === 'global')` 之前。）

4d. 全局页那个 `<SrcBoxView>` 加 props，并在 `</div>` 前挂上侧栏：

```tsx
              <SrcBoxView
                dims={globalGraph.src.dims}
                only={globalGraph.src.only}
                fold={{ big: globalGraph.bigDims, open, onToggle }}
                onOpen={setDetail}
                activeId={activeId}
              />
```

在全局页那个 `<div className="global">…</div>` 的闭合标签**之后**、`</Shell>` 之前加：

```tsx
        {detail && <Detail entry={detail} onClose={() => setDetail(null)} />}
```

4e. 主视图：`NowBoxView` 和 `SrcBoxView` 各加 `onOpen={setDetail} activeId={activeId}`：

```tsx
            <NowBoxView
              key={b.tool}
              box={b}
              delay={i * 60}
              fold={{ big: graph.bigDims, open, onToggle }}
              onOpen={setDetail}
              activeId={activeId}
            />
```

```tsx
          <SrcBoxView
            dims={graph.src.dims}
            only={graph.src.only}
            fold={{ big: graph.bigDims, open, onToggle }}
            onOpen={setDetail}
            activeId={activeId}
          />
```

在主视图 `return (…)` 里、`</Shell>` 之前（`result` 那个三元之后）加：

```tsx
      {detail && <Detail entry={detail} onClose={() => setDetail(null)} />}
```

- [ ] **Step 5: 加 CSS**

`src/web/styles.css` 末尾追加：

```css
/* ── 详情侧栏 ──
   不加遮罩层：用户要一边看图一边看侧栏，遮罩会把图盖掉。 */
.detail {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  z-index: 50;
  width: min(480px, 92vw);
  display: flex;
  flex-direction: column;
  background: var(--paper);
  border-left: 1px solid var(--hair);
  box-shadow: -8px 0 28px rgb(0 0 0 / 0.08);
  padding: 22px 22px 0;
}

.detail-h {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.detail-t {
  font-family: var(--mono);
  font-size: 15px;
  font-weight: 600;
  color: var(--ink);
}
.detail-sub {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 5px;
}
.detail-from {
  font-family: var(--mono);
  font-size: 11px;
  color: var(--ink-faint);
}
.detail-x {
  border: 0;
  background: none;
  cursor: pointer;
  font-size: 20px;
  line-height: 1;
  color: var(--ink-faint);
  padding: 2px 6px;
}
.detail-x:hover {
  color: var(--ink);
}

.detail-path {
  margin-top: 12px;
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-faint);
  word-break: break-all;
}

.detail-desc {
  margin: 14px 0 0;
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--ink-soft);
}

.detail-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin: 16px 0 12px;
  padding-top: 14px;
  border-top: 1px solid var(--hair-soft);
}
.dfile {
  font-family: var(--mono);
  font-size: 10.5px;
  color: var(--ink-soft);
  background: var(--sunk);
  border: 1px solid var(--hair);
  border-radius: 4px;
  padding: 3px 8px;
  cursor: pointer;
}
.dfile:hover {
  color: var(--ink);
}
.dfile[aria-pressed='true'] {
  color: var(--moss);
  border-color: color-mix(in srgb, var(--moss) 45%, transparent);
  background: var(--moss-wash);
}

/* 内容区自己滚。整个侧栏跟着滚的话，条目名和文件清单会被滚出视野。 */
.detail-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  margin: 0 -22px;
  padding: 0 22px 22px;
}
.detail-pre {
  margin: 0;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.7;
  color: var(--ink-soft);
  white-space: pre-wrap;
  word-break: break-word;
}

.detail-cut {
  flex: none;
  margin: 0 -22px;
  padding: 8px 22px;
  border-top: 1px solid var(--hair);
  font-size: 11px;
  color: var(--ochre);
}
```

- [ ] **Step 6: 跑测试**

Run: `npm test`
Expected: 全绿。

- [ ] **Step 7: 眼睛验一遍（自动化测试测不到真实交互）**

Run: `npm run dev`

浏览器打开后逐项确认：

1. hover 一个 skill 条目 → 描述浮出来，**四列的线一根都没动**（这是最关键的一条：
   行高一变，线就会跳）。
2. 点它 → 右侧滑出侧栏，默认显示 `SKILL.md` 的内容，那一行变成选中态。
3. 点侧栏里另一个文件 → 内容跟着换。
4. 点「现在」列里冲突的两份 `foo` → 内容确实不一样（这就是这个功能存在的理由）。
5. 点「执行后·唯一源」列里的条目 → 内容显示的是它将会来自的那一份，不是 404。
6. 未裁决的冲突在唯一源列里那行赭石行 → 点不动。
7. 按 ESC → 侧栏关掉。
8. 切到「全局」页 → 条目照样点得开。
9. 开浏览器 devtools 的 Network，手改一个 `/api/file?path=` 请求指向 `package.json` → 403。

- [ ] **Step 8: 更新 README**

`README.md` 的「用法」小节，把默认命令那段（第 17-18 行）改成：

```markdown
默认命令**不会直接改文件**。它扫描仓库、算出一份变更计划，在浏览器里把
「会变成什么样、有什么风险、有什么收益」摆给你看，你点确认之后后端才动手。

图上每个条目 hover 能看到它的 frontmatter 描述，点开能看到它的文件清单和每个文件的内容 ——
裁决冲突之前，你有权先知道这两份 `foo` 到底哪儿不一样。
```

- [ ] **Step 9: 提交**

```bash
git add src/web/components/Detail.tsx src/web/App.tsx src/web/styles.css tests/web/detail.test.tsx README.md
git commit -m "feat(web): 条目详情侧栏 —— 文件清单与内容查看"
```

---

## 完成标准

- `npm test` 全绿，且新增测试覆盖：frontmatter 解析（13 条）、路径白名单（15 条，含 6 条越权）、
  `/api/file` 的 HTTP 行为（4 条）、`Row.ref` 映射（6 条）、可点行与 tooltip（5 条）、侧栏渲染（10 条）。
- `npm run build` 无 TypeScript 错误。
- Task 6 Step 7 的 9 项人工验证全过 —— 尤其是第 1 项（hover 时线不动）和第 9 项（越权 403）。
- 没有新增任何 npm 依赖。
