import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Dim, Plan, Resolutions, Result } from '../core/types.js'
import { doApply, getPlan, getState, type StateBundle } from './api.js'
import { buildGraph, readOnlyPlan } from './graph.js'
import { COLLAPSE_MS, CONVERGE_MS, type Phase } from './phase.js'
import { DistBoxView, NowBoxView, SrcBoxView } from './components/Boxes.js'
import { Wires } from './components/Wires.js'
import { ConflictPicker } from './components/ConflictPicker.js'
import { ResultView } from './components/ResultView.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function App() {
  const [tab, setTab] = useState<'repo' | 'global'>('repo')
  const [bundle, setBundle] = useState<StateBundle | null>(null)
  const [plan, setPlan] = useState<Plan | null>(null)
  const [resolutions, setResolutions] = useState<Resolutions>({})
  const [result, setResult] = useState<Result | null>(null)
  const [phase, setPhase] = useState<Phase>('plan')
  const [err, setErr] = useState<string | null>(null)

  // 重测信号。折叠动画跑完、裁决变了、展开了一个维度，接线柱的位置就变了，线得重新量。
  const [gen, setGen] = useState(0)

  // 展开的维度。提到这里而不是各盒子自己存：一个维度必须在所有盒子里同进同退，
  // 否则线的两端会一头在 DOM 里、一头被折没了。见 Graph.bigDims 上的注释。
  const [open, setOpen] = useState<Set<Dim>>(new Set())
  const onToggle = useCallback((d: Dim) => {
    setOpen((s) => {
      const next = new Set(s)
      if (!next.delete(d)) next.add(d)
      return next
    })
    setGen((g) => g + 1) // 行数变了 = 所有接线柱都挪位了
  }, [])

  useEffect(() => {
    getState()
      .then(setBundle)
      .catch((e) => setErr(String(e)))
  }, [])

  useEffect(() => {
    if (phase !== 'plan') return // 收敛开始后就别再刷新计划了，图正在动
    getPlan(resolutions)
      .then((p) => {
        setPlan(p)
        setGen((g) => g + 1)
      })
      .catch((e) => setErr(String(e)))
  }, [resolutions, phase])

  const graph = useMemo(
    () => (bundle && plan ? buildGraph(bundle.repo, plan) : null),
    [bundle, plan],
  )
  const globalGraph = useMemo(() => {
    const g = bundle?.global
    return g ? buildGraph(g, readOnlyPlan(g.repoRoot)) : null
  }, [bundle])

  if (err)
    return (
      <Shell>
        <p className="err">出错了：{err}</p>
      </Shell>
    )
  if (!bundle || !plan || !graph)
    return (
      <Shell>
        <p className="muted">加载中…</p>
      </Shell>
    )

  /**
   * 收敛。动画是给人看的，apply 是真干活的 —— 两者不能互相冒充。
   * 失败立刻报出来，绝不让动画替一次失败的执行演完收敛。
   */
  async function converge() {
    setPhase('collapsing')
    const t0 = Date.now()

    let r: Result
    try {
      // gitClean=false 时风险已经展示过了，用户点了执行 = 明确同意。
      // 备份和 undo.sh 无论如何都会写 —— force 只跳过 git 那道闸，跳不过 attic。
      r = await doApply(resolutions, !plan!.gitClean)
    } catch (e) {
      setPhase('plan')
      setErr(String(e))
      return
    }

    if (!r.ok) {
      setPhase('plan')
      setErr(r.error ?? '执行失败')
      return
    }

    // 折叠先跑完，锚点稳了才让线重画
    await sleep(Math.max(0, COLLAPSE_MS - (Date.now() - t0)))
    setPhase('linking')
    setGen((g) => g + 1)

    await sleep(Math.max(0, CONVERGE_MS - (Date.now() - t0)))
    setResult(r)
    setPhase('done')
    setGen((g) => g + 1)
  }

  const pick = (key: string, tool: string) =>
    setResolutions((r) => {
      const next = { ...r }
      if (next[key] === tool) delete next[key] // 再点一次 = 取消这次裁决
      else next[key] = tool
      return next
    })

  if (tab === 'global')
    return (
      <Shell path={bundle.repo.repoRoot} tab={tab} setTab={setTab}>
        <div className="global">
          <div className="col-h">
            <span className="lab muted-lab">只读</span>
            <span className="sub">这个工具只动当前仓库。全局目录只展示，不修改。</span>
          </div>
          {globalGraph ? (
            <>
              <SrcBoxView
                dims={globalGraph.src.dims}
                only={globalGraph.src.only}
                fold={{ big: globalGraph.bigDims, open, onToggle }}
              />
              {/* 全局目录里工具多、条目多。竖着堆下去一屏装不下 —— 铺成网格。 */}
              <div className="tiles">
                {globalGraph.dist.map((b, i) => (
                  <DistBoxView key={b.tool} box={b} delay={80 + i * 60} />
                ))}
              </div>
            </>
          ) : (
            <p className="muted">{bundle.globalError}</p>
          )}
        </div>
      </Shell>
    )

  const busy = phase === 'collapsing' || phase === 'linking'

  return (
    <Shell path={bundle.repo.repoRoot} tab={tab} setTab={setTab}>
      <div className={`graph ${phase}`}>
        <Wires
          graph={graph}
          phase={phase}
          gen={gen}
          folded={(d) => graph.bigDims.includes(d) && !open.has(d)}
        />

        <div className="col col-now">
          <div className="col-h">
            <span className="lab">现在</span>
            <span className="sub">散在各处</span>
          </div>
          {graph.now.map((b, i) => (
            <NowBoxView
              key={b.tool}
              box={b}
              delay={i * 60}
              fold={{ big: graph.bigDims, open, onToggle }}
            />
          ))}
        </div>

        <div className="seam">
          <div className="count">
            <div className="count-n">{plan.ops.length}</div>
            <div className="count-l">个操作</div>
          </div>
        </div>

        <div className="col col-src">
          <div className="col-h">
            <span className="lab">执行后</span>
            <span className="sub">唯一源</span>
          </div>
          <SrcBoxView
            dims={graph.src.dims}
            only={graph.src.only}
            fold={{ big: graph.bigDims, open, onToggle }}
          />
        </div>

        <div className="col col-dist">
          <div className="col-h">
            <span className="sub">各点目录只剩软链，指回唯一源</span>
          </div>
          {graph.dist.map((b, i) => (
            <DistBoxView key={b.tool} box={b} delay={220 + i * 60} />
          ))}
        </div>
      </div>

      {/* 白名单之外的点目录。执行前后完全一样，进四列只会制造「它会被改」的错觉 ——
          但完全不提，用户会以为我们没看见。 */}
      {graph.strangers.length > 0 && (
        <div className="strangers">
          <span className="lab">不认识的点目录 · 原样保留</span>
          <div className="slist">
            {graph.strangers.map((r, i) => (
              <span key={i} className="s">
                {r.text}
                {r.target && <span className="rarrow">→ {r.target}</span>}
              </span>
            ))}
          </div>
        </div>
      )}

      {result ? (
        <ResultView result={result} linkCount={graph.linkCount} />
      ) : (
        <>
          {plan.conflicts.length > 0 && (
            <ConflictPicker plan={plan} resolutions={resolutions} onPick={pick} />
          )}

          {plan.risks.length > 0 && (
            <div className="risks">
              {plan.risks.map((r, i) => (
                <p key={i}>{r}</p>
              ))}
            </div>
          )}

          <div className="bar">
            <span className="note">
              {plan.skipped.length > 0 && (
                <span className="warn">跳过 {plan.skipped.length} 个未裁决冲突 · </span>
              )}
              备份写进 .agents/.attic/，同时生成 undo.sh
            </span>
            <button className="go" disabled={busy || plan.ops.length === 0} onClick={converge}>
              {busy ? '收敛中…' : '收敛'}
            </button>
          </div>
        </>
      )}
    </Shell>
  )
}

function Shell({
  children,
  path,
  tab,
  setTab,
}: {
  children: React.ReactNode
  path?: string
  tab?: 'repo' | 'global'
  setTab?: (t: 'repo' | 'global') => void
}) {
  return (
    <div className="app">
      <header className="top">
        <div>
          <div className="title">dot-agents</div>
          {path && <div className="path">{path}</div>}
        </div>
        {tab && setTab && (
          <nav className="tabs" role="tablist">
            <button
              role="tab"
              aria-selected={tab === 'repo'}
              onClick={() => setTab('repo')}
            >
              本仓库
            </button>
            <button
              role="tab"
              aria-selected={tab === 'global'}
              onClick={() => setTab('global')}
            >
              全局
            </button>
          </nav>
        )}
      </header>
      {children}
    </div>
  )
}
