/**
 * Vite 适配器：在 verify 的临时目录里给项目的 vite 配置套一层，追加一个只记录模块的插件
 *
 * 做法：原配置文件改名为 <名字>.code-audit-original<扩展名>，原位置写一个同名的包装配置：
 *   读原配置 → 原样返回，只在 plugins 末尾加上 code-audit:modules
 * 构建命令照常跑（npx vite build、包了一层的脚本都行），只要它读的是这个配置文件
 *
 * - 只改临时目录里的拷贝，目标项目不动
 * - 导出的形状不变：原来导出对象就还是对象，原来导出函数就还是函数，具名导出原样转出去
 *   （vitest.config 里 mergeConfig(viteConfig, …) 这种用法要求是对象）
 * - 插件只在 build 时生效（apply: 'build'），不改构建产物；dev、vitest 里不起作用
 * - 构建前会跑 lint、类型检查的项目，会检查到这个生成的文件：开头关掉 eslint 和 TS 检查。
 *   还是过不了的话，verify 会撤掉这一层重跑基线（baseline.js），只是没有打包器证据
 * - 每次构建写一个 JSON 文件到 outDir（一条命令里可能有多次构建）：构建里加载过的所有模块 id
 *   取 this.getModuleIds()（整个模块图，包括被 tree-shaking 摇空的模块：删了它照样会构建失败），
 *   再并上产物里各 chunk 的模块（老版本 rollup、rolldown 没有 getModuleIds 时兜底）
 */
import { existsSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

/** Vite 自己找配置文件的顺序 */
export const CONFIG_FILES = Object.freeze([
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts'
])

/** 改名后的原配置文件名里加的这一段 */
export const ORIGINAL_MARK = '.code-audit-original'

/**
 * @param {object} opts
 * @param {string} opts.dir      临时目录（代码在这里）
 * @param {string} opts.outDir   模块列表写到这个目录（要在 dir 外面，不能成为构建的输入）
 * @param {string|null} [opts.config] 配置文件，相对 dir；不传时按 Vite 的顺序找
 * @returns {{config: string, restore: () => void}} 套了一层的配置文件；restore 撤掉这一层，放回原配置
 */
export function instrument({ dir, outDir, config = null }) {
  const file = config ?? CONFIG_FILES.find((f) => existsSync(join(dir, f)))
  if (!file) throw new Error(`没有找到 vite 配置文件（${CONFIG_FILES.join('、')}）。配置文件在别处的话，在 verify.bundlerConfig 里写上`)
  const abs = join(dir, file)
  if (!existsSync(abs)) throw new Error(`verify.bundlerConfig 指定的 vite 配置文件不在提交里：${file}`)

  const ext = extname(file)
  const original = freeName(dirname(abs), basename(file, ext), ext)
  const moved = join(dirname(abs), original)
  renameSync(abs, moved)
  writeFileSync(abs, wrapper(`./${original}`, outDir, ext))
  return { config: file, restore: () => renameSync(moved, abs) }
}

/**
 * 原配置改名用的文件名：<名字>.code-audit-original<扩展名>，已经有这个文件（项目里本来就有）就加序号，
 * 不覆盖任何已有文件
 */
export function freeName(dir, name, ext) {
  for (let i = 1; ; i++) {
    const candidate = `${name}${ORIGINAL_MARK}${i === 1 ? '' : `-${i}`}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
}

/** 包装配置的源码：.cjs、.cts 用 CommonJS，其余用 ESM（Vite 会用 esbuild 打包配置，两种都认） */
export function wrapper(originalSpec, outDir, ext) {
  const plugin = `function codeAuditModules() {
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
      for (const out of Object.values(bundle)) {
        if (out.type !== 'chunk') continue
        for (const id of out.moduleIds ?? Object.keys(out.modules ?? {})) ids.add(id)
      }
      __codeAuditFs.mkdirSync(${JSON.stringify(outDir)}, { recursive: true })
      const name = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + '.json'
      __codeAuditFs.writeFileSync(__codeAuditPath.join(${JSON.stringify(outDir)}, name), JSON.stringify([...ids]))
    }
  }
}
function withModules(config) {
  if (!config || typeof config !== 'object') return config
  return { ...config, plugins: [...(config.plugins ?? []), codeAuditModules()] }
}
function wrap(original) {
  if (typeof original === 'function') {
    return function (...args) {
      const r = original.apply(this, args)
      return r && typeof r.then === 'function' ? r.then(withModules) : withModules(r)
    }
  }
  return original && typeof original.then === 'function' ? original.then(withModules) : withModules(original)
}`
  const header = '/* eslint-disable */\n// @ts-nocheck\n// code-audit verify 生成：套在原配置外面，只追加一个记录模块的插件，构建产物不变\n'
  if (ext === '.cjs' || ext === '.cts') {
    return `${header}const __codeAuditFs = require('node:fs')
const __codeAuditPath = require('node:path')
const __codeAuditOriginal = require(${JSON.stringify(originalSpec)})
${plugin}
const __codeAuditDefault = __codeAuditOriginal && __codeAuditOriginal.__esModule ? __codeAuditOriginal.default : __codeAuditOriginal
module.exports = __codeAuditOriginal && __codeAuditOriginal.__esModule
  ? { ...__codeAuditOriginal, default: wrap(__codeAuditDefault) }
  : wrap(__codeAuditDefault)
`
  }
  return `${header}import * as __codeAuditFs from 'node:fs'
import * as __codeAuditPath from 'node:path'
import __codeAuditOriginal from ${JSON.stringify(originalSpec)}
export * from ${JSON.stringify(originalSpec)}
${plugin}
export default wrap(__codeAuditOriginal)
`
}
