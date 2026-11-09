/**
 * scan 子命令：找出从入口走不到的文件，输出候选清单（交给 history --in）
 *
 * 用法：
 *   code-audit scan --root <仓库> --profile <配置> [--out <候选清单.json>] [--rev <提交>] [--project <项目名>] [--knip <目录>]
 *
 * 只读：分析的是提交里的文件，导出到系统临时目录，knip 的配置也写在那里；输出不能写在被分析的仓库里
 */
import { parseArgs } from 'node:util'
import { basename, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, writeFileSafely } from '../core/output.js'
import { scan } from '../collect/scan.js'

const USAGE = `用法：code-audit scan --root <仓库> --profile <配置> [选项]

找出从入口走不到的文件，输出候选清单，再交给 history --in 查历史。
用 knip 分析（code-audit 的可选依赖），再由规则层判定状态。
规则还没做完：目前判定动态加载（unknown）、图外使用（external），其余候选暂时也是 unknown，证据里有说明。
分析的是提交里的代码，工作区没提交的改动不算；提交号写进候选清单，history 默认查同一个提交。

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填）：至少要写 entries（项目入口）；
             还可以写 testEntries（测试入口）、aliases（路径别名）、scanIgnore（不列为候选的文件）
  --out      候选清单写到这个文件；不传就打印出来。不能写在被分析的仓库里，文件不能已存在
  --rev      分析哪个提交，默认 HEAD
  --project  写进候选清单的项目名，默认取仓库目录名
  --knip     knip 的安装目录；不传时用 code-audit 自己安装的 knip
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        profile: { type: 'string' },
        out: { type: 'string' },
        rev: { type: 'string' },
        project: { type: 'string' },
        knip: { type: 'string' },
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
  // 入口没有默认值，所以 profile 必填：没有它就不知道从哪里开始分析
  if (!values.profile) return fail(`缺少 --profile（至少要在配置里写 entries）\n\n${USAGE}`)

  const root = resolve(values.root ?? '.')
  try {
    const config = await loadProfile(values.profile)

    // 先检查输出位置再开始分析，避免分析完才发现写不进去
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) {
        throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件，请换一个文件名）`)
      }
    }

    const { candidates, summary } = scan({
      root,
      project: values.project ?? basename(root),
      config,
      rev: values.rev,
      knipDir: values.knip
    })
    const json = `${JSON.stringify(candidates, null, 2)}\n`

    // 统计写到 stderr：stdout 只放数据，方便用管道交给别的程序
    printSummary(summary)
    if (values.out) {
      writeFileSafely(values.out, json)
      console.error(`候选清单写入：${resolve(values.out)}`)
    } else {
      process.stdout.write(json)
    }
  } catch (e) {
    fail(e.message)
  }
}

function printSummary(s) {
  const c = s.counts
  console.error(`分析提交 ${s.rev}（工作区没提交的改动不算）`)
  console.error(`knip ${s.engine.version}：从入口走不到 ${c.unused} 个文件`)
  console.error(`  列为候选 ${c.candidates} 个（其中只有测试用到 ${c.testOnly} 个）`)
  console.error(`  状态：${Object.entries(c.byStatus).map(([k, v]) => `${k} ${v} 个`).join('，') || '无'}`)
  if (c.skippedTests > 0) console.error(`  跳过测试文件 ${c.skippedTests} 个`)
  if (c.skippedIgnored > 0) console.error(`  跳过 scanIgnore 匹配的 ${c.skippedIgnored} 个`)
  if (s.outside.length > 0) {
    console.error(`  跳过不在源码目录、或扩展名不在配置里的 ${s.outside.length} 个：`)
    for (const f of s.outside) console.error(`    - ${f}`)
  }
  if (s.globs.length > 0) {
    console.error(`  import.meta.glob 换算成入口 ${s.globs.length} 处：`)
    for (const g of s.globs) console.error(`    - ${g.from}:${g.line}  ${g.pattern} → ${g.resolved}`)
  }
  if (s.dynamicLoads > 0) console.error(`  拼接路径的动态加载 ${s.dynamicLoads} 处，落在范围里的候选判为 unknown`)
  if (s.warnings.length > 0) {
    console.error(`  注意 ${s.warnings.length} 处：`)
    for (const w of s.warnings) console.error(`    - ${w.from}:${w.line}  ${w.detail}`)
  }
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
