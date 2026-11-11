/**
 * 采集插件：调用 knip，找出从入口走不到的文件
 *
 * knip 是 code-audit 的可选依赖：安装 code-audit 时自动装上，不装进目标项目。
 * 只有 scan 用到它；没装时 scan 报错并说明怎么装，其他命令不受影响。
 *
 * 只读原则：
 * - knip 的配置由我们生成，写在系统临时目录里，用完删除；不在目标项目里放任何文件
 * - 不开缓存（缓存默认写在目标项目的 node_modules 里）
 * - knip 的插件会加载项目里的配置文件（vite.config.js 等），加载就是执行项目代码。
 *   所以关掉全部插件，只保留负责解析 .vue / .svelte / .astro 文件的插件，并且不让它们读配置文件。
 *   插件名单 knip 每个版本都可能变，所以跑完还要核对实际启用了哪些，有名单外的就报错
 */
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * 负责解析单文件组件的插件：没有它们，.vue 等文件里的 import 读不到，引用会全部漏掉
 * 启用时把 config 和 entry 设成空：只用它们的解析器，不加载任何配置文件，也不额外加入口
 * 键是插件 ID，值是 knip 调试输出里显示的插件名（用来核对）
 */
export const COMPILER_PLUGINS = Object.freeze({ vue: 'Vue', svelte: 'Svelte', astro: 'Astro' })

/** 单文件组件扩展名 → 依赖名：package.json 里没有这个依赖时，knip 不解析这类文件 */
export const COMPILER_DEPS = Object.freeze({ '.vue': 'vue', '.svelte': 'svelte', '.astro': 'astro' })

/**
 * 补上单文件组件的依赖声明，返回补了哪些
 *
 * knip 只在 package.json 声明了 vue（svelte、astro 同理）时才解析 .vue 文件，否则悄悄跳过：
 * .vue 文件不会列为候选，.vue 里的 import 也不跟进，只被组件用到的 js 会被误报为没人用。
 * 插件列表里照样显示 Vue，核对插件看不出来。monorepo 里依赖写在子包、或者没有 package.json 时都会遇到。
 *
 * 只改 scan 导出的临时目录里的 package.json，不碰目标仓库。scan 只问 knip「哪些文件没人用」，
 * 多一个依赖声明不影响结果
 * @param {object} pkg     package.json 的内容（会被修改）
 * @param {string[]} files 源码文件
 * @returns {string[]} 补上的依赖名
 */
export function addCompilerDeps(pkg, files) {
  const declared = new Set(
    ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {}))
  )
  const added = []
  for (const [ext, dep] of Object.entries(COMPILER_DEPS)) {
    if (declared.has(dep) || !files.some((f) => f.endsWith(ext))) continue
    pkg.devDependencies = { ...pkg.devDependencies, [dep]: '*' }
    added.push(dep)
  }
  return added
}

/** 没找到 knip 时的提示 */
const INSTALL_HINT =
  'scan 需要 knip。安装 code-audit 时会自动装上（可选依赖）；如果被跳过了，在 code-audit 目录运行 npm install，' +
  '或用 --knip 指定 knip 的安装目录'

/**
 * 找到 knip：默认用 code-audit 自己的依赖；--knip 可以指定另一个安装目录
 * @param {string} [dir] knip 包的目录（里面有 package.json）
 * @returns {{dir: string, bin: string, version: string}}
 */
export function findKnip(dir) {
  let pkgDir
  if (dir) {
    pkgDir = resolve(dir)
    if (!existsSync(join(pkgDir, 'package.json'))) throw new Error(`--knip 指定的目录里没有 package.json：${pkgDir}`)
  } else {
    // knip 的 exports 不包含 package.json，所以先解析主入口，再往上找包目录
    let main
    try {
      main = createRequire(import.meta.url).resolve('knip')
    } catch {
      throw new Error(INSTALL_HINT)
    }
    pkgDir = findPackageDir(main, 'knip')
    if (!pkgDir) throw new Error(`${INSTALL_HINT}（解析到 ${main}，但找不到它的包目录）`)
  }

  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'))
  } catch (e) {
    throw new Error(`读不到 knip 的 package.json：${pkgDir}（${e.message}）`)
  }
  if (pkg.name !== 'knip') throw new Error(`不是 knip 的安装目录（package.json 里的 name 是 ${pkg.name}）：${pkgDir}`)

  const binPath = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.knip
  if (!binPath) throw new Error(`knip 的 package.json 里没有 bin：${pkgDir}`)
  const bin = join(pkgDir, binPath)
  if (!existsSync(bin)) throw new Error(`找不到 knip 的命令文件：${bin}`)
  return { dir: pkgDir, bin, version: String(pkg.version) }
}

