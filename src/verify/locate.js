/**
 * 从删文件后新增的报错里，找出是哪些被删的文件引起的
 *
 * 认三种写法：
 * 1. 报错里直接写着被删文件的路径（如 ENOENT: src/utils/a.js）
 * 2. 报错里有引号括起来的 import 路径，同一行还写着引用方文件：按引用方解析
 *      Could not resolve "./a" from "src/views/b.vue"
 *      Failed to resolve import "@/utils/a" from "src/main.js"
 * 3. 新失败的测试：读测试文件，看它 import 了哪些被删的文件
 *
 * 找不到时返回空集合，由调用方退回对半找
 */
import { buildLookup, findImportRefs, resolveSpec } from '../collect/path-refs.js'

const SOURCE_PATH = /(?:^|[\s"'`(\[])((?:\.{0,2}\/)?[\w@$-][\w@$.-]*(?:\/[\w@$.-]+)*\.(?:js|mjs|cjs|jsx|ts|mts|cts|tsx|vue|svelte|astro))(?![\w])/g
const QUOTED = /(["'`])([^"'`\s]+)\1/g

/**
 * @param {object} opts
 * @param {string[]} opts.newLines     比基线多出来的输出行（已归一化，临时目录的路径已去掉）
 * @param {string[]} opts.newFailures  新失败的测试
 * @param {string[]} opts.deleted      这一轮删掉的文件
 * @param {Record<string, string>} [opts.aliases]
 * @param {(path: string) => string|null} opts.readFile 读工作目录里的文件；不存在返回 null
 * @returns {Set<string>} 可能引起问题的被删文件
 */
export function locate({ newLines, newFailures, deleted, aliases = {}, readFile }) {
  const lookup = buildLookup(deleted)
  const found = new Set()
  const hit = (resolved) => {
    for (const f of lookup.get(resolved) ?? []) found.add(f)
  }

  for (const line of newLines) {
    const paths = [...line.matchAll(SOURCE_PATH)].map((m) => m[1])
    // 1. 直接写着路径
    for (const p of paths) {
      const r = resolveSpec(p.startsWith('.') || p.startsWith('/') ? p : `/${p}`, '', aliases)
      if (r !== null) hit(r)
    }
    // 2. 引号里的 import 路径，按同一行里的引用方解析；没有引用方时按别名、仓库根目录解析
    for (const m of line.matchAll(QUOTED)) {
      const spec = m[2]
      const importers = paths.filter((p) => p !== spec)
      for (const from of importers.length > 0 ? importers : ['']) {
        const r = resolveSpec(spec, from.replace(/^\.?\//, ''), aliases)
        if (r !== null) hit(r)
      }
    }
  }

  // 3. 新失败的测试 import 了哪些被删的文件
  const isSource = new RegExp(SOURCE_PATH.source) // 不带 g：反复 test 不受 lastIndex 影响
  const testFiles = new Set(newFailures.map((f) => f.split(/\s+[>[]/)[0].trim()).filter((p) => isSource.test(` ${p}`)))
  const files = [...testFiles].map((path) => ({ path, content: readFile(path) })).filter((f) => f.content !== null)
  for (const target of findImportRefs({ files, targets: deleted, aliases }).keys()) found.add(target)

  return found
}
