/**
 * history 模块对外的入口：把引入、时间线、失去引用组合成 schema 里的 History 结构
 */
import { traceOrigin } from './introduced.js'
import { buildTimeline, findLostRef } from './refs.js'

/**
 * 追溯一个文件的 git 历史
 * @param {object} opts
 * @param {string} opts.root      仓库目录
 * @param {string} opts.file      目标文件，相对 root（当前路径，移动过也没关系）
 * @param {string} [opts.pattern] 引用方代码里会出现的字符串，如 "utils/math"
 *                                不传时由文件最初的路径推出
 * @param {string} [opts.rev]     查到哪个提交为止，默认 HEAD
 * @returns {{pattern: string, paths: string[], history: import('../core/schema.js').History}}
 *   paths：文件用过的所有路径，从当前到最初
 */
export function traceHistory({ root, file, pattern, rev = 'HEAD' }) {
  const { introduced, paths } = traceOrigin(root, file, rev)
  if (!introduced) {
    throw new Error(`在 ${rev} 之前的历史里找不到文件：${file}`)
  }

  // 默认用最初的路径推 pattern：被移动过的文件，当年的引用写法是按旧路径写的
  const usedPattern = pattern ?? defaultPattern(paths[paths.length - 1])

  const timeline = buildTimeline(root, usedPattern, { rev, exclude: paths })
  const lostRef = findLostRef(timeline)

  return { pattern: usedPattern, paths, history: { introduced, lostRef, timeline } }
}

/**
 * 从文件路径推一个默认的 pattern：去掉开头的 src/、扩展名，以及末尾的 /index
 * 例：src/utils/math.js → utils/math
 *     src/utils/relayout/index.js → utils/relayout（引用目录时不写 index）
 * 文件名里的空格保留：当年代码里就是带着空格引用的（如 '@/utils/ setting'）
 */
export function defaultPattern(file) {
  return file
    .replace(/^src\//, '')
    .replace(/\.[^/.]+$/, '')
    .replace(/\/index$/, '')
}