/** 从文件往上找，找到 name 为 pkgName 的 package.json 所在目录 */
function findPackageDir(file, pkgName) {
  let dir = dirname(file)
  while (true) {
    const pkgFile = join(dir, 'package.json')
    if (existsSync(pkgFile)) {
      try {
        if (JSON.parse(readFileSync(pkgFile, 'utf8')).name === pkgName) return dir
      } catch {
        // 不是合法的 JSON：继续往上找
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * knip 所有插件的 ID
 * 优先读内部列表：knip 校验配置用的就是这份，写了不在里面的插件名，knip 会拒绝整个配置。
 * 读不到时退回公开的 schema.json（两份不完全一致，所以只作后备）。
 * 不管读的哪份，跑完都会核对实际启用的插件，漏关的插件不会被放过
 * @param {string} knipDir
 * @returns {string[]}
 */
export function readPluginNames(knipDir) {
  // 内部列表是一个字符串数组的源码文件；只读文本，不执行它
  const listFile = join(knipDir, 'dist', 'types', 'PluginNames.js')
  if (existsSync(listFile)) {
    const body = readFileSync(listFile, 'utf8').match(/pluginNames\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? ''
    const names = [...body.matchAll(/['"]([\w@./-]+)['"]/g)].map((m) => m[1])
    if (names.length > 0) return [...new Set(names)].sort()
  }

  const schemaFile = join(knipDir, 'schema.json')
  if (existsSync(schemaFile)) {
    try {
      const schema = JSON.parse(readFileSync(schemaFile, 'utf8'))
      const names = Object.keys(schema?.definitions?.plugins?.properties ?? {})
      if (names.length > 0) return names.sort()
    } catch {
      // 落到下面报错
    }
  }

  throw new Error(`读不到 knip 的插件列表，无法关闭插件（knip 目录：${knipDir}）。这个版本的 knip 可能不兼容`)
}

/**
 * 生成 knip 配置
 * @param {object} opts
 * @param {string[]} opts.entry   入口（路径或 glob）
 * @param {string[]} opts.project 参与分析的文件（glob）
 * @param {Record<string, string>} opts.aliases 别名 → 目录
 * @param {string[]} opts.pluginNames knip 的全部插件 ID
 */
export function buildKnipConfig({ entry, project, aliases, pluginNames }) {
  const paths = {}
  for (const [name, dir] of Object.entries(aliases)) {
    paths[name] = [dir]
    paths[`${name}/*`] = [`${dir}/*`]
  }
  const config = { entry: [...entry], project: [...project], paths }
  for (const name of pluginNames) {
    config[name] = name in COMPILER_PLUGINS ? { config: [], entry: [] } : false
  }
  return config
}

/**
 * 从 knip 的调试输出里取出实际启用的插件名
 * 输出形如：
 *   [.] Enabled plugins
 *   [ 'Vue', 'Node.js' ]
 * 找不到这一段时返回 null：knip 的输出格式变了，无法核对
 * @param {string} output
 * @returns {string[] | null}
 */
export function parseEnabledPlugins(output) {
  const text = output.replace(/\x1b\[[0-9;]*m/g, '') // 去掉终端颜色
  const at = text.indexOf('Enabled plugins')
  if (at === -1) return null
  const open = text.indexOf('[', at + 'Enabled plugins'.length)
  const close = text.indexOf(']', open)
  if (open === -1 || close === -1) return null
  return [...text.slice(open + 1, close).matchAll(/'([^']*)'|"([^"]*)"/g)].map((m) => m[1] ?? m[2])
}

/**
 * 核对启用的插件：只允许解析单文件组件的那几个
 * @param {string[] | null} enabled
 */
export function assertOnlyCompilerPlugins(enabled) {
  if (enabled === null) {
    throw new Error('无法确认 knip 启用了哪些插件（调试输出里没有 Enabled plugins），这个版本的 knip 可能不兼容，没有生成结果')
  }
  const allowed = new Set(Object.values(COMPILER_PLUGINS))
  const extra = enabled.filter((p) => !allowed.has(p))
  if (extra.length > 0) {
    throw new Error(
      `knip 启用了没能关掉的插件：${extra.join('、')}。\n` +
      '这些插件会加载项目里的配置文件，还会额外加入口，结果不可信，没有生成结果。\n' +
      '通常是 knip 新增了插件：请更新 code-audit，或用 --knip 指定兼容的 knip 版本'
    )
  }
}

/**
 * 运行一次 knip，返回从入口走不到的文件（相对仓库根目录）
 * @param {object} opts
 * @param {{bin: string, dir: string}} opts.knip findKnip 的结果
 * @param {string} opts.root 仓库根目录（绝对路径）
 * @param {object} opts.config buildKnipConfig 的结果
 * @param {boolean} [opts.exports] 同时报出没人用的导出（接口维度用）
 * @returns {{unusedFiles: string[], enabledPlugins: string[], unusedExports?: Map<string, Set<string>>}}
 */
export function runKnip({ knip, root, config, exports = false }) {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`仓库目录不存在：${root}`)
  // 传真实路径：目录经过符号链接时（如 macOS 的 /var → /private/var），knip 列文件用的是链接路径，
  // 解析 import 得到的是真实路径，两边对不上，所有文件都会被误报为走不到
  const realRoot = realpathSync(root)

  // 配置和结果都放在系统临时目录：不往目标项目里写任何东西
  const work = mkdtempSync(join(tmpdir(), 'code-audit-knip-'))
  try {
    const configFile = join(work, 'knip.json')
    const resultFile = join(work, 'result.json')
    writeFileSync(configFile, JSON.stringify(config, null, 2))

    let output
    try {
      output = execFileSync(
        process.execPath,
        [
          knip.bin,
          '--directory', realRoot,
          '--config', configFile,
          // types：knip 把 enum 归在类型里报；调用方只保留有运行时声明的名字（type / interface 自然过滤掉）
          '--include', exports ? 'files,exports,nsExports,types' : 'files',
          '--reporter', 'json',
          '--output-file', `json=${resultFile}`,
          '--no-exit-code',
          '--no-progress',
          '--no-config-hints',
          '--debug' // 调试输出里有实际启用的插件，用来核对
        ],
        {
          cwd: work,
          encoding: 'utf8',
          maxBuffer: 512 * 1024 * 1024, // 调试输出随项目大小增长
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, CI: '1', FORCE_COLOR: '0', NO_COLOR: '1' }
        }
      )
    } catch (e) {
      const detail = String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-15).join('\n')
      throw new Error(`knip 运行失败（退出码 ${e.status ?? '无'}）：\n${detail}`)
    }

    const enabledPlugins = parseEnabledPlugins(output)
    assertOnlyCompilerPlugins(enabledPlugins)

    let result
    try {
      result = JSON.parse(readFileSync(resultFile, 'utf8'))
    } catch (e) {
      throw new Error(`读不到 knip 的结果（${e.message}）`)
    }
    const out = { unusedFiles: parseUnusedFiles(result), enabledPlugins }
    if (exports) out.unusedExports = parseUnusedExports(result)
    return out
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * 从 knip 的 JSON 结果里取出没人用的文件
 * @param {{issues?: {file: string, files?: unknown[]}[]}} result
 * @returns {string[]} 排好序
 */
export function parseUnusedFiles(result) {
  if (!Array.isArray(result?.issues)) throw new Error('knip 的结果格式不认识：没有 issues 数组')
  const files = new Set()
  for (const issue of result.issues) {
    if (Array.isArray(issue.files) && issue.files.length > 0) {
      if (typeof issue.file !== 'string' || issue.file === '' || issue.file.startsWith('/') || issue.file.includes('\\')) {
        throw new Error(`knip 的结果里有不认识的文件路径：${issue.file}`)
      }
      files.add(issue.file)
    }
  }
  return [...files].sort()
}

/**
 * 从 knip 的 JSON 结果里取出没人用的导出：文件 → 导出名
 * 只在从入口走得到的文件里报；nsExports（以命名空间导入、却没用到的成员）也算没人用；
 * types 也收进来（enum 在这一类里），type / interface 由调用方按「有没有运行时声明」过滤
 * @param {{issues?: {file: string, exports?: {name: string}[], nsExports?: {name: string}[]}[]}} result
 * @returns {Map<string, Set<string>>}
 */
export function parseUnusedExports(result) {
  if (!Array.isArray(result?.issues)) throw new Error('knip 的结果格式不认识：没有 issues 数组')
  const map = new Map()
  for (const issue of result.issues) {
    for (const key of ['exports', 'nsExports', 'types']) {
      const list = issue[key]
      if (!Array.isArray(list) || list.length === 0) continue
      if (typeof issue.file !== 'string' || issue.file === '' || issue.file.startsWith('/')) {
        throw new Error(`knip 的结果里有不认识的文件路径：${issue.file}`)
      }
      const names = map.get(issue.file) ?? new Set()
      for (const e of list) {
        if (typeof e?.name !== 'string') throw new Error(`knip 的结果里有不认识的导出：${JSON.stringify(e)}`)
        names.add(e.name)
      }
      map.set(issue.file, names)
    }
  }
  return map
}
