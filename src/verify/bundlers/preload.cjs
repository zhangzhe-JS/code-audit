'use strict'
/**
 * 打包器证据的记录逻辑。verify 跑基线构建时把这个文件的路径放进环境变量 CODE_AUDIT_PRELOAD，
 * 临时目录里生成的包装配置按它 require 进来（wrap.js 的 wrapperSource）：
 *   const preload = Reflect.get(globalThis, 'process').env.CODE_AUDIT_PRELOAD
 *   const bundler = preload ? createRequire(preload)(preload) : undefined
 *   export default bundler ? bundler.vite(config) : config
 * 包装配置不带注释、不按路径引辅助文件，项目构建前的 lint（禁止整文件 eslint-disable、禁止 import *、禁止按路径引 node_modules 等）、
 * 类型检查都过得去；没有这个环境变量时（删文件的各轮、开发模式）原样返回原配置，构建产物和不套时一样
 *
 * 记录写到环境变量 CODE_AUDIT_BUNDLER_OUT 指定的目录，每次构建一个 JSON：{ ids, exports }（格式见 index.js）
 */
const fs = require('node:fs')
const path = require('node:path')

function save(record) {
  const outDir = process.env.CODE_AUDIT_BUNDLER_OUT
  if (!outDir) return
  fs.mkdirSync(outDir, { recursive: true })
  const name = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  fs.writeFileSync(path.join(outDir, name), JSON.stringify(record))
}

const isPromise = (x) => x && typeof x.then === 'function'

/** 导出函数的，套在返回值上；返回 Promise 的等它；其余直接套 */
function shape(original, apply) {
  if (typeof original === 'function') {
    return function (...args) {
      return shape(original.apply(this, args), apply)
    }
  }
  return isPromise(original) ? original.then((x) => shape(x, apply)) : apply(original)
}

/** 编译出来的 CommonJS（__esModule，不可枚举）：套 default，标记不能丢 */
function keepEsModule(original, wrap) {
  if (original && original.__esModule) return Object.defineProperty({ ...original, default: wrap(original.default) }, '__esModule', { value: true })
  return wrap(original)
}

// ---------- Vite ----------

/**
 * ids：this.getModuleIds()（整个模块图，包括被 tree-shaking 摇空的模块），再并上产物里各 chunk 的模块（老版本 rollup、rolldown 兜底）
 * exports：产物里各模块保留 / 摇掉的导出（renderedExports / removedExports）
 */
function viteModules() {
  const ids = new Set()
  return {
    name: 'code-audit:modules',
    apply: 'build',
    enforce: 'post',
    buildEnd(error) {
      if (error || typeof this.getModuleIds !== 'function') return
      for (const id of this.getModuleIds()) ids.add(id)
    },
    generateBundle(_options, bundle) {
      const exports = {}
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue
        for (const id of out.moduleIds ?? Object.keys(out.modules ?? {})) ids.add(id)
        for (const [id, m] of Object.entries(out.modules ?? {})) {
          if (!m || !Array.isArray(m.renderedExports)) continue
          const e = exports[id] ?? (exports[id] = { rendered: [], removed: [] })
          e.rendered.push(...m.renderedExports)
          e.removed.push(...(m.removedExports ?? []))
        }
      }
      save({ ids: [...ids], exports })
    }
  }
}

// Vite：只在第一层套，返回的不是对象（数组等）不动
const vite = (original) => keepEsModule(original, (c) => {
  if (typeof c === 'function') {
    return function (...args) {
      const r = c.apply(this, args)
      return isPromise(r) ? r.then(withVite) : withVite(r)
    }
  }
  return isPromise(c) ? c.then(withVite) : withVite(c)
})

function withVite(config) {
  if (!config || typeof config !== 'object') return config
  return { ...config, plugins: [...(config.plugins ?? []), viteModules()] }
}

// ---------- webpack（3/4/5） ----------

/**
 * done 时写记录（每个编译器一份；构建有错误时不写）
 * ids：compilation.modules 里的源码模块，合并模块（ConcatenatedModule）展开
 * exports：webpack 5 看 moduleGraph 里各导出的使用状态（Unused 0 / OnlyPropertiesUsed 1 / NoInfo 2 / Unknown 3 / Used 4，NoInfo 不记），
 *   webpack 3/4 看 usedExports（数组 / true / false / null 没算）
 */
class CodeAuditModules {
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
        if (m.modules) for (const x of m.modules) visit(x)
        const id = m.resource
        if (typeof id !== 'string') return
        ids.add(id)
        if (mg && typeof mg.getExportsInfo === 'function') {
          for (const e of mg.getExportsInfo(m).orderedExports) {
            if (e.provided !== true || typeof e.getUsed !== 'function') continue
            const u = e.getUsed(undefined)
            if (u !== 2) put(id, e.name, u !== 0)
          }
          return
        }
        const provided = m.buildMeta ? m.buildMeta.providedExports : m.providedExports
        const used = m.usedExports
        if (!Array.isArray(provided) || used === null || used === undefined) return
        for (const n of provided) put(id, n, used === true || (Array.isArray(used) && used.includes(n)))
      }
      for (const m of c.modules) visit(m)
      save({ ids: [...ids], exports })
    }
    if (compiler.hooks && compiler.hooks.done) compiler.hooks.done.tap('code-audit:modules', done)
    else compiler.plugin('done', done) // webpack 3
  }
}

function withWebpack(config) {
  if (Array.isArray(config)) return config.map((c) => shape(c, withWebpack))
  if (!config || typeof config !== 'object') return config
  return { ...config, plugins: [...(config.plugins || []), new CodeAuditModules()] }
}

const webpack = (original) => keepEsModule(original, (c) => shape(c, withWebpack))

// ---------- Vue CLI：在 chainWebpack 里追加（原来的 chainWebpack 先照常跑） ----------

function withVueCli(options) {
  if (!options || typeof options !== 'object') return options
  const chain = options.chainWebpack
  return {
    ...options,
    chainWebpack(config) {
      const r = typeof chain === 'function' ? chain.call(this, config) : undefined
      config.plugin('code-audit-modules').use(CodeAuditModules)
      return r
    }
  }
}

const vueCli = (original) => keepEsModule(original, (c) => shape(c, withVueCli))

module.exports = { vite, webpack, vueCli, CodeAuditModules }
