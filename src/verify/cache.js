/**
 * 基线缓存：同一个提交、同样的命令、同样的依赖，基线结果是一样的，重跑 verify 时直接复用
 *
 * verify 通过时一般是「基线 + 1 轮」，复用基线能省一半时间
 *
 * 缓存键（任何一项变了都重跑）：
 * - 完整提交号：代码、锁文件都在提交里
 * - verify 的命令、超时、打包器设置
 * - 依赖的状态：各 node_modules 里包管理器写的记录文件（pnpm、npm、yarn）的大小和修改时间。
 *   原项目重新装过依赖，这些文件会变
 * - Node 版本、系统、工具版本
 * 不在键里的：环境变量。构建受环境变量影响的话，加 --fresh 重跑
 *
 * 存在用户的缓存目录（不在目标仓库里）：$CODE_AUDIT_CACHE_DIR，或 $XDG_CACHE_HOME/code-audit，或 ~/.cache/code-audit
 * 只缓存构建成功的基线：失败的基线 verify 不能用
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { TOOL } from '../core/tool.js'

/** 缓存格式的版本：结构变了就改，旧缓存自动作废 */
const FORMAT = 2
/** 超过这么多天没用的缓存，写新缓存时顺手删掉 */
const PRUNE_DAYS = 30

/** 包管理器装完依赖后写的记录文件 */
const DEPS_MARKERS = Object.freeze(['.modules.yaml', '.package-lock.json', '.yarn-state.yml', '.yarn-integrity'])

export function cacheDir(env = process.env) {
  if (env.CODE_AUDIT_CACHE_DIR) {
    if (!isAbsolute(env.CODE_AUDIT_CACHE_DIR)) throw new Error('CODE_AUDIT_CACHE_DIR 必须是绝对路径，避免缓存写进被分析仓库')
    return join(env.CODE_AUDIT_CACHE_DIR, 'baseline')
  }
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache')
  return join(base, 'code-audit', 'baseline')
}

/**
 * 依赖的状态：各 node_modules 里记录文件的大小和修改时间，没有记录文件时用 node_modules 目录本身
 * @param {string} root 仓库目录
 * @param {{dir: string}[]} deps 临时目录克隆了哪些 node_modules（Workspace.deps）
 */
export function depsFingerprint(root, deps) {
  return deps.map(({ dir }) => {
    const nm = join(root, dir, 'node_modules')
    const marks = DEPS_MARKERS.map((m) => join(nm, m)).filter((p) => existsSync(p))
    const stamp = (p) => {
      const s = statSync(p)
      return `${s.size}:${Math.round(s.mtimeMs)}`
    }
    return `${dir || '.'}=${marks.length > 0 ? marks.map((p) => `${p.slice(nm.length + 1)}@${stamp(p)}`).join(',') : `dir@${existsSync(nm) ? stamp(nm) : 'none'}`}`
  })
}

/**
 * @param {object} opts
 * @param {string} opts.commit 完整提交号
 * @param {Readonly<import('../core/config.js').VerifyConfig>} opts.verify
 * @param {string[]} opts.deps depsFingerprint 的结果
 */
export function baselineKey({ commit, verify, deps }) {
  const parts = {
    format: FORMAT,
    tool: TOOL.version,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    commit,
    verify: Object.fromEntries(Object.keys(verify).sort().map((k) => [k, verify[k]])),
    deps
  }
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 32)
}

/**
 * @typedef {object} CachedBaseline
 * @property {Record<string, import('./run-command.js').CommandResult>} results
 * @property {string[]|null} modules 打包器加载过的源码文件；没启用打包器证据时为 null
 * @property {number} builds   记录了几次构建
 * @property {string|null} [bundlerDropped] 套了打包器配置后构建失败、撤掉了：原因
 * @property {string} createdAt ISO 时间
 */

/** @returns {CachedBaseline|null} */
export function readBaseline(key, dir = cacheDir()) {
  const file = join(dir, `${key}.json`)
  if (!existsSync(file)) return null
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (data.format !== FORMAT || !data.results) return null
    // 更新修改时间：常用的不会被清理掉
    const now = new Date()
    utimesSync(file, now, now)
    return data
  } catch {
    return null // 写了一半、格式坏了：当没有缓存
  }
}

/** @param {Omit<CachedBaseline, 'createdAt'>} value */
export function writeBaseline(key, value, dir = cacheDir()) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, `${key}.json`)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ format: FORMAT, createdAt: new Date().toISOString(), ...value }))
  renameSync(tmp, file) // 先写临时文件再改名：并发跑也不会读到写了一半的
  prune(dir)
  return file
}

function prune(dir) {
  const limit = Date.now() - PRUNE_DAYS * 86400000
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    try {
      if (statSync(p).mtimeMs < limit) rmSync(p, { force: true })
    } catch {
      // 别的进程刚删掉
    }
  }
}

/** 多久以前，给人看 */
export function age(iso, now = Date.now()) {
  const mins = Math.max(0, Math.round((now - Date.parse(iso)) / 60000))
  if (mins < 60) return `${mins} 分钟前`
  if (mins < 60 * 24) return `${Math.round(mins / 60)} 小时前`
  return `${Math.round(mins / 1440)} 天前`
}
