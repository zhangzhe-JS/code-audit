/**
 * 各打包器适配器共用：在临时目录里给配置文件套一层
 *
 * 原配置改名为 <名字>.code-audit-original<扩展名>，原位置写同名的包装配置。包装配置只有几行：
 * 读原配置 → 环境变量 CODE_AUDIT_PRELOAD 指着记录逻辑（preload.cjs，只有基线构建时带上）就 require 进来套上，没有就原样返回。
 * 不按路径引辅助文件、不带任何注释、不用顶层 await，项目构建前的 lint 和类型检查都检查得过去；
 * 写完再用项目自己的 eslint --fix 一遍（有的话），引号、分号、空行等风格跟项目一致
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 改名后的原配置文件名里加的这一段 */
export const ORIGINAL_MARK = '.code-audit-original'

/** 记录逻辑：基线构建时预加载 */
export const PRELOAD = fileURLToPath(new URL('./preload.cjs', import.meta.url))

/** 包装配置的写法版本：基线缓存里记下，上次因为套了配置构建失败而撤掉的，换了写法要重试 */
export const WRAPPER_VERSION = 2

/**
 * 基线构建要带上的环境变量：记录逻辑在哪（包装配置按它 require 进来）、记录写到哪里。
 * 不用 NODE_OPTIONS：有的项目的构建脚本会整个改写它（如只留 --max-old-space-size），普通环境变量一般原样传下去
 * @param {string} outDir
 */
export function bundlerEnv(outDir) {
  return { CODE_AUDIT_PRELOAD: PRELOAD, CODE_AUDIT_BUNDLER_OUT: outDir }
}

/**
 * 原配置改名用的文件名：<名字>.code-audit-original<扩展名>，已经有这个文件（项目里本来就有）就加序号，不覆盖任何已有文件
 */
export function freeName(dir, name, ext) {
  for (let i = 1; ; i++) {
    const candidate = `${name}${ORIGINAL_MARK}${i === 1 ? '' : `-${i}`}${ext}`
    if (!existsSync(join(dir, candidate))) return candidate
  }
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
 * 改名 + 写包装配置
 * @param {object} opts
 * @param {string} opts.dir      临时目录
 * @param {string|null} opts.config  指定的配置文件（相对 dir）
 * @param {string|undefined} opts.found  按打包器自己的规则找到的
 * @param {string} opts.missing  都没有时的报错
 * @param {'vite'|'webpack'|'vueCli'} opts.kind
 * @param {boolean} [opts.esm]  不传时按 isEsm 判断
 * @returns {{config: string, restore: () => void}}
 */
export function wrapConfigFile({ dir, config, found, missing, kind, esm = null }) {
  const file = config ?? found
  if (!file) throw new Error(missing)
  const abs = join(dir, file)
  if (!existsSync(abs)) throw new Error(`verify.bundlerConfig 指定的配置文件不在提交里：${file}`)
  const ext = extname(file)
  const original = freeName(dirname(abs), basename(file, ext), ext)
  const moved = join(dirname(abs), original)
  const asEsm = esm ?? isEsm(abs, dir)
  renameSync(abs, moved)
  // .ts 写成不带扩展名：带 .ts 的导入类型检查不认（allowImportingTsExtensions），打包器、ts-node 不带扩展名都找得到
  const spec = `./${ext === '.ts' ? basename(original, ext) : original}`
  writeFileSync(abs, wrapperSource(spec, kind, asEsm))
  lintFix(dir, abs)
  return { config: file, restore: () => renameSync(moved, abs) }
}

/** 包装配置的源码 */
export function wrapperSource(spec, kind, esm) {
  const s = /['\\\n]/.test(spec) ? JSON.stringify(spec) : `'${spec}'`
  // 不直接写 process：有的 lint 规则要求 import process，有的要求用全局的
  const preload = "const preload = Reflect.get(globalThis, 'process').env.CODE_AUDIT_PRELOAD"
  if (esm) {
    return `import { createRequire } from 'node:module'\nimport config from ${s}\n\nexport * from ${s}\n\n${preload}\nconst bundler = preload ? createRequire(preload)(preload) : undefined\n\nexport default bundler ? bundler.${kind}(config) : config\n`
  }
  return `const config = require(${s})\n\n${preload}\nconst bundler = preload ? require(preload) : undefined\n\nmodule.exports = bundler ? bundler.${kind}(config) : config\n`
}

/**
 * 用项目自己的 eslint 修一遍包装配置的格式（从配置文件所在目录往上找 node_modules/.bin/eslint，不出临时目录）。
 * 没有 eslint、修不了、出错都不管：只是让格式贴近项目风格，过不了 lint 时 verify 会撤掉重跑
 */
export function lintFix(root, abs, run = spawnSync) {
  for (let d = dirname(abs); ; d = dirname(d)) {
    const bin = join(d, 'node_modules', '.bin', process.platform === 'win32' ? 'eslint.cmd' : 'eslint')
    if (existsSync(bin)) {
      try {
        run(bin, ['--fix', relative(d, abs).split(sep).join('/')], { cwd: d, stdio: 'ignore', timeout: 120000 })
      } catch {
        // 不管
      }
      return bin
    }
    if (d === root || dirname(d) === d || !d.startsWith(root)) return null
  }
}
