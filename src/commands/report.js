/**
 * report 子命令：从 history（以后是 scan）生成的完整数据，输出排查报告、隔离清单、头注释
 *
 * 用法：
 *   code-audit report --in <数据.json> --out <输出目录> [--profile <配置>] [--moved-at <日期>] [--branch <分支>]
 *
 * 只读输入、只写输出目录：输出目录不能在被分析的仓库里，并且必须不存在或为空
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { DEFAULT_CONFIG, loadProfile } from '../core/config.js'
import { assertOutsideRepo, assertEmptyDir, readJson, writeDirSafely } from '../core/output.js'
import { buildOutputs } from '../report/outputs.js'

const USAGE = `用法：code-audit report --in <数据.json> --out <输出目录> [选项]

生成三样东西：
  report.md            排查报告：概况、状态汇总、清单、每项详情
  quarantine-table.md  隔离清单表格
  headers/<路径>.txt   每个文件的头注释（没有历史或不能写注释的文件会跳过，并说明原因）

选项：
  --in        完整数据，即 history --in 输出的 JSON（必填）
  --out       输出目录（必填）。必须不存在或为空，并且不能在被分析的仓库里
  --profile   项目配置文件，决定文案、表格列、注释格式等；不传时使用默认配置
  --moved-at  头注释里写的移入日期，格式 YYYY-MM-DD；不传就不写这一行
  --branch    头注释里写的分支名，和 --moved-at 一起用
  -h, --help  显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        in: { type: 'string' },
        out: { type: 'string' },
        profile: { type: 'string' },
        'moved-at': { type: 'string' },
        branch: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }

  if (values.help) {
    console.log(USAGE)
    return
  }
  if (!values.in) return fail(`缺少 --in\n\n${USAGE}`)
  if (!values.out) return fail(`缺少 --out\n\n${USAGE}`)

  const movedAt = values['moved-at']
  if (movedAt !== undefined && !isValidDate(movedAt)) return fail(`--moved-at 格式应为 YYYY-MM-DD：${movedAt}`)
  if (values.branch !== undefined && movedAt === undefined) return fail('--branch 要和 --moved-at 一起用')

  try {
    const config = values.profile ? await loadProfile(values.profile) : DEFAULT_CONFIG
    const report = readJson(values.in)

    // 先在内存里生成全部内容（会校验数据），成功后才检查输出目录、开始写盘
    const { files, skipped } = buildOutputs(report, { config, movedAt, branch: values.branch })

    const outDir = resolve(values.out)
    assertOutsideRepo(outDir, report.project.root)
    assertEmptyDir(outDir)

    // 先写到临时目录，全部写完再改名成输出目录：中途出错不会留下写了一半的结果
    writeDirSafely(outDir, files)

    const headers = files.length - 2
    console.log(`已生成：${outDir}`)
    console.log('  report.md、quarantine-table.md')
    console.log(`  头注释 ${headers} 个（headers/）`)
    if (skipped.length > 0) {
      console.log(`  跳过 ${skipped.length} 个：`)
      for (const s of skipped) console.log(`    - ${s.id}：${s.reason}`)
    }
  } catch (e) {
    fail(e.message)
  }
}

/** YYYY-MM-DD，并且是真实存在的日期（2026-02-30 不行） */
function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
