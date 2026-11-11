/**
 * webpack 适配器：在 verify 的临时目录里给项目的 webpack 配置套一层，追加一个只记录模块的插件
 *
 * 做法和 vite 适配器一样：原配置改名为 <名字>.code-audit-original<扩展名>，原位置写同名的包装配置，
 * 读原配置 → 原样返回，只在 plugins 末尾加上记录插件。构建命令照常跑（webpack-cli、自己写的 build 脚本都行），
 * 只要它读的是这个配置文件：老项目常见的 build/webpack.prod.conf.js 由 build.js require 进来，
 * 在 verify.bundlerConfig 里写上这个文件就行
 *
 * - 导出的各种写法都认：对象、数组（多个配置）、函数 (env, argv) => 配置、Promise，以及它们的组合
 * - 包装配置用什么模块格式跟原文件一致：.cjs/.cts 用 CommonJS，.mjs/.mts 用 ESM，
 *   .js/.ts 看最近的 package.json 的 type（"module" 用 ESM，否则 CommonJS）
 * - 插件在 done 时写记录（每个编译器一份；构建有错误时不写），webpack 3/4/5 都能用
 *   ids：compilation.modules 里的源码模块，合并模块（ConcatenatedModule）展开成里面的各个模块
 *   exports：tree-shaking 的结论。webpack 5 看 moduleGraph 里各导出的使用状态，webpack 3/4 看 usedExports；
 *   开发模式等没算使用情况的不记（只有算过的才拿来用）
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { freeName } from './vite.js'

/** webpack-cli 自己找配置文件的顺序（常用的扩展名） */
export const CONFIG_FILES = Object.freeze(
  ['webpack.config', '.webpack/webpack.config', '.webpack/webpackfile'].flatMap((n) => ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].map((e) => n + e))
)

/**
 * @param {object} opts
 * @param {string} opts.dir      临时目录
 * @param {string} opts.outDir   记录写到这里（在 dir 外面）
 * @param {string|null} [opts.config] 配置文件，相对 dir；不传时按 webpack-cli 的顺序找
 * @returns {{config: string, restore: () => void}}
 */
export function instrument({ dir, outDir, config = null }) {
  return wrapConfigFile({
    dir,
    config,
    found: CONFIG_FILES.find((f) => existsSync(join(dir, f))),
    missing: `没有找到 webpack 配置文件（${CONFIG_FILES.slice(0, 6).join('、')} 等）。配置文件在别处（如 build/webpack.prod.conf.js）的话，在 verify.bundlerConfig 里写上`,
    source: (originalSpec, esm) => wrapper(originalSpec, outDir, esm)
  })
}

/**
 * 改名 + 写包装配置（webpack、vue-cli 共用）
 * @returns {{config: string, restore: () => void}}
 */
export function wrapConfigFile({ dir, config, found, missing, source }) {
  const file = config ?? found
  if (!file) throw new Error(missing)
  const abs = join(dir, file)
  if (!existsSync(abs)) throw new Error(`verify.bundlerConfig 指定的配置文件不在提交里：${file}`)
  const ext = extname(file)
  const original = freeName(dirname(abs), basename(file, ext), ext)
  const moved = join(dirname(abs), original)
  const esm = isEsm(abs, dir)
  renameSync(abs, moved)
  writeFileSync(abs, source(`./${original}`, esm))
  return { config: file, restore: () => renameSync(moved, abs) }
}

/** 配置文件按 ESM 还是 CommonJS 加载：看扩展名，.js/.ts 再看最近的 package.json（不出临时目录） */
export function isEsm(abs, root) {
  const ext = extname(abs)
  if (ext === '.mjs' || ext === '.mts') return true
  if (ext === '.cjs' || ext === '.cts') return false
  for (let d = dirname(abs); ; d = dirname(d)) {
    const pkg = join(d, 'package.json')
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, 'utf8')).type === 'module'
      } catch {
        return false // package.json 坏了：node 自己也会按 CommonJS 处理（或者报错）
      }
    }
    if (d === root || dirname(d) === d) return false
  }
}

