/**
 * Vue CLI 适配器（@vue/cli-service，底层是 webpack）：给 vue.config.js 套一层，
 * 在 chainWebpack 里追加 webpack 适配器的记录插件（原来的 chainWebpack 先照常跑）
 *
 * - vue.config 导出对象、函数、Promise 都认
 * - 配置写在 package.json 的 "vue" 字段里时套不上：在仓库里加一个 vue.config.js 再用，或者不启用打包器证据
 * - `vue-cli-service build --modern` 等一条命令构建多次的，每次构建一份记录
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { moduleSource, pluginSource, wrapConfigFile } from './webpack.js'

export const CONFIG_FILES = Object.freeze(['vue.config.js', 'vue.config.cjs', 'vue.config.mjs'])

export function instrument({ dir, outDir, config = null }) {
  return wrapConfigFile({
    dir,
    config,
    found: CONFIG_FILES.find((f) => existsSync(join(dir, f))),
    missing: `没有找到 Vue CLI 配置文件（${CONFIG_FILES.join('、')}）。写在 package.json 的 "vue" 字段里的套不上；配置文件在别处的话，在 verify.bundlerConfig 里写上`,
    source: (originalSpec, esm) => wrapper(originalSpec, outDir, esm)
  })
}

export function wrapper(originalSpec, outDir, esm) {
  const body = `${pluginSource(outDir)}
function withModules(options) {
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
