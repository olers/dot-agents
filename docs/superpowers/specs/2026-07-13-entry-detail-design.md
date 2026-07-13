# 条目详情：描述预览与内容查看

图上每一行现在只有一个名字。名字回答不了「这个 skill 是干什么的」，
更回答不了「我要裁决的这两份 `foo`，到底哪儿不一样」。

本设计给图上的**条目行**补两件事：

1. **描述预览** —— hover 一行，浮出它的 frontmatter `description`。
2. **详情侧栏** —— 点一行，右侧滑出：来源路径、完整描述、文件清单、逐个文件的内容。

## 非目标

- **不在侧栏里做裁决。** 冲突裁决只有 `ConflictPicker` 一个入口。侧栏是查看器，
  多开一个裁决入口，两处状态就会各自漂移。
- **不做语法高亮、不做 diff。** 纯文本展示。引高亮库要么加依赖、要么手写词法器，
  两者都不服务于「看懂这个条目是干什么的」。
- **不做写入。** 侧栏只读。

## 一、描述从哪来

`Entry` 加一个可选字段：

```ts
export interface Entry {
  name: string
  hash: string
  path: string
  isDir: boolean
  files: string[]
  /** frontmatter 里的 description。没有 frontmatter、或没有这个字段时为 undefined。 */
  desc?: string
}
```

解析规则（新文件 `src/core/meta.ts`）：

- **目录条目**（skills）：读 `<entry>/SKILL.md`。不存在 → 无描述。
- **文件条目**（commands / agents / hooks）：读该文件本身。
- frontmatter = 文件以 `---` 起始、到下一个 `---` 行为止的块。抓其中的 `description:`。
- 支持 YAML 里常见的四种写法：裸值、单/双引号包裹、块标量（`>-` / `|`）后跟缩进续行、
  以及 plain scalar 的缩进续行。多行一律折成一行（图上的 tooltip 是单行区域）。
- 上限 500 字，超出截断加省略号。有些 skill 的 description 长达上千字
  （它本来就是写给模型做路由的，不是写给人看的）。
- **任何解析失败都返回 `undefined`，绝不抛异常。** 一个畸形 YAML 不能崩掉整个 scan。

不引 YAML 依赖。当前 `package.json` 的运行时依赖只有 React，为了抓一行 `description:`
拉进一个 YAML parser 不划算 —— 我们不需要通用 YAML，只需要认出这一个 key。

**性能：** `scan` 已经为了算 hash 读过每个条目的全部文件内容，多读一个 `SKILL.md`
的成本可以忽略。

## 二、`/api/file`：唯一有风险的部分

新接口，只读、只 GET，沿用已有的 `x-agents-token`：

```
GET /api/file?path=<绝对路径>

200 { path, content, size, truncated, binary }
403 { error }   路径不在白名单内 / 不是普通文件
404 { error }   不存在
```

校验逻辑放在 `src/core/peek.ts`（放 core 而不是 server，是为了能对着真实临时目录测）。
`Peek` / `PeekResult` 两个类型和其余类型一样声明在 `src/core/types.ts`：

```ts
// types.ts
export interface Peek {
  path: string
  content: string
  size: number
  truncated: boolean
  binary: boolean
}
export type PeekResult = { ok: true; peek: Peek } | { ok: false; code: 403 | 404 }

// peek.ts
export async function peekFile(roots: string[], requested: string): Promise<PeekResult>
```

**这个接口是本次改动引入的唯一攻击面。** 它开在 localhost 上，虽然有随机 token 且
server 跑完即退，路径白名单仍然必须写死：

1. `requested` 必须是绝对路径，否则 403。
2. `realpath` 解析到底 —— 之后所有判断都基于解析后的真实路径。解析失败 → 404。
3. 必须是普通文件。目录 → 403。
4. **白名单：真实路径必须落在 `<root>/<dotdir>/<dim>/` 之下。**
   `root ∈ {repoRoot, homedir}`（全局页是只读展示，也要能看），
   `dotdir ∈ TOOL_DIRS ∪ {.agents}`，`dim ∈ DIMS`。
5. 前缀必须以路径分隔符结尾。否则 `<root>/.claude/skillsEVIL/x.md` 会命中
   `<root>/.claude/skills` 这个前缀。
6. 超过 256KB 只返回前 256KB，`truncated: true`。
7. 内容含 NUL 字节 → 判定二进制，`binary: true`，`content` 留空。

