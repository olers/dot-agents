#!/usr/bin/env node
import { Command } from 'commander'
import open from 'open'
import { resolve } from 'node:path'
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
program
  .name('dot-agents')
  .description('把多个 AI Agent 工具目录的通用配置统一到 .agents/ 唯一源')
  .version('0.1.0')

program
  .command('status')
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
  .option('-f, --force', 'git 工作区不干净也执行')
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
    // link 只创建软链，不销毁任何东西 -> 不需要「git 干净」这道闸
    console.log(renderResult(await applyPlan(plan, { force: true })))
  })

function parsePort(v: string): number {
  const n = Number(v)
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    console.error(`非法端口：${v}（需 1-65535 整数）`)
    process.exit(1)
  }
  return n
}

program
  .command('serve')
  .description('宿主模式：长驻、不开浏览器、端口可指定，供外部工具（门户等）托管')
  .option('--port <n>', '监听端口（缺省随机）', parsePort)
  .option('--repo <path>', '扫描目标仓库（缺省 = 当前目录的 git root）')
  .option('--allow-embed <origins>', '允许 iframe 嵌入的 origin（原样写进 CSP frame-ancestors，可空格分隔多个）')
  .action(async (opts: { port?: number; repo?: string; allowEmbed?: string }) => {
    const base = opts.repo ? resolve(opts.repo) : process.cwd()
    const root = await findRepoRoot(base)
    if (!root) {
      console.error(`不是 git 仓库：${base}`)
      process.exit(1)
    }
    let srv: Awaited<ReturnType<typeof startServer>>
    try {
      srv = await startServer(root, { port: opts.port, allowEmbed: opts.allowEmbed })
    } catch (e) {
      console.error(`启动失败：${e instanceof Error ? e.message : String(e)}`)
      process.exit(1)
    }
    // 首行 JSON 是对宿主的启动契约。之后不再往 stdout 写任何东西。
    console.log(JSON.stringify({ app: 'dot-agents', url: srv.url, port: srv.port }))
    const bye = () => {
      srv.close().then(
        () => process.exit(0),
        () => process.exit(1), // 关不干净不装没事
      )
    }
    process.on('SIGINT', bye)
    process.on('SIGTERM', bye)
  })

// 默认命令：起 server + 开浏览器
program.action(async () => {
  const root = await repoRootOrDie()
  const { url, close } = await startServer(root)
  console.log(`dot-agents 已启动：${url}`)
  console.log('在浏览器里审阅计划并确认。按 Ctrl-C 退出。')
  await open(url)
  process.on('SIGINT', () => {
    close().then(
      () => process.exit(0),
      () => process.exit(1), // 关不干净不装没事
    )
  })
})

await program.parseAsync(process.argv)
