/**
 * Vue 全局注册的组件：模板里直接写 <BasicTable>，不用 import
 *
 * unplugin-vue-components 等会生成一个声明文件（常见名字 components.d.ts）：
 *   declare module 'vue' {
 *     export interface GlobalComponents {
 *       BasicTable: (typeof import('./components/BasicTable/index.vue'))['default']
 *     }
 *   }
 * 有两个问题：
 * 1. tsconfig 把这个声明文件列为源文件时，knip 把里面的 typeof import 当成引用：登记过的组件一律算在用，没人用的也查不出来
 * 2. 模板里写标签的用法，knip 看不到：不登记的话，在用的组件会被当成没人用
 *
 * 做法：
 * - 认出声明文件（.d.ts 里有 interface GlobalComponents），读出「组件名 → 文件」，scan 的临时目录里不放这个声明文件
 * - 在各个 .vue 里找用法，记下哪个文件哪一行用了哪个组件（模板里的 HTML 注释、脚本里的注释不算）：
 *     标签                <BasicTable>、<basic-table>
 *     动态组件写死的名字   <component is="BasicTable">、is="vue:BasicTable"、:is="'BasicTable'"
 *     脚本里按名字取       resolveComponent('BasicTable')
 * - 在临时目录的拷贝里，给用到标签的文件补上 import（插在 <script> 那一行，行号不变），knip 就能顺着真实的引用关系走：
 *   只被没人用的页面用到的组件，照样判为没人用
 *
 * 已知限制：
 * - 只认声明文件里登记了的组件。全局注册了但没生成声明文件（dts: false）的，模板里的用法看不到
 * - 名字是变量的（:is="name"、resolveComponent(name)）看不出是哪个组件
 */
import { posix } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSpec } from './path-refs.js'
import { codeOf } from './source-text.js'

