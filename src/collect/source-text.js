/**
 * 读源码的公共工具：glob-imports、dynamic-imports 都用
 *
 * - codeOf：取出要分析的代码。单文件组件只看 <script>，再去掉注释；行号不变
 * - readString：读一个字符串字面量
 * - lineAt / skipSpace：定位用
 */
import { stripComments } from './strip-comments.js'

/** 单文件组件：模板里的文字不是 JS，只看 <script> 里的内容 */
export const SFC_EXTENSIONS = ['.vue', '.svelte', '.astro']

/**
 * 要分析的代码：单文件组件只留 <script>，再去掉注释（注释里的写法不算）；行号和原文件一致
 * @param {string} path
 * @param {string} content
 */
export function codeOf(path, content) {
  return stripComments(SFC_EXTENSIONS.some((e) => path.endsWith(e)) ? scriptOnly(content) : content)
}

/** 读一个字符串字面量，返回内容和结束位置；不是字面量返回 null */
export function readString(code, i) {
  const quote = code[i]
  if (quote !== "'" && quote !== '"' && quote !== '`') return null
  let value = ''
  for (let j = i + 1; j < code.length; j++) {
    const ch = code[j]
    if (ch === '\\') {
      value += code[j + 1] ?? ''
      j++
    } else if (ch === quote) {
      return { value, end: j + 1 }
    } else if (quote === '`' && ch === '$' && code[j + 1] === '{') {
      return null // 模板字符串里有变量：不是固定的值
    } else if (ch === '\n' && quote !== '`') {
      return null
    } else {
      value += ch
    }
  }
  return null
}

/**
 * 只保留 <script> 块里的内容，其余部分换成同样多的空行，行号不变
 * .astro 的代码写在开头的 --- 之间，也一并保留
 * @param {string} content
 */
export function scriptOnly(content) {
  const keep = []
  for (const m of content.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) {
    const start = m.index + m[0].indexOf('>') + 1
    keep.push([start, start + m[1].length])
  }
  const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (fm) {
    const start = content.indexOf('\n') + 1 // 第一行 --- 之后
    keep.push([start, start + fm[1].length])
  }
  keep.sort((a, b) => a[0] - b[0])

  let out = ''
  let pos = 0
  for (const [s, e] of keep) {
    if (s < pos) continue
    out += blankLines(content.slice(pos, s)) + content.slice(s, e)
    pos = e
  }
  return out + blankLines(content.slice(pos))
}

function blankLines(text) {
  return '\n'.repeat((text.match(/\n/g) ?? []).length)
}

export function skipSpace(code, i) {
  while (i < code.length && /\s/.test(code[i])) i++
  return i
}

export function lineAt(code, index) {
  let line = 1
  for (let i = 0; i < index; i++) if (code[i] === '\n') line++
  return line
}
