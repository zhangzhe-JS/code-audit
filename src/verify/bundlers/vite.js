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
 * - 包装配置只有几行、不带注释，记录逻辑在 preload.cjs 里（基线构建时按环境变量 require 进来），再用项目自己的 eslint --fix 一遍：
 *   构建前会跑 lint、类型检查的项目也过得去。还是过不了的话，verify 会撤掉这一层重跑基线（baseline.js），只是没有打包器证据
 * - 每次构建写一个 JSON 文件到 outDir（一条命令里可能有多次构建）：{ ids, exports }
 *   ids：构建里加载过的所有模块 id，取 this.getModuleIds()（整个模块图，包括被 tree-shaking 摇空的模块：删了它照样会构建失败），
 *   再并上产物里各 chunk 的模块（老版本 rollup、rolldown 没有 getModuleIds 时兜底）
 *   exports：产物里各模块 tree-shaking 后保留 / 摇掉的导出（Rollup 的 renderedExports / removedExports），导出维度用
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ORIGINAL_MARK, freeName, wrapConfigFile } from './wrap.js'

export { ORIGINAL_MARK, freeName }

/** Vite 自己找配置文件的顺序 */
export const CONFIG_FILES = Object.freeze([
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
  'vite.config.cjs',
  'vite.config.mts',
  'vite.config.cts'
])

/**
 * @param {object} opts
 * @param {string} opts.dir      临时目录（代码在这里）
 * @param {string} [opts.outDir] 不用了（记录目录由基线构建的环境变量带上），留着兼容
 * @param {string|null} [opts.config] 配置文件，相对 dir；不传时按 Vite 的顺序找
 * @returns {{config: string, restore: () => void}} 套了一层的配置文件；restore 撤掉这一层，放回原配置
 */
export function instrument({ dir, config = null }) {
  const found = CONFIG_FILES.find((f) => existsSync(join(dir, f)))
  return wrapConfigFile({
    dir,
    config,
    found,
    missing: `没有找到 vite 配置文件（${CONFIG_FILES.join('、')}）。配置文件在别处的话，在 verify.bundlerConfig 里写上`,
    kind: 'vite',
    // Vite 用 esbuild 打包配置：.cjs、.cts 是 CommonJS，其余都按 ESM 写（不看 package.json 的 type）
    esm: !/\.c[jt]s$/.test(config ?? found ?? '')
  })
}
