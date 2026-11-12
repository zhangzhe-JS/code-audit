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
 * - 记录插件在 preload.cjs 里（基线构建时按环境变量 require 进来），包装配置不带注释、不按路径引辅助文件；
 *   插件在 done 时写记录（每个编译器一份；构建有错误时不写），webpack 3/4/5 都能用
 *   ids：compilation.modules 里的源码模块，合并模块（ConcatenatedModule）展开成里面的各个模块
 *   exports：tree-shaking 的结论。webpack 5 看 moduleGraph 里各导出的使用状态，webpack 3/4 看 usedExports；
 *   开发模式等没算使用情况的不记（只有算过的才拿来用）
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isEsm, wrapConfigFile } from './wrap.js'

export { isEsm, wrapConfigFile }

/** webpack-cli 自己找配置文件的顺序（常用的扩展名） */
export const CONFIG_FILES = Object.freeze(
  ['webpack.config', '.webpack/webpack.config', '.webpack/webpackfile'].flatMap((n) => ['.js', '.mjs', '.cjs', '.ts', '.mts', '.cts'].map((e) => n + e))
)

/**
 * @param {object} opts
 * @param {string} opts.dir      临时目录
 * @param {string|null} [opts.config] 配置文件，相对 dir；不传时按 webpack-cli 的顺序找
 * @returns {{config: string, restore: () => void}}
 */
export function instrument({ dir, config = null }) {
  return wrapConfigFile({
    dir,
    config,
    found: CONFIG_FILES.find((f) => existsSync(join(dir, f))),
    missing: `没有找到 webpack 配置文件（${CONFIG_FILES.slice(0, 6).join('、')} 等）。配置文件在别处（如 build/webpack.prod.conf.js）的话，在 verify.bundlerConfig 里写上`,
    kind: 'webpack'
  })
}
