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
 * - 在各个 .vue 的模板里找标签（<BasicTable 或 <basic-table），记下哪个文件哪一行用了哪个组件
 * - 在临时目录的拷贝里，给用到标签的文件补上 import（插在 <script> 那一行，行号不变），knip 就能顺着真实的引用关系走：
 *   只被没人用的页面用到的组件，照样判为没人用
 *
 * 已知限制：只认声明文件里登记了的组件。全局注册了但没生成声明文件（dts: false）的，模板里的用法看不到
 */
import { posix } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveSpec } from './path-refs.js'

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
 * 模板里用到全局组件的地方
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {Map<string, string>} opts.components  组件名 → 文件
 * @returns {Map<string, {from: string, line: number}[]>} 组件文件 → 用到它的地方；自己用自己不算
 */
export function findTagUses({ files, components }) {
  const result = new Map()
  if (components.size === 0) return result
  const patterns = [...components].map(([name, file]) => ({
    file,
    re: new RegExp(`<(?:${escape(name)}|${escape(kebab(name))})(?=[\\s/>])`, 'g')
  }))
  for (const { path, content } of files) {
    if (!path.endsWith('.vue')) continue
    const template = templateOnly(content)
    for (const { file, re } of patterns) {
      if (file === path) continue
      for (const m of template.matchAll(re)) {
        const line = 1 + (template.slice(0, m.index).match(/\n/g) ?? []).length
        const refs = result.get(file) ?? []
        if (!refs.some((r) => r.from === path && r.line === line)) refs.push({ from: path, line })
        result.set(file, refs)
      }
    }
  }
  for (const refs of result.values()) refs.sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : a.line - b.line))
  return result
}

/**
 * 在临时目录的拷贝里，给用到标签的文件补上 import，让 knip 看到这条引用
 * 插在第一个 <script ...> 标签的同一行，行号不变；没有 <script> 的，在第一行前面补一个
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
    const m = content.match(/<script\b[^>]*>/)
    const next = m ? content.slice(0, m.index + m[0].length) + imports + content.slice(m.index + m[0].length) : `<script>${imports}</script>${content}`
    writeFileSync(p, next)
  }
}

/** 只留 <template> 部分：<script>、<style> 块换成同样多的空行，行号不变 */
export function templateOnly(content) {
  return content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ''))
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
