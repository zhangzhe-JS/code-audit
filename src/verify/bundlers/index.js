/**
 * 打包器证据：verify 跑基线构建时，顺便拿到打包器实际加载过的模块
 *
 * 用法只有一个方向：静态分析判死、打包器却加载了它 → 不删，判 unknown。
 * 出现在模块图里，说明从构建入口真能走到它（glob、插件、别名都按真实构建的规则算），这是很强的「在用」证据。
 * 反过来，模块图里没有不能证明没人用：测试、脚本、别的构建模式可能在用，所以不拿它判死。
 *
 * 各打包器拿模块图的办法不同，差异放在适配器里；profile 里写 verify.bundler 才启用，不写就不拿（没有默认值）
 *
 * 适配器约定（加新的打包器照这个写，再登记到 BUNDLERS）：
 *   instrument({ dir, outDir, config }) → { config, restore }
 *     dir：临时目录；config：配置文件（相对 dir），null 时按打包器自己的规则找；找不到就抛错
 *     只改临时目录里的文件；restore() 把改过的放回原样。一般用 wrap.js 的 wrapConfigFile 写包装配置，
 *     记录逻辑写进 preload.cjs（基线构建时环境变量 CODE_AUDIT_PRELOAD 指着它，包装配置 require 进来；记录目录在 CODE_AUDIT_BUNDLER_OUT 里）
 *   构建时每次构建往 outDir 写一个 JSON 文件：{ ids: 加载过的模块 id（绝对路径，可以带 ?查询参数，虚拟模块以 \0 开头），
 *   exports?: { 模块 id: { rendered: 保留的导出, removed: 摇掉的导出 } } }；只写 id 数组的老格式也认
 *   collectModules 统一读取、换成相对路径
 */