const ENTRY = /([A-Za-z_$][\w$]*)\s*:\s*\(?\s*typeof\s+import\(\s*(['"])([^'"]+)\2\s*\)\s*\)?\s*\[\s*['"]default['"]\s*\]/g

/**
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files  源码文件
 * @param {Set<string>} opts.sourceSet  提交里的源码文件（组件要真的存在才算）
 * @param {Record<string, string>} [opts.aliases]
 * @returns {{declarations: string[], components: Map<string, string>}} 声明文件；组件名 → 文件
 */
export function findGlobalComponents({ files, sourceSet, aliases = {} }) {
  const declarations = []
  const components = new Map()
  for (const { path, content } of files) {
    if (!path.endsWith('.d.ts') || !/\binterface\s+GlobalComponents\b/.test(content)) continue
    let local = 0
    for (const m of content.matchAll(ENTRY)) {
      const resolved = resolveSpec(m[3], path, aliases)
      if (resolved !== null && sourceSet.has(resolved)) {
        components.set(m[1], resolved)
        local++
      }
    }
    // 只登记了第三方组件（element-plus 等）的声明文件不影响分析，不用拿掉
    if (local > 0) declarations.push(path)
  }
  return { declarations, components }
}

/**
 * 用到全局组件的地方：模板里的标签、动态组件写死的名字，脚本里的 resolveComponent('名字')
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {Map<string, string>} opts.components  组件名 → 文件
 * @returns {Map<string, {from: string, line: number}[]>} 组件文件 → 用到它的地方；自己用自己不算
 */
export function findTagUses({ files, components }) {
  const result = new Map()
  if (components.size === 0) return result
  const patterns = [...components].map(([name, file]) => {
    const n = `(?:${escape(name)}|${escape(kebab(name))})`
    return {
      file,
      // 标签；is="名字"（Vue3 可以写 vue:名字）；:is="'名字'" / v-bind:is="'名字'"
      template: new RegExp(
        `<${n}(?=[\\s/>])|(?<![:\\w-])is\\s*=\\s*(["'])(?:vue:)?${n}\\1|(?::|v-bind:)is\\s*=\\s*(["'])\\s*(["'\`])${n}\\3\\s*\\2`,
        'g'
      ),
      script: new RegExp(`\\bresolveComponent\\(\\s*(["'\`])${n}\\1\\s*\\)`, 'g')
    }
  })
  const add = (file, from, text, index) => {
    const line = 1 + (text.slice(0, index).match(/\n/g) ?? []).length
    const refs = result.get(file) ?? []
    if (!refs.some((r) => r.from === from && r.line === line)) refs.push({ from, line })
    result.set(file, refs)
  }
  for (const { path, content } of files) {
    if (!path.endsWith('.vue')) continue
    const template = templateOnly(content)
    const code = codeOf(path, content) // 只留 <script>、去掉注释，行号不变
    for (const p of patterns) {
      if (p.file === path) continue
      for (const m of template.matchAll(p.template)) add(p.file, path, template, m.index)
      for (const m of code.matchAll(p.script)) add(p.file, path, code, m.index)
    }
  }
  for (const refs of result.values()) refs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line))
  return result
}

/**
 * 在临时目录的拷贝里，给用到标签的文件补上 import，让 knip 看到这条引用
 * .vue：插在第一个 <script ...> 标签的同一行，行号不变；没有 <script> 的，在第一行前面补一个
 * 其他文件（.js、.ts，自动导入的用法）：补在第一行开头，行号不变
 * 只改 scan 自己的临时目录，不碰原项目
 * @param {string} dir  临时目录
 * @param {Map<string, {from: string, line: number}[]>} tagUses
 */
export function injectImports(dir, tagUses) {
  const byFrom = new Map()
  for (const [file, refs] of tagUses) {
    for (const r of refs) byFrom.set(r.from, new Set([...(byFrom.get(r.from) ?? []), file]))
  }
  for (const [from, files] of byFrom) {
    const imports = [...files]
      .sort()
      .map((f) => {
        const rel = posix.relative(posix.dirname(from), f)
        return `import '${rel.startsWith('.') ? rel : `./${rel}`}';`
      })
      .join('')
    const p = join(dir, from)
    const content = readFileSync(p, 'utf8')
    let next
    if (!from.endsWith('.vue')) {
      next = imports + content
    } else {
      const m = content.match(/<script\b[^>]*>/)
      next = m ? content.slice(0, m.index + m[0].length) + imports + content.slice(m.index + m[0].length) : `<script>${imports}</script>${content}`
    }
    writeFileSync(p, next)
  }
}

/** 只留 <template> 部分：<script>、<style> 块和 HTML 注释换成同样多的空行，行号不变 */
export function templateOnly(content) {
  const blank = (m) => m.replace(/[^\n]/g, '')
  return content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, blank).replace(/<!--[\s\S]*?-->/g, blank)
}

/** BasicTable → basic-table */
export function kebab(name) {
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase()
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')
}

/** 两份「被引用的文件 → 引用的地方」合在一起 */
export function mergeRefs(a, b) {
  const out = new Map([...a].map(([k, v]) => [k, [...v]]))
  for (const [k, v] of b) {
    const list = out.get(k) ?? []
    for (const r of v) if (!list.some((x) => x.from === r.from && x.line === r.line)) list.push(r)
    list.sort((x, y) => (x.from < y.from ? -1 : x.from > y.from ? 1 : x.line - y.line))
    out.set(k, list)
  }
  return out
}

/**
 * 名字是变量的动态组件：:is="name"、v-bind:is="name"、resolveComponent(name)
 * 看不出是哪个组件。项目有全局注册的组件时，scan 把它们当成范围确定不了的动态加载：可能被用到的全局组件判 unknown
 * （写死字符串的 :is="'X'"、resolveComponent('X') 由 findTagUses 认出，不在这里）
 * @param {{path: string, content: string}[]} files
 * @returns {{from: string, line: number, expr: string}[]}
 */
export function findComponentVarUses(files) {
  const out = []
  for (const { path, content } of files) {
    if (!path.endsWith('.vue')) continue
    const template = templateOnly(content)
    for (const m of template.matchAll(/(?::|v-bind:)is\s*=\s*(["'])([\s\S]*?)\1/g)) {
      const value = m[2].trim()
      if (/^(["'`])[^"'`]*\1$/.test(value)) continue // 写死的字符串
      out.push({ from: path, line: lineOf(template, m.index), expr: shortExpr(m[0]) })
    }
    const code = codeOf(path, content)
    for (const m of code.matchAll(/\bresolveComponent\(\s*([^)]*?)\s*\)/g)) {
      if (/^(["'`])[^"'`]*\1$/.test(m[1])) continue
      out.push({ from: path, line: lineOf(code, m.index), expr: shortExpr(m[0]) })
    }
  }
  return out
}

/**
 * 兜底：在用的模板里出现了和候选组件同名的标签
 *
 * 全局注册了但没有声明文件（dts: false、手写的 app.component 循环注册）、或者别处注册了同名组件时，
 * 标签到底指向哪个文件看不出来。只要同名、又不是这个文件自己 import 进来的名字，就不能判死：
 * - 模板里在用：可能在用，判 unknown
 * - 只出现在模板的 HTML 注释里：判 dormant（注释停用）
 *
 * 组件名从路径推：文件名（index.vue 用所在目录名），大驼峰和短横线两种写法；
 * 短横线写法只认带 - 的（单个单词的 <header> 是 HTML 自己的标签）
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files  在用的 .vue 文件（不含候选、测试）
 * @param {string[]} opts.targets  要查的候选 .vue
 * @returns {{used: Map<string, {from: string, line: number, tag: string}[]>, commented: Map<string, {from: string, line: number, tag: string}[]>}}
 */
export function findSameNameTags({ files, targets }) {
  const used = new Map()
  const commented = new Map()
  const names = targets.map((t) => ({ target: t, name: componentName(t) })).filter((x) => x.name)
  if (names.length === 0) return { used, commented }
  const add = (map, target, ref) => {
    const list = map.get(target) ?? []
    if (!list.some((r) => r.from === ref.from && r.line === ref.line)) list.push(ref)
    map.set(target, list)
  }
  for (const { path, content } of files) {
    if (!path.endsWith('.vue')) continue
    const blanked = content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ''))
    const live = templateOnly(content)
    // 只在注释里的部分：模板（不含 script、style）减去去掉注释后的模板
    const commentsOnly = blanked.replace(/<!--([\s\S]*?)-->|[^\n]/g, (m, inner) => (inner !== undefined ? `    ${inner}   ` : m === '\n' ? '\n' : ' '))
    const code = codeOf(path, content)
    for (const { target, name } of names) {
      if (target === path) continue
      const k = kebab(name)
      const re = new RegExp(`<(${escape(name)}${k.includes('-') ? `|${escape(k)}` : ''})(?=[\\s/>])`, 'g')
      // 这个文件自己 import 了同名的组件：标签指向 import 进来的那个，不是这个候选
      if (new RegExp(`\\bimport\\s+${escape(name)}\\b|\\bimport\\s*\\{[^}]*\\b${escape(name)}\\b[^}]*\\}`).test(code)) continue
      for (const m of live.matchAll(re)) add(used, target, { from: path, line: lineOf(live, m.index), tag: `<${m[1]}>` })
      for (const m of commentsOnly.matchAll(re)) add(commented, target, { from: path, line: lineOf(commentsOnly, m.index), tag: `<${m[1]}>` })
    }
  }
  return { used, commented }
}

/** 从路径推组件名：BasicModal.vue → BasicModal；basic-modal/index.vue → BasicModal；index.vue 在根目录时推不出 */
export function componentName(file) {
  const parts = file.split('/')
  let base = parts.at(-1).replace(/\.vue$/, '')
  if (base === 'index') base = parts.at(-2) ?? ''
  if (!base) return null
  return base.replace(/(^|[-_ ])([a-zA-Z0-9])/g, (_, __, c) => c.toUpperCase())
}

function lineOf(text, index) {
  return 1 + (text.slice(0, index).match(/\n/g) ?? []).length
}

function shortExpr(s) {
  const one = s.replace(/\s+/g, ' ')
  return one.length > 80 ? `${one.slice(0, 79)}…` : one
}
