/**
 * api-report 子命令：合并多个项目的 api 结果，按接口给出结论和风险分级（A 可删 / B 需审核 / C 保留或高风险）
 *
 * 用法：
 *   code-audit api-report --in a.json --in b.json --out <目录>
 *
 * 输出 report.md（给人看）和 endpoints.csv（UTF-8 带 BOM，Excel 直接打开，方便传给后端填处理意见）
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { assertEmptyDir, assertOutsideRepo, readJson, writeDirSafely } from '../core/output.js'
import { buildApiReport, toCsv, toMarkdown, VERDICTS } from '../api/report.js'

const USAGE = `用法：code-audit api-report --in <api.json> [--in <api.json> ...] --out <目录>

合并多个项目的 code-audit api 结果，按接口给出结论：
  在用 / C 保留（SDK）/ C 高风险 / B 需审核 / A 可删
输出 report.md 和 endpoints.csv（Excel 直接打开）。

选项：
  --in   code-audit api 的结果，可以写多次（每个项目一份）
  --out  输出目录：不存在或为空
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { in: { type: 'string', multiple: true }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }
  if (values.help) return console.log(USAGE)
  if (!values.in?.length || !values.out) return fail(`缺少 --in 或 --out\n\n${USAGE}`)
  try {
    const inputs = values.in.map((f) => readJson(f))
    for (const input of inputs) assertOutsideRepo(values.out, input.project.root)
    assertEmptyDir(values.out)
    const report = buildApiReport(inputs, values.in)
    writeDirSafely(values.out, [
      { path: 'report.md', content: toMarkdown(report) },
      { path: 'endpoints.csv', content: toCsv(report) }
    ])
    console.error(`接口 ${report.rows.length} 个：${VERDICTS.map((v) => `${v} ${report.rows.filter((r) => r.verdict === v).length}`).join('，')}`)
    console.error(`已生成：${resolve(values.out)}（report.md、endpoints.csv）`)
  } catch (e) {
    fail(e.message)
  }
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