**第 4 条是关键：白名单和 scan 的视野严格一致 —— 图上看得见的才读得到，图上没有的一律 403。**
不能退化成「只要在 repoRoot 之下就行」，那等于顺手开了个读 `.env` / `.git/config` 的口子。
`.claude/settings.json` 也读不到 —— 它在点目录下，但不在任何维度下，图上本来也只是
「工具专属，不碰」的一行。

用户自己在 `skills/` 里接的、指向仓库外的软链，`realpath` 之后自然掉出白名单 → 403。
这和 scan 的行为是一致的：scan 把它记为 `residue.symlink`，不当条目，图上也不给它连线。

**一个必须处理的坑：`roots` 自己也要 `realpath`。** macOS 上 `/tmp` 是 `/private/tmp` 的软链，
测试用 `mkdtemp` 拿到的 repoRoot 是 `/tmp/xxx`，而 `realpath(requested)` 会返回
`/private/tmp/xxx` —— 前缀对不上，合法请求会被误判成 403。

## 三、行 → 条目的映射

`graph.ts` 里的 `Row` 是纯展示模型，不带任何指回真实条目的引用。加一个：

```ts
/** 这一行背后的真实条目。有 ref = 这一行可以点开。 */
export interface EntryRef {
  key: string        // `${dim}/${name}`
  dim: Dim
  name: string
  /** 内容所在的绝对路径 */
  path: string
  files: string[]
  desc?: string
  /** 这份内容现在躺在哪个目录里。侧栏标题上要显示。 */
  from: string
}

export interface Row {
  // …既有字段…
  ref?: EntryRef
}
```

**「现在」列**（`entryRow`）：每一行都带 ref，包括冲突里落败的（`loser`）和被静默去重的
（`dropped`）—— 用户恰恰最想知道「我要删掉的这份到底是什么」。

**「执行后·唯一源」列**（`srcItem`）：这一列是预测，文件还没搬过去，所以 ref 指向
**内容将会来自的那个源路径**。不需要反推 —— `plan.ops` 里 `move` op 的 `to` 就是
`.agents/<dim>/<name>`，`from` 就是源路径。

为此在 `buildGraph` 开头建一张 `path -> {entry, tool}` 索引（遍历 `state.agentsDir.entries`
和所有 `state.tools[*].dims[*].entries`），`move.from` 一查就拿到 `files` / `desc`。
本来就在 `.agents/` 里、这次不用动的条目，直接用它自己的 Entry。

**未裁决冲突的占位行**（唯一源列里那行赭石的「N 份候选 · 未裁决」）**不带 ref，不可点。**
它没有唯一的内容来源 —— 那正是「未裁决」的含义。想看内容，去左边那一列点它的各个候选，
它们本来就并排躺在各自的盒子里。

`Foreign` 行（`only` 列表）、`Residue` 行、软链行、折叠行：都不带 ref，都不可点。
它们不是受管条目。

## 四、描述预览：hover，不占布局

四列图上的线是靠 DOM 锚点实时量出来的。**行高一变，所有接线柱都得重量。**
所以描述绝不能进正常文档流。

`RowView` 在 `row.ref?.desc` 存在时，多渲染一个 `<span className="tip">`：
`position: absolute`，默认 `opacity: 0; pointer-events: none`，`.row:hover .tip` 时浮出。
绝对定位不参与布局 → 行高不变 → 接线柱不动 → `gen` 不需要 +1。

两个 CSS 约束：

- `.row` 要加 `position: relative` 当定位上下文。
- **tooltip 必须挂在 `.row` 的直接子级，不能塞进 `.tx`** —— `.row .tx` 有
  `overflow: hidden`（给名字做 ellipsis 用的），塞进去会被裁掉。
- `.box` 没有 `overflow: hidden`，tooltip 可以溢出盒子。

## 五、详情侧栏

新组件 `src/web/components/Detail.tsx`：

```tsx
export function Detail({ entry, onClose }: { entry: EntryRef; onClose: () => void })
```

- **定位**：`position: fixed`，贴右侧，占满高度，宽约 480px。**不加遮罩层** ——
  用户要一边看图一边看侧栏，遮罩会把图盖掉。
- **关闭**：右上角 × ，或按 ESC。
- **头部**：条目名 · 维度 · 来源（`from`）· 绝对路径。
- **描述**：`desc` 的完整版（不截断到单行）。没有就显示「无 frontmatter 描述」。
- **文件清单**：`entry.files`。点一个切换当前查看的文件。
- **内容**：`<pre>` 纯文本。
  - 打开侧栏时自动加载第一个文件 —— 有 `SKILL.md` 就它，否则 `files[0]`。
    这样点开就有内容，不用再点一次。
  - `binary` → 「二进制文件，不展示内容」。
  - `truncated` → 底部标「已截断，仅显示前 256KB」。
  - 加载中 / 出错各有明确状态，不留白屏。
