/**
 * 自动导入（unplugin-auto-import 等）：不写 import 就能直接用的函数
 *
 * 插件会生成声明文件（常见名字 auto-imports.d.ts）：
 *   declare global {
 *     const useTable: typeof import('./composables/useTable')['useTable']
 *     const ref: typeof import('vue')['ref']
 *   }
 * 和全局组件一样有两个问题：tsconfig 把它列为源文件时，knip 把 typeof import 当成引用（登记过的一律算在用）；
 * 代码里直接写 useTable() 的用法 knip 看不到。
 *
 * 做法：
 * - 读出声明文件里登记的本地函数（第三方库的不管），scan 的临时目录里不放有本地登记的声明文件
 * - 在代码和模板表达式里按名字找用法，补成 import 交给 knip（和全局组件一样，见 global-components.js 的 injectImports）
 * - 兜底：项目装了自动导入的插件，却一个声明文件都没找到（关掉了 dts）时，看不出哪些函数是自动导入的。
 *   候选文件导出的名字，在用的代码里被直接用到、那个文件又没 import 这个名字，就判 unknown
 *
 * 按名字找用法是模糊的（局部变量同名也算），只会多算「在用」，不会误删
 */
import { posix } from 'node:path'
import { codeOf } from './source-text.js'
import { resolveSpec } from './path-refs.js'
import { templateOnly } from './global-components.js'

