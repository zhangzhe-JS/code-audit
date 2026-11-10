/**
 * 挪进隔离目录以后，会不会被批量加载的写法重新加载回来
 *
 * 就近隔离时文件还在原来的目录下面：src/views/a/_deprecated/Old.vue 会被 import.meta.glob('../views/**\/*.vue') 圈到，
 * src/store/modules/_deprecated/old.js 会被 require.context('./modules', true, /\.js$/) 圈到——
 * 已经隔离的页面又被注册成路由、又被打包。这种位置不能放，计划里写明原因、不移
 *
 * 查的是分析的那个提交里的代码：import.meta.glob（换算得了的按 glob 匹配，换算不了的按模式匹配）、
 * 拼接路径的 import() / require()、require.context。人工确认过的动态加载（reviewedDynamicLoads）不算
 * 源码目录外的代码（构建配置、脚本）也查：和 scan 一样，它们写的加载照样会把文件加载回来。测试文件不查（和 scan 一致）
 */
import { findGlobImports, globToRegExp } from '../collect/glob-imports.js'
import { findDynamicLoads, inScope, wideScope } from '../collect/dynamic-imports.js'
import { matchesReview } from '../collect/scan.js'
import { outsideCode } from '../collect/external-refs.js'

/**
 * @param {object} opts
 * @param {string[]} opts.files  提交里的所有文件
 * @param {(path: string) => string} opts.readFile
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @returns {(path: string) => string|null}  会被重新加载时返回原因，否则 null
 */
export function makeRecaptureCheck({ files, readFile, config }) {
  const tests = config.testEntries.map((g) => globToRegExp(g))
  const isTest = (f) => tests.some((re) => re.test(f))
  const sources = files.filter((f) => config.sourceRoots.some((r) => f.startsWith(`${r}/`)) && config.extensions.some((e) => f.endsWith(e)))
  const outside = outsideCode({ all: files, sourceRoots: config.sourceRoots, extensions: config.extensions, exclude: isTest })
  const contents = [...sources, ...outside].map((path) => ({ path, content: readFile(path) }))
  const { globs, unresolved } = findGlobImports({ files: contents, aliases: config.aliases })
  const reviewed = (l) => config.reviewedDynamicLoads.some((r) => matchesReview(r, l))

  const checks = [
    ...globs
      .filter((g) => !g.resolved.startsWith('!'))
      .map((g) => ({ test: (p) => globToRegExp(g.resolved).test(p), why: `${g.from}:${g.line} 的 import.meta.glob('${g.pattern}')` })),
    ...unresolved
      .filter((u) => !reviewed({ from: u.from, expr: u.expr }))
      .map((u) => ({ test: (p) => inScope(p, wideScope('', u.regex)), why: `${u.from}:${u.line} 的 ${u.expr}（换算不了，按模式匹配）` })),
    ...findDynamicLoads({ files: contents, aliases: config.aliases })
      .filter((l) => !reviewed(l))
      .map((l) => ({ test: (p) => inScope(p, l.scope), why: `${l.from}:${l.line} 的 ${l.expr}` }))
  ]
  return (path) => {
    const hits = checks.filter((c) => c.test(path)).map((c) => c.why)
    return hits.length > 0 ? `会被 ${hits.join('、')} 重新加载` : null
  }
}