- **请求路径**：目录条目拼 `${entry.path}/${file}`；单文件条目（`files` 只有一项，
  就是它自己的 basename）直接用 `entry.path`。

`App.tsx` 持有 `const [detail, setDetail] = useState<EntryRef | null>(null)`，
把 `onOpen` 传给 `NowBoxView` / `SrcBoxView`。全局页（只读）同样可点 —— 它的
`repoRoot` 是 `homedir()`，已经在 `peekFile` 的 roots 里。

传递路径：`NowBoxView` → `Entries` → `RowView`。`FoldRow` / `Only` 调的 `RowView`
不需要 `onOpen`（那些行本来就没有 ref）。不引 Context —— 只有两层，显式传更符合本仓库风格。

## 六、可访问性

行是 `div`（改成 `<button>` 会破坏 `.row` 的 flex 布局和既有的 tone class）。
有 ref 时加 `role="button"` / `tabIndex={0}` / `onKeyDown`（Enter 与 Space）。
无 ref 的行不加，键盘 Tab 不会停在不可点的行上。

## 七、测试

**`tests/core/meta.test.ts`** —— frontmatter 解析：

- 有 `description:` → 抓到
- 引号包裹 / 块标量 `>-` 多行 → 抓到并折成一行
- 无 frontmatter / 目录里没有 `SKILL.md` → `undefined`
- 畸形 frontmatter（只有开头 `---`，没有结尾）→ `undefined`，不抛异常
- 超长 description → 截断到 500 字

**`tests/core/peek.test.ts`** —— 对着真实临时目录跑。这是本次改动最重要的一组测试，
每条都编码「为什么这个边界必须存在」：

| 请求 | 期望 | WHY |
|---|---|---|
| `.claude/skills/foo/SKILL.md` | 200 + 内容 | 正常路径 |
| `<root>/package.json` | 403 | 白名单退化成「repoRoot 之下」时，这条会变 200 |
| `<root>/.claude/settings.json` | 403 | 在点目录下但不在维度下。图上不显示的，接口也不给读 |
| `.claude/skills/../../../etc/passwd` | 403 | 路径遍历 |
| `.claude/skills/evil` → 软链到 `<root>/secret.txt` | 403 | realpath 之后掉出白名单 |
| `<root>/.claude/skillsEVIL/x.md` | 403 | 前缀不带分隔符时，这条会命中 `.claude/skills` |
| 不存在的路径 | 404 | |
| 一个目录 | 403 | |
| 含 NUL 的文件 | 200 + `binary: true`，`content` 为空 | |
| 300KB 的文件 | 200 + `truncated: true`，长度 = 256KB | |
| `/tmp` 软链下的合法文件 | 200 | roots 不 realpath 时，这条会误报 403 |

**`tests/server/api.test.ts`** 补三条：`/api/file` 无 token → 401；合法 → 200；越权 → 403。

**`tests/web/boxes.test.tsx`** 补：带 ref 的行点击触发 `onOpen`；不带 ref 的行不可点、
没有 `role="button"`。

**`tests/web/detail.test.tsx`**（新）：给一个 `EntryRef` + mock `fetch`，渲染出描述和文件清单；
点另一个文件 → 内容跟着换；`binary` / `truncated` / 出错各有对应提示。

**`tests/web/graph.test.ts`** 补：唯一源列里被 `move` 进来的条目，其 `ref.path`
等于源路径（不是 `.agents/` 下那个还不存在的目标路径）；未裁决冲突的占位行没有 ref。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/core/meta.ts` | 新增。frontmatter description 解析 |
| `src/core/peek.ts` | 新增。路径白名单 + 文件读取 |
| `src/core/types.ts` | `Entry.desc?: string`；新增 `Peek` / `PeekResult` |
| `src/core/scan.ts` | `readDim` 里给每个 Entry 填 `desc` |
| `src/server/index.ts` | 新增 `GET /api/file` |
| `src/web/api.ts` | 新增 `getFile(path)` |
| `src/web/graph.ts` | `Row.ref?`；`path -> entry` 索引；两列都填 ref |
| `src/web/components/Boxes.tsx` | `RowView` 支持点击 + hover tooltip；`onOpen` 透传 |
| `src/web/components/Detail.tsx` | 新增。侧栏 |
| `src/web/App.tsx` | `detail` 状态 + 挂载侧栏 |
| `src/web/styles.css` | `.row` 定位、`.tip`、`.detail` |
| `README.md` | 「用法」里提一句可以点开看详情 |
