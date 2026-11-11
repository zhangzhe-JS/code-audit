/**
 * 接口路径的相似度：新增接口时提示「已经有很像的接口了」，避免同一个接口写两遍；query 里找相似接口也用它
 *
 * 做法：路径拆成词（按 /、驼峰、短横线、下划线切开，转小写，参数段 {} 不算），两组词的重合程度（Jaccard）。
 * 只是提示，不参与判定
 *   /template/v2/enabled 和 /template/v2/enabledWithoutService → template v2 enabled / template v2 enabled without service → 3/5 = 0.6
 */

/** 路径里的词 */
export function pathWords(path) {
  return path
    .split('/')
    .filter((seg) => seg && seg !== '{}')
    .flatMap((seg) => seg.replace(/\{\}/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').split(/[\s\-_.]+/))
    .map((w) => w.toLowerCase())
    .filter(Boolean)
}

/**
 * @param {string} a
 * @param {string} b
 * @returns {number} 0 到 1；完全一样的路径是 1
 */
export function similarity(a, b) {
  if (a === b) return 1
  const x = new Set(pathWords(a))
  const y = new Set(pathWords(b))
  if (x.size === 0 || y.size === 0) return 0
  let common = 0
  for (const w of x) if (y.has(w)) common++
  return common / (x.size + y.size - common)
}
