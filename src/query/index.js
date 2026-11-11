/**
 * 在已经生成好的结果里查（code-audit api / exports 的 JSON），命令行 query 和 MCP 共用
 *
 * - apiImpact      一个接口在各项目的状态、使用菜单、引用方、定义位置、停用历史
 * - similarApis    路径相似的接口（新增接口前先查有没有现成的）
 * - searchApis     路径里含某段文字的接口
 * - fileInfo       一个文件里定义了哪些接口、有哪些没人用的导出
 *
 * 只读结果文件，不跑分析：结果是什么时候生成的、基于哪个提交，都写在返回值里，调用方自己判断新不新
 */
import { readJson } from '../core/output.js'
import { validateApiResult } from '../api/report.js'
import { validateExportsResult } from '../exports/report.js'
import { normalizePath, endpointKey } from '../api/normalize.js'
import { similarity } from '../api/similar.js'

/**
 * 读结果文件，按类型分开；格式不对的直接报错
 * @param {string[]} files
 * @returns {{apis: object[], exports: object[]}}
 */
export function loadIndex(files) {
  const apis = []
  const exportsList = []
  for (const f of files) {
    const r = readJson(f)
    const errs = r?.kind === 'exports' ? validateExportsResult(r) : validateApiResult(r)
    if (errs.length > 0) throw new Error(`${f} 不是有效的 code-audit 结果：\n  - ${errs.slice(0, 5).join('\n  - ')}`)
    ;(r.kind === 'exports' ? exportsList : apis).push(r)
  }
  return { apis, exports: exportsList }
}

/** 接口写法转成标识：「GET /a/b」「/a/b」（不写方法就所有方法）「GET /api/a/${id}?x=1」都行 */
export function parseApi(text) {
  const m = /^\s*([A-Za-z]+)\s+(\S+)\s*$/.exec(text)
  const method = m ? m[1].toUpperCase() : null
  const raw = (m ? m[2] : text.trim()).replace(/\$\{[^}]*\}/g, '{}').replace(/\{[^}]*\}/g, '{}')
  const path = normalizePath(raw)
  if (path === null) throw new Error(`看不出是哪个接口：${text}`)
  return { method, path }
}

const source = (r) => ({ project: r.project.name, rev: r.project.rev, generatedAt: r.generatedAt })

/**
 * @param {{apis: object[]}} index
 * @param {string} text 接口，如 "GET /template/v2/{}"
 */
export function apiImpact(index, text) {
  const { method, path } = parseApi(text)
  const matches = []
  for (const r of index.apis) {
    for (const e of r.endpoints) {
      if (e.path !== path || (method && e.method !== method)) continue
      matches.push({
        ...source(r),
        key: e.key,
        status: e.status,
        menus: e.menus ?? null,
        callers: e.callers.map((c) => c.from),
        definitions: e.definitions.map((d) => ({ file: d.file, line: d.line, fn: d.fn, state: d.state })),
        history: e.history ?? null,
        evidence: e.evidence.map((x) => x.detail)
      })
    }
  }
  const key = method ? endpointKey(method, path) : path
  const liveIn = [...new Set(matches.filter((m) => m.status === 'live').map((m) => m.project))]
  return {
    query: key,
    found: matches.length > 0,
    liveIn,
    verdict: matches.length === 0 ? '给出的项目里都没有这个接口' : liveIn.length > 0 ? `在用：${liveIn.join('、')}（不能删；改它要看这些项目）` : '给出的项目里都没人用（删之前看网关日志，小批量处理）',
    matches,
    sources: index.apis.map(source)
  }
}

/**
 * @param {{apis: object[]}} index
 * @param {string} text 接口或路径
 * @param {{limit?: number, min?: number}} [opts]
 */
export function similarApis(index, text, { limit = 10, min = 0.4 } = {}) {
  const { method, path } = parseApi(text)
  const seen = new Map()
  for (const r of index.apis) {
    for (const e of r.endpoints) {
      if (method && e.method !== method) continue
      const score = similarity(path, e.path)
      if (score < min) continue
      const cur = seen.get(e.key) ?? { key: e.key, score, projects: [] }
      cur.projects.push({ project: r.project.name, status: e.status, menus: e.menus ?? null })
      seen.set(e.key, cur)
    }
  }
  return { query: method ? endpointKey(method, path) : path, results: [...seen.values()].sort((a, b) => b.score - a.score || a.key.localeCompare(b.key)).slice(0, limit) }
}

/**
 * @param {{apis: object[]}} index
 * @param {string} text 路径里的一段文字（不分大小写）
 */
export function searchApis(index, text, { limit = 50 } = {}) {
  const q = text.trim().toLowerCase()
  if (!q) throw new Error('搜索的文字不能为空')
  const seen = new Map()
  for (const r of index.apis) {
    for (const e of r.endpoints) {
      if (!e.key.toLowerCase().includes(q)) continue
      const cur = seen.get(e.key) ?? { key: e.key, projects: [] }
      cur.projects.push({ project: r.project.name, status: e.status })
      seen.set(e.key, cur)
    }
  }
  const all = [...seen.values()].sort((a, b) => a.key.localeCompare(b.key))
  return { query: text, total: all.length, results: all.slice(0, limit) }
}

/**
 * @param {{apis: object[], exports: object[]}} index
 * @param {string} file 相对仓库根目录的路径
 * @param {string} [project] 只看这个项目
 */
export function fileInfo(index, file, project) {
  const want = (r) => !project || r.project.name === project
  const apis = []
  for (const r of index.apis.filter(want)) {
    for (const e of r.endpoints) {
      for (const d of e.definitions) if (d.file === file) apis.push({ project: r.project.name, key: e.key, status: e.status, fn: d.fn, line: d.line, menus: e.menus ?? null })
    }
  }
  const unusedExports = []
  for (const r of index.exports.filter(want)) {
    for (const c of r.items) if (c.file === file) unusedExports.push({ project: r.project.name, name: c.name, line: c.line, status: c.status, suggestion: c.suggestion })
  }
  return { file, apis, unusedExports }
}
