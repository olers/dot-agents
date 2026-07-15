# serve 宿主模式设计

日期：2026-07-15
状态：已定稿
关联：修订 `2026-07-11-dot-agents-design.md` §3 非目标

## 1. 问题

外部宿主（首个消费者：camp-d2c 门户）想把 dot-agents 的审阅 UI 以 iframe 嵌进自己的页面。
现状的默认命令做不到：随机端口、强制 open 浏览器、进程随会话退出、扫描目标只认 cwd。

## 2. 章程修订（对 MVP 设计 §3 的显式偏离）

原非目标写「不做常驻进程 / 状态栏 App，server 生命周期绑定单次会话」。
本设计**维持默认命令的会话语义不变**，新增一个显式 opt-in 的 `serve` 子命令作为宿主模式：

- 默认 `dot-agents`：行为完全不变（随机端口 + open + Ctrl-C 退）。
- `dot-agents serve`：长驻、不 open、端口可指定 —— 生命周期归宿主管，dot-agents 不自己变成常驻 App。

「不做常驻进程」的本意是不做后台守护/状态栏；被别的进程托管长驻不违背本意，故为修订而非推翻。

## 3. CLI 接口（对宿主的中性契约之一）

```
dot-agents serve [--port <n>] [--repo <path>] [--allow-embed <origin>]
```

- `--port`：监听端口，缺省仍随机（listen 0）。占用即报错退出（exit 1），不自动换端口——换不换是宿主的事。
- `--repo`：扫描目标仓库根，缺省 = cwd 的 git root。非 git 仓库照旧报错退出。
- `--allow-embed <origin>`：响应头加 `Content-Security-Policy: frame-ancestors 'self' <origin>`。
  缺省不发该头（保持现状，本地场景可嵌）。给了才收紧+放行指定 origin。
- 不 open 浏览器；前台运行，stdout 首行打一行 JSON：`{"app":"dot-agents","url":...,"port":...}`（宿主可解析，人也能读）。
- SIGINT/SIGTERM 优雅退出。

## 4. 安全加固（serve 与默认模式共用，都在 startServer 里）

长驻 + 固定端口把 DNS rebinding 窗口从秒级拉长到常驻，必须补：

- **Host 校验**：请求 Host 不属于 `{127.0.0.1:<port>, localhost:<port>, [::1]:<port>}` → 403，不区分路径。
  rebinding 页面拿不到 index.html → 拿不到 token → API 链路整体断。
- token 机制不变；`/api/*` 继续要 `x-agents-token`。
- 新增 `GET /healthz`：免 token，返回 `{"app":"dot-agents","version":<pkg 版本>,"repoRoot":<扫描根>}`。
  给宿主做「端口上是谁、扫的是不是我要的仓库」的复用判断。只暴露路径字符串，且在 Host 校验之后，可接受。

## 5. 分发修复

- `package.json` 加 `"prepare": "npm run build"` —— npm git 依赖装完才有 dist/，否则 bin 是坏的。
- `engines.node` 降为 `>=18`：代码为 ES2022 + 标准 node 内置模块，无 20 独占 API；依赖矩阵（commander 12 / open 10 / vite 5 / vitest 2）均支持 18。

## 6. 测试

- serve 命令：指定端口监听、JSON 首行格式、`--repo` 生效。
- Host 校验：坏 Host 拿 `/`、`/healthz`、`/api/state` 全 403；好 Host 全通。
- `/healthz`：免 token 可达，字段齐。
- `--allow-embed`：给了才有 CSP 头，值正确。
- 回归：默认命令行为不变（现有测试不动）。

## 7. 明确不做

- 不做多仓库单进程（一个 serve 只服务一个 repoRoot；宿主要多仓库就起多个）。
- 不做鉴权体系升级（token 注入机制够用，Host 校验补上后闭环）。
- 不做 stdout 之外的宿主通信（无 socket/ipc；契约就是 CLI flags + HTTP）。
