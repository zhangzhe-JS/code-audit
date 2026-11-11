/**
 * exports-report 子命令：从 exports 的结果生成 report.md 和 exports.csv
 *
 * 用法：code-audit exports-report --in <exports.json> --out <目录>
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { assertEmptyDir, readJson, writeDirSafely } from '../core/output.js'
import { exportsCsv, exportsMarkdown, validateExportsResult } from '../exports/report.js'

const USAGE = `用法：code-audit exports-report --in <exports.json> --out <目录>

从 code-audit exports 的结果生成 report.md（按状态分组、写明建议）和 exports.csv（Excel 直接打开）。`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { in: { type: 'string' }, out: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }
  if (values.help) return console.log(USAGE)
  if (!values.in || !values.out) return fail(`缺少 --in 或 --out\n\n${USAGE}`)
  try {
    assertEmptyDir(values.out)
    const r = readJson(values.in)
    const errors = validateExportsResult(r)
    if (errors.length > 0) throw new Error(`结果格式不对，没有生成报告：\n  - ${errors.slice(0, 20).join('\n  - ')}`)
    writeDirSafely(values.out, [{ path: 'report.md', content: exportsMarkdown(r) }, { path: 'exports.csv', content: exportsCsv(r) }])
    console.error(`已生成：${resolve(values.out)}（report.md、exports.csv）`)
  } catch (e) {
    fail(e.message)
  }
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
