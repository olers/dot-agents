# dot-agents 设计文档

日期：2026-07-11
状态：已定稿（MVP 范围）

## 1. 问题

一个仓库里同时存在多个 AI Agent 工具的根目录（`.claude/`、`.codebuddy/`、`.cursor/` …），
它们各自维护一份 `skills/`、`commands/`、`agents/` 等配置。同样的内容被复制多份，改一处要同步多处，
时间一长就漂移，且没人知道到底哪份是最新的。

## 2. 目标

把所有**通用**配置收敛到 `.agents/` 作为唯一源，其他工具目录下的同名子目录改为指向唯一源的软链。

达成态：

```
.agents/
  skills/       ← 唯一源
  commands/
  agents/
.claude/
  skills   -> ../.agents/skills
  commands -> ../.agents/commands
  settings.json          ← 工具专属，不碰
.codebuddy/
  skills   -> ../.agents/skills
```

## 3. 非目标（明确不做）

- **不做格式转换。** 只处理**同名且格式一致**的子目录。
  一旦开始做格式转换，工具就从「链接器」变成「编译器」，复杂度失控。
- **MVP 不处理 `rules/`。** 各家格式分歧最大（`.cursor/rules/*.mdc` 带 frontmatter globs，
  `.claude` 根本没有 `rules/` 概念、用 `CLAUDE.md`）。同名 ≠ 同格式，收进同一个源就是在制造损坏。
  `rules/` 归入 `toolOnly` 显式展示，不碰。
- **不做自动合并。** 冲突交给人裁决。自动合并提示词是灾难。
- **不改全局目录。** `~/.claude` 等只读展示，不做任何写操作。
- **不做常驻进程 / 状态栏 App。** server 生命周期绑定单次会话，跑完即退。

## 4. 交付形态

CLI 为主，本地 HTML 视图做「审阅 → 确认 → 执行」。

```
dot-agents            # 扫描 → 起 localhost server → open 浏览器 → 等你审阅并点 Apply
dot-agents status     # 纯终端表格，只读，不开浏览器
dot-agents apply -y   # 无头执行，跳过 UI（给脚本用）；有未裁决冲突时全部跳过
dot-agents link       # 幂等的「安装」：只按 .agents 现有内容补齐软链，不 move 任何东西
```

`dot-agents link` 是给 clone 仓库的人用的 —— 软链不进 git，只有 `.agents/` 进 git（见 §9）。

**核心交互不是「跑完就改了」，而是：扫描 → 生成 Plan → 前端展示「会变成什么样、有什么风险、有什么收益」→ 人点确认 → 后端才真的动文件。**

## 5. 架构：一个 core，两个壳

```
core/     纯逻辑，不碰 process / http / console。全部可单测。
  scan(repoRoot)   -> State
  plan(State, resolutions) -> Plan
  apply(Plan, fs)  -> Result
cli/      薄壳，调 core，渲染终端表格
server/   薄壳，把 core 暴露成 HTTP
web/      React + Vite，build 成静态资源打进 npm 包
```

**硬约束：所有决策逻辑在 `core/`。`server/` 和 `cli/` 里不允许出现业务分支判断。**
这是防「逻辑漏进 UI 层」的唯一办法 —— CLI 和 UI 是同一个 core 的两个渲染器，不是两个实现。

技术栈：TypeScript + Node（npx 分发）、React + Vite（UI）、vitest（测试）。

## 6. 扫描与状态模型

### 6.1 根目录发现

git root 下匹配内置白名单的目录：

```
.claude  .codebuddy  .cursor  .gemini  .qoder  .trae  .windsurf
```

可在 `.agents/config.json` 里追加。**不用通配 `.*/`** —— 否则 `.git` `.vscode` `.venv` 全被扫进来。
白名单是刻意的限制。

### 6.2 共享维度

只处理这几个子目录名（同名**且格式一致**才管）：

```
skills/  commands/  agents/  hooks/
```

`rules/` 不在其中 —— 见「非目标」。它会出现在 `toolOnly` 里。

### 6.3 状态：每个 (工具, 维度) 只有 5 种

| 状态 | 含义 | 后续动作 |
|---|---|---|
| `linked` | 已是软链且指向 `.agents/<维度>` | 无需动作 |
| `absent` | 该工具没这个目录 | 直接建软链 |
| `real` | 真实目录，有内容，未链接 | 收录 → 建链 |
| `drifted` | 是软链，但指向别处 | 重建软链 |

