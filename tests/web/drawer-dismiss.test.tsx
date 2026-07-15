// @vitest-environment jsdom
//
// 侧栏「点外面关掉」的判定契约。用 jsdom 造真实 DOM 节点，直接验纯函数 ——
// 不渲染整个 Detail（省掉 fetch/act），但 contains / closest 的语义是真的。
//
// Escape 关、X 关：X 的 onClick 直接调 onClose、Escape 由既有 effect 处理，
// 两条路径本就存在且未改动，这里不重复覆盖；本文件专测新增的「点外面」这条。
import { describe, it, expect, beforeEach } from 'vitest'
import { shouldDismiss } from '../../src/web/components/Detail.js'

let drawer: HTMLElement
beforeEach(() => {
  document.body.innerHTML = ''
  drawer = document.createElement('aside')
  drawer.className = 'detail'
  document.body.appendChild(drawer)
})

const outside = (make?: (el: HTMLElement) => void) => {
  const el = document.createElement('div')
  make?.(el)
  document.body.appendChild(el)
  return el
}

describe('shouldDismiss —— 点外面关掉的判定', () => {
  // WHY: 点图的空白处 = 想收起侧栏。这是「点外面关掉」的主用例。
  it('点抽屉外的空白 -> 关', () => {
    expect(shouldDismiss(outside(), drawer)).toBe(true)
  })

  // WHY: 点侧栏里面（正文、路径、文件名）绝不能关，否则没法读内容。
  it('点抽屉内部 -> 不关', () => {
    const inner = document.createElement('div')
    drawer.appendChild(inner)
    expect(shouldDismiss(inner, drawer)).toBe(false)
  })

  it('点抽屉本身 -> 不关', () => {
    expect(shouldDismiss(drawer, drawer)).toBe(false)
  })

  // WHY: 点另一个条目 = 切换内容，不能「先关再开」。条目是 role=button，交给它自己处理。
  it('点另一个条目（role=button）-> 不关，让它切换', () => {
    const entry = outside((el) => el.setAttribute('role', 'button'))
    expect(shouldDismiss(entry, drawer)).toBe(false)
  })

  it('点抽屉外的按钮 / tab / 折叠钮 -> 不关', () => {
    const btn = document.createElement('button')
    document.body.appendChild(btn)
    expect(shouldDismiss(btn, drawer)).toBe(false)
  })

  // WHY: 嵌在交互控件里的子元素（按钮里的 span）点下去，事件 target 是 span ——
  // closest 往上找到按钮，同样不该关。
  it('点交互控件内部的子元素 -> 不关', () => {
    const btn = outside((el) => (el.setAttribute('role', 'button'), void 0))
    const span = document.createElement('span')
    btn.appendChild(span)
    expect(shouldDismiss(span, drawer)).toBe(false)
  })

  // WHY: X 按钮在抽屉里 —— contains 先命中，不会当成「点外面」；它自己的 onClick 负责关。
  it('X 按钮在抽屉内 -> 判定不关（由 onClick 负责关）', () => {
    const x = document.createElement('button')
    x.className = 'detail-x'
    drawer.appendChild(x)
    expect(shouldDismiss(x, drawer)).toBe(false)
  })

  it('非元素 target（null）-> 不关', () => {
    expect(shouldDismiss(null, drawer)).toBe(false)
  })
})
