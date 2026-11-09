/**
 * history 模块对外的入口：把引入、时间线、失去引用组合成 schema 里的 History 结构
 */
import { findBranchIntroduced, traceOrigin } from './introduced.js'
import { buildTimeline, findLostRef } from './refs.js'
import { DEFAULT_CONFIG } from '../core/config.js'

/**
 * 追溯一个文件的 git 历史
 * @param {object} opts
 * @param {string} opts.root      仓库目录
 * @param {string} opts.file      目标文件，相对 root（当前路径，移动过也没关系）
 * @param {string} [opts.pattern] 引用方代码里会出现的字符串，如 "utils/math"
 *                                不传时由文件最初的路径和 config.sourceRoots 推出；推不出来就报错
 * @param {string} [opts.rev]     查到哪个提交为止，默认 HEAD
 * @param {Readonly<import('../core/config.js').Config>} [opts.config] 项目配置，默认 DEFAULT_CONFIG
 * @returns {{pattern: string, paths: string[], history: import('../core/schema.js').History}}
 *   paths：文件用过的所有路径，从当前到最初
 */
export function traceHistory({ root, file, pattern, rev = 'HEAD', config = DEFAULT_CONFIG }) {
  const { introduced, paths } = traceOrigin(root, file, rev)
  if (!introduced) {
    throw new Error(`在 ${rev} 之前的历史里找不到文件：${file}`)
  }

  // 默认用最初的路径推 pattern：被移动过的文件，当年的引用写法是按旧路径写的
  const origin = paths[paths.length - 1]
  const usedPattern = pattern ?? defaultPattern(origin, config)
  if (!usedPattern) {
    throw new Error(
      `无法推出 pattern：${origin} 不在配置的源码根目录（${config.sourceRoots.join('、') || '无'}）下。` +
      '请用 --pattern 指定引用方代码里的写法，或在配置的 sourceRoots 里加上它所在的目录'
    )
  }

  const timeline = buildTimeline(root, usedPattern, { rev, exclude: paths, extensions: config.extensions, aliases: config.aliases })
  const lostRef = findLostRef(timeline)

  // 引入的是合并提交：补上分支上真正新增这个文件的提交
  const introducedFrom = findBranchIntroduced(root, introduced.hash, origin)
  const history = { introduced, lostRef, timeline, paths, pattern: usedPattern }
  if (introducedFrom) history.introducedFrom = introducedFrom

  return { pattern: usedPattern, paths, history }
}

/**
 * 从文件路径推一个默认的 pattern：去掉源码根目录、扩展名，以及末尾的 /index
 * 例（sourceRoots 为 ['src']）：
 *   src/utils/math.js           → utils/math
 *   src/lib/layout/index.js → lib/layout（引用目录时不写 index）
 * 文件名里的空格保留：如果当年代码里就是带着空格引用的，去掉反而搜不到
 *
 * 文件不在任何源码根目录下时返回 null，不猜：
 * 猜错的 pattern 会搜不到引用，结论变成「从未被引用」，比报错更危险
 * @param {string} file
 * @param {{sourceRoots: readonly string[]}} [config]
 * @returns {string | null}
 */
export function defaultPattern(file, { sourceRoots } = DEFAULT_CONFIG) {
  // 有多个根目录都匹配时（如 src 和 src/app），取最长的那个
  const matched = [...sourceRoots]
    .sort((a, b) => b.length - a.length)
    .find((r) => file.startsWith(`${r}/`))
  if (!matched) return null

  return file
    .slice(matched.length + 1)
    .replace(/\.[^/.]+$/, '')
    .replace(/\/index$/, '')
}
