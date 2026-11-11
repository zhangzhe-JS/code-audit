/**
 * exports 子命令：导出维度。从入口走得到的文件里，找出没人用的导出，判定状态、写明依据和建议
 *
 * 用法：
 *   code-audit exports --root <仓库> --profile <配置> [--out <exports.json>] [--history] [--rev <提交>] [--project <项目名>] [--knip <目录>]
 *
 * 只读：分析的是提交里的文件，导出到系统临时目录；输出不能写在被分析的仓库里
 */
import { parseArgs } from 'node:util'
import { basename, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, writeFileSafely } from '../core/output.js'
import { scanExports, EXPORT_STATUSES } from '../exports/scan.js'
import { traceExportsHistory } from '../exports/report.js'
import { addBundlerEvidence } from '../exports/bundler.js'

const USAGE = `用法：code-audit exports --root <仓库> --profile <配置> [选项]

从入口走得到的文件里，找出没人用的导出：
  internal（只去掉 export）、dead（删掉声明）、dead-only-ref（跟着一起删）、test-only（只有测试在用），
  以及要保留的 unknown / external / pending / dormant。每条写明依据和建议。

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填）：至少要有 entries、aliases；写了 testEntries 才能区分「只有测试在用」
  --out      结果写到这个文件；不传就打印出来。不能写在被分析的仓库里，文件不能已存在
  --history  查历史：没人用的导出在哪个提交失去了外部引用；从没被引用过的查定义提交
  --verify   在临时目录里跑一次构建（verify 的基线，有缓存就复用），用 tree-shaking 的结果核对：
             构建保留了的导出不判没人用（改判 unknown），摇掉了的记成佐证。要在 profile 的 verify 里写 build 和 bundler
  --fresh    和 --verify 一起用：不用基线缓存
  --rev      分析哪个提交，默认 HEAD
  --project  写进结果的项目名，默认取仓库目录名
  --knip     knip 的安装目录；不传时用 code-audit 自己安装的 knip
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { root: { type: 'string' }, profile: { type: 'string' }, out: { type: 'string' }, rev: { type: 'string' }, project: { type: 'string' }, knip: { type: 'string' }, history: { type: 'boolean' }, verify: { type: 'boolean' }, fresh: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }
  if (values.help) return console.log(USAGE)
  if (!values.profile) return fail(`缺少 --profile\n\n${USAGE}`)
  const root = resolve(values.root ?? '.')
  try {
    const config = await loadProfile(values.profile)
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件，请换一个文件名）`)
    }
    const result = scanExports({ root, project: values.project ?? basename(root), config, rev: values.rev, knipDir: values.knip })
    if (values.verify) {
      const r = await addBundlerEvidence({ root, result, config, useCache: !values.fresh, log: (m) => console.error(m) })
      console.error(r.reason ? `没有 tree-shaking 证据：${r.reason}` : `tree-shaking 证据：构建记录了 ${r.applied} 个文件的导出，${r.raised} 个候选构建里保留着、改判 unknown`)
    }
    if (values.history) {
      const t0 = Date.now()
      traceExportsHistory({ root, result, config, progress: (i, n) => process.stderr.write(`\r查历史 ${i}/${n}`) })
      process.stderr.write(`\r查历史：完成，用时 ${Math.round((Date.now() - t0) / 1000)} 秒\n`)
    }
    const s = result.summary
    console.error(`分析提交 ${result.project.rev}（工作区没提交的改动不算）`)
    console.error(`没人用的导出 ${s.candidates} 个，在 ${s.files} 个文件里`)
    console.error(`  状态：${EXPORT_STATUSES.filter((k) => s.byStatus[k]).map((k) => `${k} ${s.byStatus[k]} 个`).join('，') || '无'}`)
    if (!s.testEntries) console.error('  注意：profile 没写 testEntries，只有测试在用的导出会判成没人用')
    console.error(`  没合并的分支：查了 ${s.branches.checked} 个（只读本地已有的分支，不 fetch）`)
    const json = `${JSON.stringify(result, null, 2)}\n`
    if (values.out) {
      writeFileSafely(values.out, json)
      console.error(`结果写入：${resolve(values.out)}`)
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
