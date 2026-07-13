import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * description 的长度上限。
 *
 * 有些 skill 的 description 长达上千字 —— 它本来就是写给模型做路由的，不是写给人看的。
 * 原样塞进 hover 提示，会糊掉半张图。
 */
const MAX_DESC = 500

/**
 * 从一段文本里抓 frontmatter 的 description。
 *
 * 不引 YAML 依赖：我们不需要通用 YAML，只需要认出这一个 key。
 * 任何解析不出来的情况一律返回 undefined —— 一个畸形 frontmatter 不能崩掉整个 scan。
 */
export function parseDesc(text: string): string | undefined {
  const lines = text.split(/\r?\n/)
  if (lines[0]?.trim() !== '---') return undefined

  // 闭合行也要 trim —— 开头那行已经 trim 过了，两边不一致会漏认 "---  "（尾部带空格）这种写法
  const end = lines.findIndex((l, idx) => idx >= 1 && l.trim() === '---')
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
    // 这里不设内存边界：hashPath 已经把条目里的每个文件整个读过一遍，
    // 一个巨型 SKILL.md 会先在 hash 那一步撑爆，这里再加一道假的上限只是自我安慰。
    const buf = await readFile(file)
    return parseDesc(buf.toString('utf8'))
  } catch {
    return undefined
  }
}
