/**
 * 基线：在没删任何文件的工作目录里，按配置跑构建、测试
 *
 * 删文件以后的结果要和基线比：基线里本来就有的失败、警告不算删文件引起的
 */
import { existsSync, writeFileSync, mkdirSync, realpathSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { runCommand } from './run-command.js'
import { collectModules, instrumentAll, workDirsOf } from './bundlers/index.js'
import { WRAPPER_VERSION } from './bundlers/wrap.js'
import { age, baselineKey, depsFingerprint, readBaseline, writeBaseline } from './cache.js'

/** 按这个顺序跑 */
export const STEPS = Object.freeze(['build', 'test'])

/**
 * @param {object} opts
 * @param {string} opts.cwd  工作目录
 * @param {Readonly<import('../core/config.js').VerifyConfig>} opts.verify
 * @param {string} [opts.logDir] 完整输出写到这个目录（每步一个 .log，不截断）
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof runCommand} [opts.run] 测试时可以替换
 * @returns {Promise<Record<string, import('./run-command.js').CommandResult>>} 只含配置了的步骤
 */
export async function runSteps({ cwd, verify, logDir, log = () => {}, run = runCommand, env = undefined }) {
  const results = {}
  for (const step of STEPS) {
    const command = verify[step]
    if (!command) continue
    log(`运行 ${step}：${command}`)
    const logFile = logDir ? join(logDir, `${step}.log`) : undefined
    if (logDir) mkdirSync(logDir, { recursive: true })
    const r = await run(command, { cwd, timeoutSeconds: verify.timeoutSeconds, logFile, ...(env ? { env } : {}) })
    results[step] = r
    // 替换掉的 run（测试用）可能不写日志：至少把保留下来的输出写进去
    if (logFile && !existsSync(logFile)) writeFileSync(logFile, r.output)
    log(`  ${describe(r)}`)
  }
  return results
}

/** 一步的结果，给人看 */
export function describe(r) {
  const secs = `${Math.round(r.durationMs / 1000)} 秒`
  if (r.timedOut) return `超时（${secs}）`
  if (r.ok) return `成功（${secs}）`
  return r.exitCode === null ? `没能启动（${secs}）` : `失败，退出码 ${r.exitCode}（${secs}）`
}

/**
 * @typedef {object} Baseline
 * @property {Record<string, import('./run-command.js').CommandResult>} results
 * @property {Set<string>|null} modules  打包器加载过的源码文件；没启用打包器证据、或没拿到时为 null
 * @property {Map<string, {rendered: Set<string>, removed: Set<string>}>|null} exports  各文件 tree-shaking 后保留 / 摇掉的导出（导出维度用）；没拿到时为 null
 * @property {number} builds   打包器记录了几次构建（没启用时为 0）
 * @property {string|null} cachedAt 复用的缓存是什么时候的；现跑的为 null
 * @property {string|null} bundlerDropped 启用了打包器证据却没有的原因（套不上、套了构建失败撤掉了）；没有为 null
 */

/**
 * 准备基线：套好打包器配置（启用了的话），有缓存就复用，没有就跑一遍再存起来
 *
 * 打包器配置每次都要套：之后删文件的每一轮也在同一个目录里跑，要和基线用同一份配置
 * 打包器证据、缓存都是锦上添花：套不上、读写缓存出错都只提示，照常验证，不能因为它们让 verify 跑不了
 * @param {object} opts
 * @param {string} opts.root  仓库目录（算依赖状态用）
 * @param {import('./workspace.js').Workspace} opts.ws
 * @param {Readonly<import('../core/config.js').VerifyConfig>} opts.verify
 * @param {boolean} [opts.useCache]  读缓存；false 时照样跑、跑完照样写缓存
 * @param {string} [opts.cacheDir]   测试时可以换
 * @param {string} [opts.logDir]
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof runCommand} [opts.run]
 * @returns {Promise<Baseline>}
 */
export async function prepareBaseline({ root, ws, verify, useCache = true, cacheDir, logDir, log = () => {}, run = runCommand }) {
  const outDir = join(dirname(ws.dir), 'bundler-modules')
  let restore = null
  let configs = []
  let env
  let bundlerDropped = null
  if (verify.bundler) {
    try {
      const r = instrumentAll({ type: verify.bundler, dir: ws.dir, outDir, configs: verify.bundlerConfig === null ? null : [].concat(verify.bundlerConfig) })
      restore = r.restore
      configs = r.configs
      env = r.env
      log(`打包器证据：在临时目录里给 ${configs.join('、')} 套了一层，构建时记下加载过的模块（项目文件不改）`)
    } catch (e) {
      bundlerDropped = `没能套上打包器配置：${e.message}`
      log(`  ${bundlerDropped}。照常验证，只是没有打包器证据`)
    }
  }

  const key = baselineKey({ commit: ws.commit, verify, deps: depsFingerprint(root, ws.deps) })
  if (useCache) {
    let hit = safely(() => readBaseline(key, cacheDir), log)
    // 老版本存的缓存没有导出记录：拿到了模块列表却没有 exports 的，当没有缓存，重跑一遍（只有这一次）
    if (hit && hit.modules && hit.exports === undefined) {
      log('有基线缓存，但是老格式（没有 tree-shaking 的导出记录），重跑一遍')
      hit = null
    }
    // 上次套了配置构建不过、撤掉了，用的是老写法的包装配置：换了写法，重试一次
    if (hit && hit.bundlerDropped && restore && hit.wrapper !== WRAPPER_VERSION) {
      log(`有基线缓存，但上次${hit.bundlerDropped}，当时是老写法的包装配置：重跑一遍`)
      hit = null
    }
    if (hit) {
      log(`复用 ${age(hit.createdAt)}的基线（同一个提交、同样的命令和依赖），不再跑一遍。要重跑加 --fresh`)
      for (const [step, r] of Object.entries(hit.results)) log(`  ${step}：${describe(r)}`)
      // 上次套了配置构建不过、撤掉才跑通的：这次也撤掉，删文件的每一轮要和基线一样
      if (hit.bundlerDropped && restore) {
        restore()
        log(`  ${hit.bundlerDropped}，上次已撤掉，这次也撤掉`)
      }
      return {
        results: hit.results,
        modules: hit.modules ? new Set(hit.modules) : null,
        exports: hit.exports ? new Map(Object.entries(hit.exports).map(([f, e]) => [f, { rendered: new Set(e.rendered), removed: new Set(e.removed) }])) : null,
        builds: hit.builds,
        workDir: hit.workDir,
        cachedAt: hit.createdAt,
        bundlerDropped: hit.bundlerDropped ?? bundlerDropped
      }
    }
  }

  let results = await runSteps({ cwd: ws.dir, verify, run, logDir, log, env })
  let modules = null
  let exports = null
  let builds = 0
  if (restore) {
    const collected = collectModules(outDir, workDirsOf(ws.dir))
    builds = collected.builds
    modules = builds > 0 ? collected.files : null
    exports = builds > 0 ? collected.exports : null
    if (collected.bad.length > 0) log(`  有 ${collected.bad.length} 份模块记录读不了（构建中途被结束？），跳过`)
    // 套了配置后构建失败：撤掉重跑，看是不是它引起的（构建前的 lint、类型检查检查到了生成的文件等）
    if (results.build && !results.build.ok) {
      const lines = errorLines(results.build, configs)
      log('  套了打包器配置后构建失败：撤掉这一层重跑，确认是不是它引起的')
      restore()
      modules = null
      exports = null
      builds = 0
      results = await runSteps({ cwd: ws.dir, verify, run, logDir, log })
      if (results.build.ok) {
        bundlerDropped = `套了打包器配置后构建失败${lines.length ? `（${lines.join(' | ')}）` : ''}`
        log(`  撤掉后构建成功：${bundlerDropped}。这次没有打包器证据`)
      } else {
        log('  撤掉后构建还是失败：不是打包器配置引起的，是项目本身的构建问题')
      }
    }
  }
  if (!results.build || results.build.ok) {
    const savedExports = exports ? Object.fromEntries([...exports].sort().map(([f, e]) => [f, { rendered: [...e.rendered].sort(), removed: [...e.removed].sort() }])) : null
    safely(() => writeBaseline(key, { results, modules: modules ? [...modules].sort() : null, exports: savedExports, builds, workDir: realpathSync(ws.dir), bundlerDropped, wrapper: WRAPPER_VERSION }, cacheDir), log)
  }
  return { results, modules, exports, builds, workDir: realpathSync(ws.dir), cachedAt: null, bundlerDropped }
}

/** 缓存读写出错（缓存目录没有权限、磁盘满等）：提示一下，当没有缓存 */
function safely(fn, log) {
  try {
    return fn()
  } catch (e) {
    log(`  基线缓存读写出错，这次不用缓存：${e.message}`)
    return null
  }
}

/**
 * 构建失败时的前几行报错，写进提示。提到套过的配置文件的行排在前面：多半就是原因
 * @param {import('./run-command.js').CommandResult} r
 * @param {string[]} configs 套过的配置文件
 */
function errorLines(r, configs) {
  const names = configs.map((c) => c.split('/').pop())
  const all = (r.signals || r.output)
    .split('\n')
    .map((l) => l.trim().replace(/\s+/g, ' '))
    .filter((l) => /error|fail|cannot|无法|失败/i.test(l))
  const mentions = all.filter((l) => names.some((n) => l.includes(n)))
  return [...new Set([...mentions, ...all])]
    .slice(0, 2)
    .map((l) => (l.length > 160 ? `${l.slice(0, 160)}…` : l))
}