/**
 * 记录插件的源码（一个类，webpack 3/4/5 通用）；放进包装配置里，用到 __codeAuditFs、__codeAuditPath
 * @param {string} outDir
 */
export function pluginSource(outDir) {
  return `class CodeAuditModules {
  apply(compiler) {
    const done = (stats) => {
      if (stats.hasErrors && stats.hasErrors()) return
      const c = stats.compilation
      const seen = new Set()
      const ids = new Set()
      const exports = {}
      const mg = c.moduleGraph
      const put = (id, name, used) => {
        const e = exports[id] || (exports[id] = { rendered: [], removed: [] })
        ;(used ? e.rendered : e.removed).push(name)
      }
      const visit = (m) => {
        if (!m || seen.has(m)) return
        seen.add(m)
        if (m.modules) for (const x of m.modules) visit(x) // 合并模块：展开成里面的各个模块
        const id = m.resource
        if (typeof id !== 'string') return
        ids.add(id)
        if (mg && typeof mg.getExportsInfo === 'function') {
          // webpack 5：Unused 0 / OnlyPropertiesUsed 1 / NoInfo 2 / Unknown 3 / Used 4；NoInfo 是没算（开发模式等），不记
          for (const e of mg.getExportsInfo(m).orderedExports) {
            if (e.provided !== true || typeof e.getUsed !== 'function') continue
            const u = e.getUsed(undefined)
            if (u !== 2) put(id, e.name, u !== 0)
          }
          return
        }
        // webpack 3/4：usedExports 是数组（用到的名字）/ true（都用到）/ false（都没用到）/ null（没算）
        const provided = m.buildMeta ? m.buildMeta.providedExports : m.providedExports
        const used = m.usedExports
        if (!Array.isArray(provided) || used === null || used === undefined) return
        for (const n of provided) put(id, n, used === true || (Array.isArray(used) && used.includes(n)))
      }
      for (const m of c.modules) visit(m)
      __codeAuditFs.mkdirSync(${JSON.stringify(outDir)}, { recursive: true })
      const name = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json'
      __codeAuditFs.writeFileSync(__codeAuditPath.join(${JSON.stringify(outDir)}, name), JSON.stringify({ ids: [...ids], exports }))
    }
    if (compiler.hooks && compiler.hooks.done) compiler.hooks.done.tap('code-audit:modules', done)
    else compiler.plugin('done', done) // webpack 3
  }
}`
}

/** 包装配置的源码 */
export function wrapper(originalSpec, outDir, esm) {
  const body = `${pluginSource(outDir)}
function withModules(config) {
  if (Array.isArray(config)) return config.map(wrap)
  if (!config || typeof config !== 'object') return config
  return { ...config, plugins: [...(config.plugins || []), new CodeAuditModules()] }
}
function wrap(original) {
  if (typeof original === 'function') {
    return function (...args) {
      return wrap(original.apply(this, args))
    }
  }
  return original && typeof original.then === 'function' ? original.then(wrap) : withModules(original)
}`
  return moduleSource(originalSpec, body, esm)
}

/** 读原配置、把 wrap(原导出) 作为默认导出；ESM 原样转出具名导出，CommonJS 保留 __esModule 的形状 */
export function moduleSource(originalSpec, body, esm) {
  const header = '/* eslint-disable */\n// @ts-nocheck\n// code-audit verify 生成：套在原配置外面，只追加一个记录模块的插件，构建产物不变\n'
  if (!esm) {
    return `${header}const __codeAuditFs = require('fs')
const __codeAuditPath = require('path')
const __codeAuditOriginal = require(${JSON.stringify(originalSpec)})
${body}
module.exports = __codeAuditOriginal && __codeAuditOriginal.__esModule
  ? Object.defineProperty({ ...__codeAuditOriginal, default: wrap(__codeAuditOriginal.default) }, '__esModule', { value: true })
  : wrap(__codeAuditOriginal)
`
  }
  return `${header}import * as __codeAuditFs from 'fs'
import * as __codeAuditPath from 'path'
import __codeAuditOriginal from ${JSON.stringify(originalSpec)}
export * from ${JSON.stringify(originalSpec)}
${body}
export default wrap(__codeAuditOriginal)
`
}