第 5 种 —— `conflict` —— **不是 scan 的产物，是 plan 的产物。**
`.claude/skills/foo` 和 `.codebuddy/skills/foo` 内容不同、而 `.agents` 里还没有 `foo` 时，
scan 阶段两边都只是 `real`，冲突只在跨来源比较时才存在。
所以：`scan` 出 4 种状态，`plan` 出 `Conflict[]`，UI 把两者叠加渲染成 5 种格子。

### 6.4 冲突判定

逐**条目**比较（`skills/foo/` 整个目录算一个条目）。
条目内容哈希 = 递归遍历，对每个文件取 `(相对路径, 文件内容)` 求哈希，忽略 mtime / 权限。

- `.agents` 里没有该条目 → 收录，不冲突
- `.agents` 里有，**哈希相同** → 内容完全一致，丢弃重复的那份（无损）
- `.agents` 里有，**哈希不同** → `conflict`，进人工裁决队列

### 6.5 数据模型

```ts
type Dim = 'skills' | 'commands' | 'agents' | 'hooks'

type Entry = { name: string; hash: string; path: string; isDir: boolean }

type Conflict = {
  dim: Dim
  name: string
  candidates: { tool: string; hash: string; path: string; files: string[] }[]
  agentsSide: { hash: string; path: string; files: string[] }
}

type EntryState =
  | { kind: 'linked' }
  | { kind: 'absent' }
  | { kind: 'real'; entries: Entry[] }
  | { kind: 'drifted'; actualTarget: string }

type State = {
  repoRoot: string
  gitClean: boolean
  gitIgnored: string[]                 // 被 gitignore 的工具目录 → 风险提示的依据
  agentsDir: { exists: boolean; entries: Record<Dim, Entry[]> }
  tools: Record<string, Partial<Record<Dim, EntryState>>>
  toolOnly: Record<string, string[]>   // 工具专属、明确不碰的路径清单
}
```

**`toolOnly` 是设计的一部分，不是附赠。**
沉默地不处理某个文件 = bug；显式列出「我看见了，但故意没动」= 特性。

## 7. Plan

```ts
type Op =
  | { t: 'mkdir';    path: string }
  | { t: 'move';     from: string; to: string }      // 收录：工具目录 → .agents
  | { t: 'discard';  path: string }                  // 哈希相同的重复份（先备份再删）
  | { t: 'rmdir';    path: string }                  // 清空后的空目录
  | { t: 'symlink';  path: string; target: string }  // 相对路径
  | { t: 'unlink';   path: string }                  // drifted 的旧软链

type Plan = {
  ops: Op[]
  conflicts: Conflict[]            // 全部冲突
  resolved: Record<string, string> // conflictKey -> 赢家 tool（未裁决的不在里面）
  skipped: Conflict[]              // 未裁决 → 本次跳过，不动
  benefits: string[]               // 「3 份重复的 skills 收敛为 1 份」
  risks: string[]                  // 「.claude/ 在 .gitignore 里，git 回滚无效，依赖 .attic 备份」
}
```

**Op 顺序有依赖，必须按此顺序生成：**
`mkdir` → `move` / `discard`（清空源目录）→ `unlink` / `rmdir`（删掉空壳）→ `symlink`

**`conflictKey` = `` `${dim}/${name}` ``**（如 `skills/foo`）。`resolutions` 用它做 key。

**plan 用「按条目名归组」的两趟算法，不是逐工具增量处理。**

- **第 1 趟**：对每个 `(dim, name)`，把**所有**来源（`.agents` + 每个工具）的这份内容收在一起，
  按哈希去重。1 个哈希 → 无冲突，选一份当源、其余 `discard`。≥2 个哈希 → `Conflict`，全部候选入列。
- **第 2 趟**：对每个 `(tool, dim)` 决定软链 op。该维度下只要还有**未裁决**的冲突条目，
  这个 `(tool, dim)` 就被 block，不建链。

**不能逐个工具增量处理。** 那样 `.claude/skills/foo` 会先被 move 进空的 `.agents`，
`.codebuddy/skills/foo` 再来比时，比的是「刚被移进去的自己人」而不是「原本的 `.agents`」——
冲突的归属和候选列表会依赖工具遍历顺序，同一份数据算两次结果不同。

未裁决的冲突条目 → **整个维度跳过建链**。
因为软链是目录级的：只要还有一个条目留在 `.claude/skills/` 里，这个目录就不能被替换成软链。
UI 必须把这一点讲清楚 —— 用户以为「跳过一个 skill」，实际是「这个工具的 skills 整个没接上」。

## 8. Apply：事务语义

