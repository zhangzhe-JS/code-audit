/**
 * 去掉 JS 代码里的注释，字符串、模板字符串、正则里的内容保持不变
 *
 * 逐个字符读，记住当前所在的位置：
 *   代码 / 行注释 / 块注释 / 字符串 / 模板字符串 / 正则
 * 注释里的换行会保留，所以去掉注释后行号不变
 *
 * 两处需要推断的地方：
 * - 遇到 / 时，是除号还是正则开头？看前一个有意义的字符：
 *   在 ( , = : ! & | ? { } ; 等后面，或在 return、typeof 等关键字后面，是正则；否则是除号
 *   推断错了也有兜底：正则不能跨行，读到换行就退回代码状态
 * - 模板字符串里的 ${ } 是代码：里面的注释要去掉，字符串、嵌套模板照常处理
 *
 * 已知限制：
 * - 只处理 JS 注释；.vue 模板里的 <!-- --> 由 vue 插件处理
 * - 除号/正则的推断在极少数写法下会出错，出错时最多少去掉一段注释（a++ / b 这种后置自增已经认得出）
 */

// 出现在这些字符后面的 /，是正则的开头
const REGEX_AFTER_CHARS = '(,=:[!&|?{};+-*%<>~^'

// 出现在这些关键字后面的 /，是正则的开头
const REGEX_AFTER_WORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new',
  'delete', 'void', 'throw', 'instanceof', 'yield', 'await'
])

/**
 * @typedef {object} Comment
 * @property {number} line  注释开始的行号
 * @property {string} text  注释内容，不含 // 、/* * / 本身；块注释里的换行保留
 */

/**
 * 只取出注释：和 stripComments 用同一套判断，字符串、正则里像注释的内容不算
 * @param {string} code
 * @returns {Comment[]}
 */
export function findComments(code) {
  const comments = []
  stripComments(code, comments)
  return comments
}

/**
 * @param {string} code
 * @param {Comment[]} [comments] 传了就把遇到的注释收集进来
 */
export function stripComments(code, comments) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | ' | " | ` | regex
  let inClass = false // 是否在正则的 [...] 里（里面的 / 不结束正则）

  // 模板字符串 ${ } 的嵌套层级：每进入一层 ${ 压入一个计数器，记录这层表达式里还没闭合的 {
  const braces = []

  // 收集注释用：当前注释，以及行号（增量计算，不必每次从头数换行）
  let cur = null
  let lineAt = 1
  let linePos = 0
  const lineOf = (pos) => {
    for (; linePos < pos; linePos++) if (code[linePos] === '\n') lineAt++
    return lineAt
  }
  const begin = (pos) => {
    if (comments) cur = { line: lineOf(pos), text: '' }
  }
  const end = () => {
    if (comments && cur) comments.push(cur)
    cur = null
  }

  while (i < code.length) {
    const c = code[i]
    const n = code[i + 1]

    // 在代码里：看是不是注释、字符串、正则的开头
    if (state === 'code') {
      if (c === '/' && n === '/') { begin(i); state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { begin(i); state = 'block'; i += 2; continue }
      if (c === '/' && regexAllowed(out)) {
        state = 'regex'
        inClass = false
      } else if (c === "'" || c === '"' || c === '`') {
        state = c
      } else if (braces.length > 0 && c === '{') {
        braces[braces.length - 1]++
      } else if (braces.length > 0 && c === '}') {
        // 这层 ${ } 里的 { 都闭合了，这个 } 就是 ${ 的结束，回到模板字符串
        if (braces[braces.length - 1] === 0) {
          braces.pop()
          state = '`'
        } else {
          braces[braces.length - 1]--
        }
      }
      out += c
      i++
      continue
    }

    // 在行注释里：一直跳过，直到换行
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
        end()
      } else if (cur) {
        cur.text += c
      }
      i++
      continue
    }

    // 在块注释里：一直跳过，直到 */；换行保留
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; end(); i += 2; continue }
      if (c === '\n') out += c
      if (cur) cur.text += c
      i++
      continue
    }

    // 在正则里：转义字符原样保留；[...] 里的 / 不算结束
    if (state === 'regex') {
      if (c === '\\') {
        out += c + (n ?? '')
        i += 2
        continue
      }
      if (c === '\n') {
        // 正则不能跨行，说明刚才把除号误判成了正则，退回代码状态
        state = 'code'
      } else if (c === '[') {
        inClass = true
      } else if (c === ']') {
        inClass = false
      } else if (c === '/' && !inClass) {
        state = 'code'
      }
      out += c
      i++
      continue
    }

    // 在字符串或模板字符串里：转义字符原样保留（如 \' 不算结束）
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    // 模板字符串里遇到 ${，进入代码
    if (state === '`' && c === '$' && n === '{') {
      braces.push(0)
      state = 'code'
      out += '${'
      i += 2
      continue
    }
    // 遇到同样的引号，字符串结束
    if (c === state) state = 'code'
    out += c
    i++
  }

  end() // 文件以注释结尾、没有换行或 */ 的情况
  return out
}

/** 根据已输出内容的最后一个有意义的字符，判断接下来的 / 是不是正则的开头 */
function regexAllowed(out) {
  let j = out.length - 1
  while (j >= 0 && /\s/.test(out[j])) j--
  if (j < 0) return true // 文件开头

  const ch = out[j]
  // a++ / b、a-- / b：后置的 ++ / -- 后面是除号（前面是变量、) 或 ]）
  if ((ch === '+' || ch === '-') && out[j - 1] === ch) {
    let k = j - 2
    while (k >= 0 && /\s/.test(out[k])) k--
    if (k >= 0 && /[\w$)\]]/.test(out[k])) return false
  }
  if (REGEX_AFTER_CHARS.includes(ch)) return true
  if (!/[\w$]/.test(ch)) return false // ) ] 引号等后面是除号

  // 前面是一个单词：只有关键字后面才是正则，变量名、数字后面是除号
  let k = j
  while (k >= 0 && /[\w$]/.test(out[k])) k--
  return REGEX_AFTER_WORDS.has(out.slice(k + 1, j + 1))
}
