# dot-agents

[![npm version](https://img.shields.io/npm/v/@linemagic/dot-agents.svg)](https://www.npmjs.com/package/@linemagic/dot-agents)
[![license](https://img.shields.io/npm/l/@linemagic/dot-agents.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@linemagic/dot-agents.svg)](https://nodejs.org)

[English](./README.md) | **简体中文**

把散落在 `.claude/`、`.codebuddy/`、`.cursor/` 等各处工具目录里的 skills / commands / agents / hooks 收敛到一个唯一源 —— `.agents/` —— 其余目录改为软链指向它。

改一处，所有 AI 工具同时生效。

## 特性

- **唯一源。** `.agents/` 是唯一进 git 的副本，其余全是软链。
- **先看计划再落盘。** 默认命令不直接写盘 —— 它扫描仓库、算出变更计划，在浏览器里摆给你确认。
- **冲突安全。** 同名但内容不同？停下来问你。绝不替你选，也绝不自动合并。
- **相对软链。** 换台机器照样有效。
- **完整备份。** 所有被移动或删除的内容都备份，并生成 `undo.sh`。中途失败整体回滚。
- **默认不常驻。** 默认模式随用随退：没有 daemon、没有固定端口；需要长驻时用显式的 serve 宿主模式。

## 环境要求

- Node.js >= 18

## 用法

```bash
npx @linemagic/dot-agents           # 起浏览器：看状态、审阅计划、裁决冲突，确认后落盘
npx @linemagic/dot-agents status    # 纯终端，只读
npx @linemagic/dot-agents apply -y  # 无头执行（有未裁决冲突的条目全部跳过）
npx @linemagic/dot-agents link      # 幂等的「安装」：只补软链，绝不移动或删除任何东西
```

默认命令**不直接改文件**。它扫描仓库、算出变更计划，在浏览器里把「会变成什么样、有什么风险、有什么收益」摆给你看，你确认之后后端才动手。

图上每个条目 hover 能看到它的 frontmatter 描述，点开能看到它的文件清单和每个文件的内容 —— 裁决冲突之前，你可以先看清这两份 `foo` 到底哪儿不一样。

### 宿主模式（serve）

默认命令是「开一次用一次」：随机端口、自动开浏览器、Ctrl-C 即退，这仍是唯一的交互式用法。
`serve` 是给**外部宿主**（如门户类工具）托管用的显式 opt-in 模式：

    dot-agents serve --port 18852 --repo /path/to/repo --allow-embed "http://localhost:5273"

- 长驻前台、不开浏览器；生命周期归宿主管（SIGINT/SIGTERM 优雅退出）。
- stdout 首行输出一行 JSON `{"app":"dot-agents","url":"...","port":...}`，之后不再写 stdout。
- `--port` 被占直接 exit 1，绝不换端口；`--repo` 缺省取当前目录的 git root。
- `--allow-embed` 的值原样写进 CSP `frame-ancestors`（可空格分隔多个 origin）；缺省不发 CSP 头。
- 安全：只绑 127.0.0.1；Host 头白名单（防 DNS rebinding）；`/api/*` 仍要页面注入的 token；
  免 token 的只有 `GET /healthz`（返回 app/version/repoRoot，给宿主认人）。

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

软链不进 git，`.agents/` 进 git。clone 下来跑一次 `npx @linemagic/dot-agents link` 补齐软链。软链一律是**相对路径**，换台机器照样有效。

## 冲突

同名但内容不同时（比如 `.claude/skills/foo` 和 `.codebuddy/skills/foo` 不一样），工具**停下来问你**。绝不替你选，也绝不自动合并。

未裁决的冲突会让**整个维度不接软链** —— 因为软链是目录级的，只要还有一个条目留在 `.claude/skills/` 里，这个目录就不能被替换成软链。UI 会明确告诉你哪些目录因此被跳过。

内容**完全相同**的重复副本不算冲突，直接去重，不打扰你。

## 它不做什么

- **不做格式转换。** 只处理同名且格式一致的目录。`rules/` 各家格式不兼容（`.cursor` 用 `.mdc` 且带 frontmatter globs，`.claude` 没有 `rules/` 概念），一律列进「工具专属」，看得见但不碰。
- **默认不常驻。** 默认模式没有 daemon、没有固定端口，跑完即退；长驻只发生在显式的 serve 宿主模式下。

## 安全网

变更前，所有会被移动或删除的内容全部备份进 `.agents/.attic/<时间戳>/backup/`，并生成一个可执行的 `undo.sh`。执行中途失败会**整体回滚**，不留半成品状态。

**备份不可关闭。** `.claude/` 在大多数仓库里是 gitignore 的 —— git 没跟踪它，`git checkout` 恢复不了。`.attic/` 是唯一的回退手段，所以它不可关闭，`--force` 也跳不过它。

（`--force` 只跳过「git 工作区必须干净」那道闸，跳不过备份。）

## 开发

```bash
npm install
npm test        # vitest。core 全部对着真实临时目录跑，不 mock fs ——
                # 软链行为就是这个工具的全部，mock 掉等于什么都没测。
npm run build
```

设计文档：`docs/superpowers/specs/2026-07-11-dot-agents-design.md`

## License

MIT © LineMagic