1. **前置检查**：git working tree 干净（`--force` 可跳过）；`.agents/` 可写。
2. **备份**：所有将被 move / discard / unlink 的原始内容，**copy**（不是 move）到 `.agents/.attic/<ISO-时间戳>/`。
3. **写 undo 脚本**：`.agents/.attic/<ts>/undo.sh`，能把所有动作反向撤销。
4. **执行 ops**，每一步成功后记进内存 journal。
5. **任一步失败** → 反向执行 journal 回滚 → 抛错退出，不留半成品状态。
6. 成功 → 返回 Result，前端展示做了什么 + undo 命令。

### 关于安全网的一个重要事实

**`.claude/` 在绝大多数仓库里是 gitignore 的。gitignore 的文件 git 不跟踪，`git checkout` 救不回来。**

所以「git working tree 干净」这条检查在最需要它的场景下**是失效的**。
真正的兜底是 `.agents/.attic/` 备份 —— 因此 attic 备份**不可关闭**，`--force` 也不能跳过它。

`.agents/.attic/` 要写进 `.gitignore`。

## 9. 软链与 git

- **软链不进 git。** `.agents/` 进 git。
- 别人 clone 下来只有 `.agents/`，跑一次 `dot-agents link` 生成软链。
- `dot-agents link` 是幂等的「安装」步骤。
- 软链用**相对路径**（`.claude/skills -> ../.agents/skills`），跨机器有效。

## 10. Server

- 监听 `127.0.0.1` + **随机端口**。
- 启动时生成**随机 token**，注入进 HTML；每个 API 请求校验 `X-Agents-Token` header。
- 跑完即退（Apply 完成或浏览器关闭后超时退出）。
- 没有守护进程，没有固定端口。

```
GET  /api/state   -> { repo: State, global: State }   // global 只读
POST /api/plan    -> Plan     body: { resolutions }
POST /api/apply   -> Result   body: { resolutions, force }
```

**`/api/apply` 只收 `resolutions`，绝不接受前端传来的 `Plan`。**
`Plan.ops` 里全是 `move` / `discard` / `rmdir` —— 照着执行前端给的 ops，
等于把一个任意文件删除接口暴露在 localhost 上。后端必须自己重新 `scan` + `plan`，
再执行自己算出来的 ops。前端只有「选哪个赢家」这一点权力。

## 11. UI

单页。顶部 tab：`[本仓库]` / `[全局 · 只读]`。

本仓库页，从上到下：

1. **状态矩阵** — 工具 × 维度 的网格，每格一个状态 chip（linked / real / conflict / drifted / absent）
2. **变更计划** — 会 move 几项、建几条软链、丢弃几份重复、跳过几项
3. **冲突裁决** — 每个冲突一张卡，展示各候选方的文件差异，radio 选赢家；输家备份进 attic
4. **风险 & 收益** — 直接渲染 `Plan.risks` / `Plan.benefits`
5. **不碰的清单** — 渲染 `toolOnly`
6. **Apply 按钮** — 有未裁决冲突时，按钮上明示「将跳过 N 项」

Apply 后 → 结果页：做了什么、undo 命令、server 退出提示。

全局 tab：同样的状态矩阵，**只读，没有任何按钮**。

## 12. 测试

vitest，`core/` 对着临时目录跑真实 fs（不 mock —— 软链行为是这工具的全部，mock 掉就什么都没测）。

关键用例（每条都编码「为什么这个行为重要」）：

- `scan` 能区分 5 种状态 —— 状态判错会导致 plan 破坏用户文件
- 哈希相同 → `discard`，**不**报冲突 —— 内容一致却让人裁决，是在浪费人的注意力，人会开始无脑点确认
- 哈希不同 → `conflict`，**绝不**自动选 —— 静默丢内容是这工具最严重的失败模式
- apply 中途失败 → **完全回滚** —— 半成品状态（源已删、链没建）会让仓库的 agent 配置直接消失
- undo.sh 能还原到 apply 前 —— 这是 gitignore 场景下唯一的后悔药
- **幂等**：apply 两次，第二次的 plan 为空 —— 非幂等会导致重复运行时破坏已建好的软链
- 未裁决冲突 → 该维度整个跳过，不建链 —— 建了链就等于丢掉了没裁决的那份

## 13. MVP 范围

**做：**
- 白名单 7 个工具目录，4 个维度（`skills` / `commands` / `agents` / `hooks`）
- `dot-agents` / `dot-agents status` / `dot-agents apply -y` / `dot-agents link`
- 5 种状态检测 + 冲突裁决 UI
- 4 层安全网（git 检查 / attic 备份 / undo.sh / 失败回滚）
- 全局只读 tab

**不做（后续迭代）：**
- `rules/` 维度（格式分歧，需要适配器）
- 逐行 diff 视图（MVP 只展示「哪些文件不同 / 新增 / 缺失」的摘要）
- 格式转换适配器
- 状态栏 App
- watch 模式
