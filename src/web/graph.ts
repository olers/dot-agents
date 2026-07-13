import type { Dim, Entry, Foreign, Plan, State } from '../core/types.js'
import { DIMS, TOOL_DIRS, AGENTS_DIR } from '../core/constants.js'

/**
 * 主视图的数据模型：四列 —— 散乱 → 收敛 → 分发。
 *
 *   列 1「现在」  各工具目录里真实躺着什么
 *   列 3「唯一源」执行后 .agents/ 里有什么
 *   列 4「分发」  执行后各工具目录只剩软链，指回唯一源
 *
 * 全部从 state + plan.ops 翻译，不重新推演。
 * 前端一旦自己算一遍「应该会变成什么样」，它的预测就会和真正执行的东西对不上。
 */

export type Tone =
  | 'plain'
  | 'dup' // 同名但内容不同，且还没裁决
  | 'won' // 冲突里被选中的那份
  | 'loser' // 冲突里落败的那份，会被删
  | 'dropped' // 内容完全相同的重复副本，静默去重
  | 'link' // 软链
  | 'broken' // 软链指向了别处
  | 'muted'

/** 接线柱在行的哪一侧。它决定线从哪儿出发 —— 不是装饰。 */
export type Pt = '' | 'l' | 'r' | 'lr'

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

/** 列 1 的一个维度：条目列表和一行软链，收敛时在同一个位置上互换。 */
export interface DimBlock {
  dim: Dim
  head: Row
  entries: Row[]
  /** null = 这个维度这次换不成软链（被未裁决的冲突挡着，或本来就是软链） */
  link: Row | null
}

export interface NowBox {
  tool: string
  /** '唯一源' —— 只有 .agents 那个盒子有。它在「现在」这一列里不是散乱的一份，是终点。 */
  badge?: string
  dims: DimBlock[]
  /** 这个点目录里 dot-agents 不管的东西。不画线，但必须出现 —— 它们真实存在。 */
  only: Row[]
}

export interface DistBox {
  tool: string
  rows: Row[]
}

/** 列 3 的一个维度。分组是为了能整组折叠 —— 一个平铺的 Row[] 折不了。 */
export interface SrcBlock {
  dim: Dim
  head: Row
  entries: Row[]
}

export interface Graph {
  now: NowBox[]
  src: { dims: SrcBlock[]; only: Row[] }
  dist: DistBox[]
  /** 白名单之外的点目录。执行前后都一样，所以只在图外单独列一条。 */
  strangers: Row[]
  /**
   * 条目多到需要折叠的维度。
   *
   * 折叠必须**按维度全局统一**，不能每个盒子自己决定。
   * 线是靠 DOM 锚点量出来的：左边显示 .claude 的前 10 个、右边唯一源折起来了，
   * 那 10 条线就会静默消失 —— 用户看到的是「这些条目不会被收录」，而那是假的。
   * 一个维度要折就全折，要展开就全展开，两端的锚点才始终成对。
   */
  bigDims: Dim[]
  /** 执行后总共几条软链 —— 给结果页用 */
  linkCount: number
}

/** 超过这个条目数的维度默认折起来。 */
export const FOLD_CAP = 10

/* 锚点编码。A/B/F 在左，S/T 在中，C 在右。 */
export const anchorItem = (tool: string, key: string) => `A|${tool}|${key}`
export const anchorToolLink = (tool: string, dim: Dim) => `B|${tool}|${dim}`
/** 折叠后那一行「N 个条目」。整组的线收成一条，落点是唯一源的维度头。 */
export const anchorFold = (tool: string, dim: Dim) => `F|${tool}|${dim}`
export const anchorSrcDim = (dim: Dim) => `S|${dim}`
export const anchorSrcItem = (key: string) => `T|${key}`
export const anchorDistLink = (tool: string, dim: Dim) => `C|${tool}|${dim}`

const linkTarget = (dim: Dim) => `../${AGENTS_DIR}/${dim}`

/**
 * 给只读视图（全局目录）用的空计划。
 * 不能拿当前仓库的 plan 去渲染全局目录 —— 两边的 conflict key 是同名的
 * （都是 `${dim}/${name}`），一撞就会在只读页面上显示一个根本不存在的冲突。
 */
export function readOnlyPlan(repoRoot: string): Plan {
  return {
    repoRoot,
    gitClean: true,
    ops: [],
    conflicts: [],
    resolved: {},
    skipped: [],
    blockedDims: [],
    benefits: [],
    risks: [],
  }
}

