/**
 * history 子命令：查 git 历史（引入、引用时间线、失去引用），输出 JSON
 *
 * 两种用法：
 *   查单个文件：code-audit history --file <路径> [选项]
 *     输出这个文件的历史（pattern、用过的路径、history）
 *   批量查询：  code-audit history --in <候选清单.json> [--out <结果.json>] [选项]
 *     按候选清单逐个查，输出符合 schema 的完整数据，交给 report 命令生成报告
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { traceHistory } from '../history/index.js'
import { buildReport } from '../history/batch.js'
import { DEFAULT_CONFIG, loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, readJson, writeFileSafely } from '../core/output.js'

const USAGE = `用法：
  code-audit history --file <路径> [选项]            查单个文件
  code-audit history --in <候选清单> [--out <文件>]   批量查询，输出完整数据

选项：
  --file     目标文件，相对仓库根目录
  --in       候选清单（JSON），格式：
               { "project": "项目名", "entries": ["src/main.js"],
                 "files": [{ "file": "src/a.js", "pattern": "可选", "notes": ["可选"] }] }
  --out      批量查询的结果写到这个文件；不传就打印出来。不能写在被分析的仓库里
  --root     仓库目录，默认当前目录
  --pattern  查单个文件时，引用方代码里会出现的字符串，如 utils/math
             默认由文件最初的路径推出：去掉配置的源码根目录（默认 src）和扩展名
             移动过的文件会自动用旧路径；文件不在源码根目录下时必须手动指定
             批量查询时在候选清单里给每个文件单独写
  --rev      查到哪个提交为止，默认 HEAD
  --profile  项目配置文件，如 profiles/<项目名>.js；不传时使用默认配置
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        file: { type: 'string' },
        in: { type: 'string' },
        out: { type: 'string' },
        root: { type: 'string' },
        pattern: { type: 'string' },
        rev: { type: 'string' },
        profile: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (e) {
    // 不认识的参数等：报错 + 用法
    return fail(`${e.message}\n\n${USAGE}`)
  }

  if (values.help) {
    console.log(USAGE)
    return
  }

  // 两种用法的参数不能混用，混用时说清楚，不猜用户的意思
  if (values.file && values.in) return fail(`--file 和 --in 只能用一个\n\n${USAGE}`)
  if (!values.file && !values.in) return fail(`缺少 --file 或 --in\n\n${USAGE}`)
  if (values.in && values.pattern) return fail('批量查询时不能用 --pattern，请在候选清单里给每个文件单独写 pattern')
  if (values.file && values.out) return fail('--out 只用于批量查询（--in）')

  const root = resolve(values.root ?? '.')
  try {
    const config = values.profile ? await loadProfile(values.profile) : DEFAULT_CONFIG

    if (values.file) {
      const result = traceHistory({ root, file: values.file, pattern: values.pattern, rev: values.rev, config })
      console.log(JSON.stringify({ file: values.file, ...result }, null, 2))
      return
    }

    // 批量：先检查输出位置再开始查，避免查了半天才发现写不进去
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) {
        throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件，请换一个文件名）`)
      }
    }
    const report = buildReport({ root, candidates: readJson(values.in), rev: values.rev, config })
    const json = `${JSON.stringify(report, null, 2)}\n`

    if (values.out) {
      writeFileSafely(values.out, json)
      // 提示写到 stderr：stdout 只放数据，方便用管道交给别的程序
      console.error(`已查询 ${report.items.length} 个文件，结果写入：${resolve(values.out)}`)
    } else {
      process.stdout.write(json)
    }
  } catch (e) {
    fail(e.message)
  }
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