// const 全局名: typeof import('路径')['导出名']：全局名可以和导出名不同（imports: [{ '@/x': [['ProxyMessage', 'ElMessage']] }]）
const ENTRY = /\b(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)\s*:\s*\(?\s*typeof\s+import\(\s*(['"])([^'"]+)\2\s*\)(?:\s*\[\s*(['"])([^'"]+)\4\s*\])?/g

/**
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {Set<string>} opts.sourceSet
 * @param {string[]} opts.extensions
 * @param {Record<string, string>} [opts.aliases]
 * @returns {{found: boolean, declarations: string[], names: Map<string, string>, exports: Map<string, string>}}
 *   found：有没有自动导入的声明文件（不管登记的是不是本地的）；declarations：登记了本地函数的声明文件；names：全局名 → 文件；
 *   exports：全局名 → 文件里的导出名（没写 ['名字'] 的是整个模块，记 '*'）
 */
export function findAutoImports({ files, sourceSet, extensions, aliases = {} }) {
  let found = false
  const declarations = []
  const names = new Map()
  const exports = new Map()
  for (const { path, content } of files) {
    if (!path.endsWith('.d.ts') || !/\bdeclare\s+global\b/.test(content) || !/typeof\s+import\(/.test(content)) continue
    found = true
    let local = 0
    for (const m of content.matchAll(ENTRY)) {
      const file = toFile(resolveSpec(m[3], path, aliases), sourceSet, extensions)
      if (file) {
        names.set(m[1], file)
        exports.set(m[1], m[5] ?? '*')
        local++
      }
    }
    if (local > 0) declarations.push(path)
  }
  return { found, declarations, names, exports }
}

/**
 * 自动导入里按名字被用到的导出：'文件#导出名'（整个模块被登记的是 '文件#*'）
 * 按全局名逐个找：同一个文件登记了好几个名字，用到一个不代表都用到了
 * @param {{names: Map<string, string>, exports: Map<string, string>}} autos  findAutoImports 的结果
 * @param {{path: string, content: string}[]} files  在用的文件
 */
export function usedAutoExports(autos, files) {
  const used = new Set()
  for (const [name, file] of autos.names) {
    const uses = findNameUses({ files, names: new Map([[name, file]]) })
    if ((uses.get(file) ?? []).length > 0) used.add(`${file}#${autos.exports?.get(name) ?? '*'}`)
  }
  return used
}

/** 自动导入登记的全局名：'文件#导出名' → 全局名（可能有几个） */
export function autoNamesOf(autos) {
  const out = new Map()
  for (const [name, file] of autos.names) {
    const key = `${file}#${autos.exports?.get(name) ?? '*'}`
    out.set(key, [...(out.get(key) ?? []), name])
  }
  return out
}

/**
 * 按名字找用法：代码里（去掉注释）、.vue 的模板表达式里
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files
 * @param {Map<string, string>} opts.names  名字 → 文件
 * @param {Set<string>} [opts.skip]  不找的文件（声明文件）
 * @returns {Map<string, {from: string, line: number}[]>} 文件 → 用到它的地方
 */
export function findNameUses({ files, names, skip = new Set() }) {
  const result = new Map()
  if (names.size === 0) return result
  const patterns = [...names].map(([name, file]) => ({ file, re: new RegExp(`(?<![.\\w$])${escape(name)}(?![\\w$])`, 'g') }))
  for (const { path, content } of files) {
    if (skip.has(path)) continue
    const texts = [codeOf(path, content)]
    if (path.endsWith('.vue')) texts.push(templateOnly(content))
    for (const { file, re } of patterns) {
      if (file === path) continue
      for (const text of texts) {
        for (const m of text.matchAll(re)) {
          const line = 1 + (text.slice(0, m.index).match(/\n/g) ?? []).length
          const refs = result.get(file) ?? []
          if (!refs.some((r) => r.from === path && r.line === line)) refs.push({ from: path, line })
          result.set(file, refs)
        }
      }
    }
  }
  return result
}

/**
 * 兜底：候选文件导出的名字，在用的代码里被直接用到、又没 import
 * @param {object} opts
 * @param {{path: string, content: string}[]} opts.files  在用的文件
 * @param {{path: string, content: string}[]} opts.targets  候选 js / ts 文件
 * @returns {Map<string, {from: string, line: number, name: string}[]>}
 */
export function findBareExportUses({ files, targets }) {
  const result = new Map()
  for (const t of targets) {
    const exported = exportNames(codeOf(t.path, t.content))
    if (exported.length === 0) continue
    for (const { path, content } of files) {
      if (path === t.path) continue
      const code = codeOf(path, content)
      const texts = path.endsWith('.vue') ? [code, templateOnly(content)] : [code]
      for (const name of exported) {
        if (new RegExp(`\\bimport\\b[^;\\n]*\\b${escape(name)}\\b`).test(code)) continue // 自己 import 了
        if (new RegExp(`\\b(?:const|let|var|function|class)\\s+${escape(name)}\\b`).test(code)) continue // 自己定义了
        const re = new RegExp(`(?<![.\\w$])${escape(name)}(?![\\w$])`, 'g')
        for (const text of texts) {
          for (const m of text.matchAll(re)) {
            const line = 1 + (text.slice(0, m.index).match(/\n/g) ?? []).length
            const refs = result.get(t.path) ?? []
            if (!refs.some((r) => r.from === path && r.line === line)) refs.push({ from: path, line, name })
            result.set(t.path, refs)
          }
        }
      }
    }
  }
  return result
}

/** 文件导出的名字（export const / function / class，export { a, b as c }） */
export function exportNames(code) {
  const names = new Set()
  for (const m of code.matchAll(/\bexport\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/\s+as\s+/).at(-1)?.trim()
      if (name && name !== 'default' && /^[A-Za-z_$][\w$]*$/.test(name)) names.add(name)
    }
  }
  return [...names]
}

/** 路径换成提交里的源码文件：原样、补扩展名、目录下的 index */
function toFile(resolved, sourceSet, extensions) {
  if (resolved === null) return null
  if (sourceSet.has(resolved)) return resolved
  for (const e of extensions) if (sourceSet.has(resolved + e)) return resolved + e
  for (const e of extensions) if (sourceSet.has(posix.join(resolved, `index${e}`))) return posix.join(resolved, `index${e}`)
  return null
}

function escape(s) {
  return s.replace(/[.*+?^${}()|[\]\\$]/g, '\\$&')
}
