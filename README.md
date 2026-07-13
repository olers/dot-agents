# dot-agents

把一个仓库里散落在 `.claude/` `.codebuddy/` `.cursor/` … 各处的 skills / commands / agents / hooks
收敛到 `.agents/` 唯一源，其余目录改为软链指向它。

改一处，所有 AI 工具同时生效。

## 用法

```
npx dot-agents           # 起浏览器：看状态、审阅计划、裁决冲突、点确认才落盘
npx dot-agents status    # 纯终端，只读
npx dot-agents apply -y  # 无头执行（有未裁决冲突时，这些条目全部跳过）
npx dot-agents link      # 幂等的「安装」：只补软链，绝不移动或删除任何东西
```

默认命令**不会直接改文件**。它扫描仓库、算出一份变更计划，在浏览器里把
「会变成什么样、有什么风险、有什么收益」摆给你看，你点确认之后后端才动手。

图上每个条目 hover 能看到它的 frontmatter 描述，点开能看到它的文件清单和每个文件的内容 ——
裁决冲突之前，你有权先知道这两份 `foo` 到底哪儿不一样。

## 达成态

```
.agents/
  skills/       ← 唯一源，进 git
  commands/
.claude/
  skills   -> ../.agents/skills      ← 软链，不进 git
  settings.json                      ← 工具专属，不碰
.codebuddy/
  skills   -> ../.agents/skills
```

软链不进 git，`.agents/` 进 git。clone 下来跑一次 `npx dot-agents link` 补齐软链。
软链一律是**相对路径**，换台机器照样有效。

## 冲突

同名、内容不同（比如 `.claude/skills/foo` 和 `.codebuddy/skills/foo` 不一样）时，
工具**停下来问你**，绝不替你选，也绝不自动合并。

未裁决的冲突会导致**整个维度不接软链** —— 因为软链是目录级的，只要还有一个条目留在
`.claude/skills/` 里，这个目录就不能被替换成软链。UI 会明确告诉你哪些目录因此没接上。

内容**完全相同**的重复副本不算冲突，直接去重，不打扰你。

## 它不做什么

- **不做格式转换。** 只处理同名且格式一致的目录。`rules/` 各家格式不兼容
  （`.cursor` 用 `.mdc` 且带 frontmatter globs，`.claude` 压根没有 `rules/` 概念），
  一律列进「工具专属」，看得见但不碰。
- **不改全局目录。** `~/.claude` 等只读展示。
- **不常驻。** 没有 daemon，没有固定端口。server 跑完即退。

## 安全网

变更前，所有会被移动或删除的内容全部备份进 `.agents/.attic/<时间戳>/backup/`，
并生成一个可执行的 `undo.sh`。执行中途失败会**整体回滚**，不留半成品状态。

**备份不是锦上添花。** `.claude/` 在大多数仓库里是 gitignore 的 —— git 根本没跟踪它，
`git checkout` 救不回来。`.attic/` 是唯一的后悔药，所以它不可关闭，`--force` 也跳不过它。

（`--force` 只跳过「git 工作区必须干净」那道闸，跳不过备份。）

## 开发

```
npm install
npm test        # vitest。core 全部对着真实临时目录跑，不 mock fs ——
                # 软链行为就是这个工具的全部，mock 掉等于什么都没测。
npm run build
```

设计文档：`docs/superpowers/specs/2026-07-11-dot-agents-design.md`

## License

MIT © LineMagic
