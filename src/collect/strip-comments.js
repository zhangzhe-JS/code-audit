/**
 * 去掉 JS 代码里的注释，字符串里的内容保持不变
 *
 * 逐个字符读，记住当前所在的位置：代码 / 行注释 / 块注释 / 字符串
 * 注释里的换行会保留，所以去掉注释后行号不变
 *
 * 已知限制：
 * - 不识别正则字面量，如 /\/\// 里的 // 会被误当成注释开头
 * - 模板字符串里 ${} 嵌套的注释不处理
 * - 只处理 JS 注释；.vue 模板里的 <!-- --> 由 vue 插件处理
 */
export function stripComments(code) {
  let out = ''
  let i = 0
  let state = 'code' // code | line | block | ' | " | `

  while (i < code.length) {
    const c = code[i]
    const n = code[i + 1]

    // 在代码里：看是不是注释或字符串的开头
    if (state === 'code') {
      if (c === '/' && n === '/') { state = 'line'; i += 2; continue }
      if (c === '/' && n === '*') { state = 'block'; i += 2; continue }
      if (c === "'" || c === '"' || c === '`') state = c
      out += c
      i++
      continue
    }

    // 在行注释里：一直跳过，直到换行
    if (state === 'line') {
      if (c === '\n') {
        state = 'code'
        out += c
      }
      i++
      continue
    }

    // 在块注释里：一直跳过，直到 */；换行保留
    if (state === 'block') {
      if (c === '*' && n === '/') { state = 'code'; i += 2; continue }
      if (c === '\n') out += c
      i++
      continue
    }

    // 在字符串里：转义字符原样保留（如 \' 不算结束），遇到同样的引号才结束
    if (c === '\\') {
      out += c + (n ?? '')
      i += 2
      continue
    }
    if (c === state) state = 'code'
    out += c
    i++
  }

  return out
}
