/**
 * query 子命令：在生成好的结果里查（code-audit api / exports 的 JSON）
 *
 * 用法：
 *   code-audit query (--in <结果.json>... | --dir <结果目录>) (--api <接口> | --similar <接口> | --search <文字> | --file <路径> [--project <项目>]) [--json]
 */
import { parseArgs } from 'node:util'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { loadIndex, apiImpact, similarApis, searchApis, fileInfo } from '../query/index.js'

const USAGE = `用法：code-audit query (--in <结果.json>... | --dir <目录>) <查什么> [--json]

在 code-audit api / exports 生成的结果里查（不重新分析；结果基于哪个提交会一起列出）。

查什么（选一个）：
  --api <接口>      这个接口在各项目在不在用、哪些菜单在用、引用方、定义位置、停用历史。如 "GET /template/v2/{}"，不写方法就查所有方法
  --similar <接口>  路径相似的接口（新增接口前先查有没有现成的）
  --search <文字>   路径里含这段文字的接口
  --file <路径>     这个文件里定义的接口、没人用的导出（--project 只看一个项目）

选项：
  --in    结果文件，可以写多次
  --dir   结果目录：读里面所有 .json
  --json  输出 JSON（给程序用）
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { in: { type: 'string', multiple: true }, dir: { type: 'string' }, api: { type: 'string' }, similar: { type: 'string' }, search: { type: 'string' }, file: { type: 'string' }, project: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }
  if (values.help) return console.log(USAGE)
  const asks = ['api', 'similar', 'search', 'file'].filter((k) => values[k] !== undefined)
  if (asks.length !== 1) return fail(`要在 --api、--similar、--search、--file 里选一个\n\n${USAGE}`)
  try {
    const files = [...(values.in ?? []), ...(values.dir ? readdirSync(values.dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(values.dir, f)) : [])]
    if (files.length === 0) throw new Error('没有结果文件：用 --in 或 --dir 指定 code-audit api / exports 的结果')
    const index = loadIndex(files)
    const ask = asks[0]
    const result = ask === 'api' ? apiImpact(index, values.api) : ask === 'similar' ? similarApis(index, values.similar) : ask === 'search' ? searchApis(index, values.search) : fileInfo(index, values.file, values.project)
    if (values.json) return process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    process.stdout.write(`${render(ask, result)}\n`)
  } catch (e) {
    fail(e.message)
  }
}

function render(ask, r) {
  const out = []
  if (ask === 'api') {
    out.push(`${r.query}：${r.verdict}`)
    for (const m of r.matches) {
      out.push(`- ${m.project}（提交 ${m.rev.slice(0, 8)}）${m.key}：${m.status}${m.menus?.length ? `，菜单：${m.menus.join('、')}` : ''}`)
      for (const d of m.definitions) out.push(`    定义 ${d.file}:${d.line} ${d.fn}（${d.state}）`)
      if (m.callers.length) out.push(`    引用方 ${m.callers.length} 个：${m.callers.slice(0, 5).join('、')}${m.callers.length > 5 ? ' …' : ''}`)
      if (m.history) {
        const h = m.history
        const c = h.type === 'never' ? h.introduced : h.commitFrom ?? h.commit
        out.push(`    ${h.type === 'never' ? '从没被调用，定义于' : '停用于'} ${c.date} ${c.hash.slice(0, 8)} ${c.author}：${c.subject}`)
      }
    }
  } else if (ask === 'similar') {
    out.push(`和 ${r.query} 相似的接口：${r.results.length === 0 ? '没有' : ''}`)
    for (const x of r.results) out.push(`- ${x.key}（相似度 ${x.score.toFixed(2)}）：${x.projects.map((p) => `${p.project} ${p.status}`).join('；')}`)
  } else if (ask === 'search') {
    out.push(`路径含「${r.query}」的接口 ${r.total} 个${r.total > r.results.length ? `（只列前 ${r.results.length} 个）` : ''}：`)
    for (const x of r.results) out.push(`- ${x.key}：${x.projects.map((p) => `${p.project} ${p.status}`).join('；')}`)
  } else {
    out.push(`${r.file}：定义的接口 ${r.apis.length} 个，没人用的导出 ${r.unusedExports.length} 个`)
    for (const a of r.apis) out.push(`- 接口 ${a.key}（${a.project}）：${a.status}，${a.fn}:${a.line}${a.menus?.length ? `，菜单：${a.menus.join('、')}` : ''}`)
    for (const e of r.unusedExports) out.push(`- 导出 ${e.name}:${e.line ?? ''}（${e.project}）：${e.status}，${e.suggestion}`)
  }
  return out.join('\n')
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