export function buildGraph(state: State, plan: Plan): Graph {
  const root = state.repoRoot
  const rel = (p: string) => (p.startsWith(root + '/') ? p.slice(root.length + 1) : p)

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

  const conflicts = new Map(plan.conflicts.map((c) => [c.key, c]))
  const unresolved = new Map(plan.skipped.map((c) => [c.key, c]))

  // `${tool}/${dim}` -> 挡住它的原因（一句话版本）
  const blockedOf = new Map<string, string>()
  for (const b of plan.blockedDims) blockedOf.set(`${b.tool}/${b.dim}`, b.short)

  /** 软链目标：仓库内的显示成相对路径，仓库外的原样显示绝对路径（跨仓库这件事本身就得看得见）。 */
  const showTarget = (p?: string) => (p ? rel(p) : '?')

  /** 「整个点目录是一条软链」那一行。用户自己接的，dot-agents 一个 op 都不发给它。 */
  const wholeLink = (target?: string): Row => ({
    kind: 'link',
    text: '（整个目录）',
    target: showTarget(target),
    note: 'dot-agents 不碰',
    tone: 'muted',
    pt: '',
  })

  const foreignRow = (f: Foreign, note = 'dot-agents 不管理 · 原地不动'): Row =>
    f.kind === 'symlink'
      ? {
          kind: 'link',
          text: f.name,
          target: showTarget(f.target),
          note,
          tone: 'muted',
          pt: '',
        }
      : {
          kind: 'item',
          text: f.kind === 'dir' ? `${f.name}/` : f.name,
          note,
          tone: 'muted',
          pt: '',
        }

  /** .attic 是 dot-agents 自己写的备份，不是「用户放在这儿的东西」。说成「不管理」是错的。 */
  const agentsForeignRow = (f: Foreign): Row =>
    foreignRow(f, f.name === '.attic' ? '历史备份 · 每次执行前写在这里' : '不是受管维度 · 原地不动')

  /**
   * 一个条目在「现在」这一列里的样子。
   *
   * .agents 自己也要走这套 —— 它是冲突里的一个候选方（而且优先级最高），
   * 判它「赢/输/被去重」的规则和工具目录完全一样。两套规则会各自漂移。
   */
  const entryRow = (tool: string, dim: Dim, e: Entry): Row => {
    const key = `${dim}/${e.name}`
    const ref = refOf(tool, dim, e)

    if (conflicts.has(key)) {
      if (unresolved.has(key)) {
        // 未裁决：连到唯一源那一行赭石占位行上。
        // 两条线撞进同一行 —— 冲突长这样，不用一句话解释。
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

    // move 进来的，和「本来就在唯一源里、什么都不用动」的，都走这条
    return item(e.name, 'plain', anchorItem(tool, key), ref)
  }

  /* ── 列 1：现在 ── */
  const now: NowBox[] = []

  // 唯一源现在已经有什么。它也是「现在」的一部分 ——
  // 只画工具目录，用户会以为 .agents/ 是空的，而它里头可能已经躺着 40 个 skill。
  if (state.agentsDir.exists) {
    const blocks: DimBlock[] = []
    for (const dim of DIMS) {
      const es = state.agentsDir.entries[dim]
      if (!es.length) continue
      blocks.push({
        dim,
        head: { kind: 'dir', text: `${dim}/`, tone: 'plain', pt: '' },
        entries: es.map((e) => entryRow(AGENTS_DIR, dim, e)),
        link: null, // 唯一源永远不会被换成软链
      })
    }
    const only = state.agentsDir.only.map(agentsForeignRow)
    if (blocks.length || only.length) {
      now.push({ tool: AGENTS_DIR, badge: '唯一源', dims: blocks, only })
    }
  }

  for (const tool of TOOL_DIRS) {
    const t = state.tools[tool]
    if (!t) continue

    // 整个目录是一条软链。没有维度可收敛，但它在磁盘上明明躺着 ——
    // 不画出来，用户就会问「我的 .claude 呢」。
    if (t.kind === 'symlink') {
      now.push({ tool, dims: [], only: [wholeLink(t.target)] })
      continue
    }

    const blocks: DimBlock[] = []
    for (const dim of DIMS) {
      const st = t.dims[dim]
      if (!st || st.kind === 'absent') continue

      // 已经是软链了 —— 没有内容可收敛，也没什么可折叠的
      if (st.kind === 'linked') {
        blocks.push({
          dim,
          head: {
            kind: 'link',
            text: `${dim}/`,
            target: linkTarget(dim),
            tone: 'link',
            pt: 'r',
            anchor: anchorToolLink(tool, dim),
          },
          entries: [],
          link: null,
        })
        continue
      }

      // 软链指向了别处。不说清楚，用户会以为它已经接好了。
      if (st.kind === 'drifted') {
        blocks.push({
          dim,
          head: {
            kind: 'link',
            text: `${dim}/`,
            target: st.actualTarget,
            note: '指向别处',
            tone: 'broken',
            pt: '',
          },
          entries: [],
          link: null,
        })
        continue
      }

      const entries: Row[] = st.entries.map((e) => entryRow(tool, dim, e))

      // 残留物：dot-agents 不当条目，但它真实存在。
      // .DS_Store 会被删掉 —— 用户有权在执行前看见每一个删除，沉默地删同样是 bug。
      const willRmdir = newLinks.has(`${tool}/${dim}`)
      for (const r of st.residue) {
        entries.push({
          kind: 'item',
          text: r.name,
          note:
            r.kind === 'noise'
              ? willRmdir
                ? '系统垃圾文件 · 备份后删除'
                : '系统垃圾文件 · 原地不动'
              : 'dot-agents 不管理 · 原地不动',
          tone: r.kind === 'noise' && willRmdir ? 'dropped' : 'muted',
          pt: 'r',
        })
      }

      blocks.push({
        dim,
        head: { kind: 'dir', text: `${dim}/`, tone: 'plain', pt: '' },
        entries,
        link: willRmdir
          ? {
              kind: 'link',
              text: `${dim}/`,
              target: linkTarget(dim),
              tone: 'link',
              pt: 'r',
              anchor: anchorToolLink(tool, dim),
            }
          : null,
      })
    }

    // 一个维度都没有的工具目录（比如只有 .codex/environments/）也得进图。
    // 老代码在这里 `if (blocks.length)`，于是它整个消失了 —— 而它确实存在。
    const only = t.only.map((f) => foreignRow(f))
    if (blocks.length || only.length) now.push({ tool, dims: blocks, only })
  }

  /* ── 列 3：唯一源。执行后 .agents/ 里有什么。 ── */
  const srcDims: SrcBlock[] = []
  for (const dim of DIMS) {
    const rows = new Map<string, Row>()

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

    // 未裁决的冲突：它不会进来。放一行赭石占位行，明说它原地不动 ——
    // 不放，用户会以为它悄悄进了唯一源。
    for (const c of plan.skipped) {
      if (c.dim !== dim) continue
      rows.set(c.name, {
        kind: 'item',
        text: c.name,
        note: `${c.candidates.length} 份候选 · 未裁决，原地不动`,
        tone: 'dup',
        pt: 'l',
        anchor: anchorSrcItem(c.key),
      })
    }

    if (!rows.size) continue

    srcDims.push({
      dim,
      head: {
        kind: 'dir',
        text: `${dim}/`,
        tone: 'plain',
        pt: 'lr',
        anchor: anchorSrcDim(dim),
      },
      entries: [...rows.keys()].sort().map((n) => rows.get(n)!),
    })
  }

  // 唯一源里不属于任何受管维度的东西（docs/、plans/、.attic/）执行后原样还在。
  // 只画四个维度，就是在承诺一个「干净的 .agents」—— 而它并不干净。
  const srcOnly = state.agentsDir.only.map(agentsForeignRow)

  /* ── 列 4：分发。执行后每个工具目录只剩软链。 ── */
  const dist: DistBox[] = []
  let linkCount = 0
  for (const tool of TOOL_DIRS) {
    const t = state.tools[tool]
    if (!t) continue

    if (t.kind === 'symlink') {
      // 执行后它还是原样。「执行后」这一列漏掉它，等于暗示它被收敛了。
      dist.push({ tool, rows: [wholeLink(t.target)] })
      continue
    }

    const rows: Row[] = []

    for (const dim of DIMS) {
      const st = t.dims[dim]
      if (!st) continue

      const isNew = newLinks.has(`${tool}/${dim}`)
      const already = st.kind === 'linked'

      if (isNew || already) {
        linkCount++
        rows.push({
          kind: 'link',
          text: `${dim}/`,
          target: linkTarget(dim),
          note: already && !isNew ? '已经是软链' : undefined,
          tone: 'link',
          pt: 'l',
          anchor: anchorDistLink(tool, dim),
        })
        continue
      }

      // 换不成软链的目录。原因可能是未裁决的冲突，也可能是里头有我们不管理的东西。
      // 不管哪种，都得把原因写出来 —— 沉默地跳过是 bug。
      const why = blockedOf.get(`${tool}/${dim}`)
      if (why) {
        rows.push({
          kind: 'note',
          text: `${dim}/`,
          note: `${why}，原地不动`,
          tone: 'dup',
          pt: '',
        })
      }
    }

    // 收敛动不到的东西，执行后还在。列出来才叫「执行后的现状」。
    rows.push(...t.only.map((f) => foreignRow(f)))

    if (rows.length) dist.push({ tool, rows })
  }

  /* ── 白名单之外的点目录。执行前后完全一样，所以不进四列，单独一条。 ── */
  const strangers: Row[] = state.strangers.map((s) =>
    s.kind === 'symlink'
      ? {
          kind: 'link',
          text: s.name,
          target: showTarget(s.target),
          tone: 'muted',
          pt: '',
        }
      : { kind: 'item', text: `${s.name}/`, tone: 'muted', pt: '' },
  )

  /**
   * 折叠判据：一个维度**在任何一个盒子里**超过 FOLD_CAP，它就整个维度一起折。
   *
   * 判据必须是维度级的。让每个盒子自己数自己（.claude/skills 只有 3 个就不折、
   * 唯一源里 43 个就折），左边那 3 条线的落点会被折进去，线就凭空消失了。
   */
  const bigDims = DIMS.filter((dim) => {
    const counts = [
      ...now.map((b) => b.dims.find((d) => d.dim === dim)?.entries.length ?? 0),
      srcDims.find((d) => d.dim === dim)?.entries.length ?? 0,
    ]
    return Math.max(...counts) > FOLD_CAP
  })

  return { now, src: { dims: srcDims, only: srcOnly }, dist, strangers, bigDims, linkCount }
}

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
