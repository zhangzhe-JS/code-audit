/**
 * 导出维度的打包器证据：在临时目录里跑一次基线构建（verify 的基线，有缓存就复用），
 * 拿到 tree-shaking 后各文件保留 / 摇掉的导出（Rollup 的 renderedExports / removedExports）
 *
 * 用法只有一个方向（和文件维度一样）：
 * - 静态分析说没人用（dead、dead-only-ref、test-only），构建却保留了这个导出 → 改判 unknown：
 *   可能被动态 import() 整体引入、有副作用，或者静态分析漏看了引用
 * - 构建也摇掉了 → 只记成佐证，不单凭它判死：测试、脚本、别的构建模式可能在用
 * - internal 不比较：只在文件内部用的函数会被保留下来，保留不说明外部有人用
 * - 构建里根本没加载这个文件：记成佐证（这次构建用不到它）
 */
import { createWorkspace } from '../verify/workspace.js'
import { prepareBaseline } from '../verify/baseline.js'

const CHECKED = new Set(['dead', 'dead-only-ref', 'test-only'])

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.result  scanExports 的结果（直接改）
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {boolean} [opts.useCache]
 * @param {string} [opts.cacheDir]
 * @param {(msg: string) => void} [opts.log]
 * @param {Function} [opts.run] 测试时替换跑命令的函数
 */
export async function addBundlerEvidence({ root, result, config, useCache = true, cacheDir, log = () => {}, run }) {
  if (!config.verify.build || !config.verify.bundler) {
    throw new Error('--verify 要在 profile 的 verify 里写上 build（构建命令）和 bundler（如 "vite"）：tree-shaking 的结果从构建里拿')
  }
  const ws = createWorkspace({ root, rev: result.project.rev })
  let base
  try {
    base = await prepareBaseline({ root, ws, verify: { ...config.verify, test: null }, useCache, cacheDir, log, ...(run ? { run } : {}) })
  } finally {
    ws.cleanup()
  }
  if (base.results.build && !base.results.build.ok) throw new Error('基线构建失败，拿不到 tree-shaking 的结果（项目在这个提交上本身构建不过？）')
  if (!base.exports) {
    const why = base.bundlerDropped ?? (base.builds === 0 ? '构建没经过套好的配置' : '构建记录里没有导出信息')
    result.bundler = { used: false, reason: why }
    return { applied: 0, reason: why }
  }
  return applyBundlerExports(result, base)
}

/**
 * 把构建的结果用到候选上（直接改 result）
 * @param {object} result
 * @param {{modules: Set<string>|null, exports: Map<string, {rendered: Set<string>, removed: Set<string>}>}} base
 */
export function applyBundlerExports(result, base) {
  let raised = 0
  for (const c of result.items) {
    const e = base.exports.get(c.file)
    if (!e) {
      if (base.modules && !base.modules.has(c.file)) c.evidence.push({ rule: 'bundler-not-loaded', detail: '构建里没有加载这个文件（佐证：这次构建用不到它）' })
      continue
    }
    if (CHECKED.has(c.status) && e.rendered.has(c.name)) {
      c.evidence.unshift({ rule: 'bundler-rendered', detail: '构建时 tree-shaking 保留了这个导出：可能被动态 import() 整体引入、有副作用，或者静态分析漏看了引用' })
      c.status = 'unknown'
      c.suggestion = '人工确认：构建里保留了这个导出'
      raised++
    } else if (e.removed.has(c.name)) {
      c.evidence.push({ rule: 'bundler-removed', detail: '构建时被 tree-shaking 摇掉了（佐证；测试、别的构建模式用不用看不出）' })
    }
  }
  const byStatus = {}
  for (const c of result.items) byStatus[c.status] = (byStatus[c.status] ?? 0) + 1
  result.summary.byStatus = byStatus
  result.bundler = { used: true, files: base.exports.size }
  return { applied: base.exports.size, raised }
}