import { existsSync, readdirSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import * as vite from './vite.js'
import { bundlerEnv } from './wrap.js'
import * as webpack from './webpack.js'
import * as vueCli from './vue-cli.js'

export const BUNDLERS = Object.freeze({ vite, webpack, 'vue-cli': vueCli })

/**
 * 在临时目录里给构建配置套一层
 * @param {object} opts
 * @param {string} opts.type     打包器（verify.bundler）
 * @param {string} opts.dir      临时目录
 * @param {string} opts.outDir   模块列表写到这里
 * @param {string|null} [opts.config] 配置文件（verify.bundlerConfig）
 * @returns {{config: string, restore: () => void}}
 */
export function instrument({ type, dir, outDir, config = null }) {
  const adapter = BUNDLERS[type]
  if (!adapter) throw new Error(`不支持的打包器：${type}（支持：${Object.keys(BUNDLERS).join('、')}）`)
  return adapter.instrument({ dir, outDir, config })
}

/**
 * 套多个配置（monorepo 里每个应用一个）；任何一个套不上就把已经套上的撤掉再抛错，临时目录保持原样
 * @param {object} opts
 * @param {string} opts.type
 * @param {string} opts.dir
 * @param {string} opts.outDir
 * @param {string[]|null} opts.configs null = 按打包器自己的规则找一个
 * @returns {{configs: string[], restore: () => void, env: Record<string, string>}} env：基线构建要带上的环境变量（记录逻辑在哪、记录写到哪）
 */
export function instrumentAll({ type, dir, outDir, configs }) {
  const done = []
  try {
    for (const config of configs ?? [null]) done.push(instrument({ type, dir, outDir, config }))
  } catch (e) {
    for (const d of done.reverse()) d.restore()
    throw e
  }
  return { configs: done.map((d) => d.config), restore: () => done.slice().reverse().forEach((d) => d.restore()), env: bundlerEnv(outDir) }
}

/**
 * 读出一次构建记录的模块，换成相对仓库根目录的源码文件；读完清空，下一次构建重新记
 * @param {string} outDir
 * @param {string[]} workDirs 临时目录的各种写法（macOS 上 /var 和 /private/var）
 * @returns {{builds: number, files: Set<string>, bad: string[], exports: Map<string, {rendered: Set<string>, removed: Set<string>}>}}
 *   builds：记录了几次构建；0 表示构建没经过套好的配置；bad：读不了的记录；
 *   exports：文件 → 保留 / 摇掉的导出。多次构建时，有一次保留就算保留；每次（产物里有这个模块的）都摇掉才算摇掉
 */
export function collectModules(outDir, workDirs) {
  const files = new Set()
  let builds = 0
  const bad = []
  const exports = new Map()
  const seenIn = new Map() // 文件 → 产物里有它的构建次数
  const removedCount = new Map() // 文件#名字 → 摇掉它的构建次数
  if (existsSync(outDir)) {
    for (const name of readdirSync(outDir).filter((n) => n.endsWith('.json')).sort()) {
      let record
      try {
        record = JSON.parse(readFileSync(join(outDir, name), 'utf8'))
      } catch {
        bad.push(name) // 构建被超时结束时可能写了一半：这次构建的记录不完整，跳过（只会少救，不会多判死）
        continue
      }
      const ids = Array.isArray(record) ? record : Array.isArray(record?.ids) ? record.ids : null
      if (!ids) {
        bad.push(name)
        continue
      }
      builds++
      for (const id of ids) {
        const f = toRepoFile(id, workDirs)
        if (f) files.add(f)
      }
      const perFile = new Map()
      for (const [id, e] of Object.entries((!Array.isArray(record) && record.exports) || {})) {
        const f = toRepoFile(id, workDirs)
        if (!f || !e) continue
        const cur = perFile.get(f) ?? { rendered: new Set(), removed: new Set() }
        for (const n of e.rendered ?? []) cur.rendered.add(n)
        for (const n of e.removed ?? []) cur.removed.add(n)
        perFile.set(f, cur)
      }
      for (const [f, cur] of perFile) {
        seenIn.set(f, (seenIn.get(f) ?? 0) + 1)
        const all = exports.get(f) ?? { rendered: new Set(), removed: new Set() }
        for (const n of cur.rendered) all.rendered.add(n)
        exports.set(f, all)
        for (const n of cur.removed) removedCount.set(`${f}#${n}`, (removedCount.get(`${f}#${n}`) ?? 0) + 1)
      }
    }
    rmSync(outDir, { recursive: true, force: true })
  }
  for (const [key, n] of removedCount) {
    const at = key.lastIndexOf('#')
    const f = key.slice(0, at)
    const name = key.slice(at + 1)
    const e = exports.get(f)
    if (n === seenIn.get(f) && !e.rendered.has(name)) e.removed.add(name)
  }
  return { builds, files, bad, exports }
}

/**
 * 模块 id → 相对仓库根目录的文件；虚拟模块、依赖包里的、临时目录外的返回 null
 * id 的样子：/tmp/x/tree/src/a.vue?vue&type=style&index=0&lang.css、\0plugin-helper、/@fs/...
 *
 * 文件还在的话换成磁盘上的真实路径：不区分大小写的文件系统（macOS 默认）上，
 * import './Foo.vue' 能加载 foo.vue，模块 id 是 import 里的写法，不换就对不上 git 里的路径
 */
export function toRepoFile(id, workDirs) {
  if (typeof id !== 'string' || id.startsWith('\0')) return null
  const path = canonical(id.replace(/[?#].*$/, ''))
  // 长的先比：/private/var/x 要在 /var/x 之前
  for (const d of [...workDirs].sort((a, b) => b.length - a.length)) {
    if (!path.startsWith(`${d}/`) && !path.startsWith(`${d}${sep}`)) continue
    const rel = relative(d, path).split(sep).join('/')
    if (rel.startsWith('..') || rel.split('/').includes('node_modules')) return null
    return rel
  }
  return null
}

/** 磁盘上的真实路径（大小写、软链接都按实际的）；文件不在了就原样返回 */
function canonical(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

/** 临时目录的各种写法：原样、真实路径（macOS 上 /var 实际是 /private/var） */
export function workDirsOf(dir) {
  return [...new Set([dir, realpathSync(dir), canonical(dir)])]
}
