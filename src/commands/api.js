/**
 * api 子命令：接口维度。列出项目定义的每个接口（方法 + 路径），判断在不在用，并输出覆盖报告
 *
 * 用法：
 *   code-audit api --root <仓库> --profile <配置> [--out <api.json>] [--rev <提交>] [--project <项目名>] [--knip <目录>]
 *
 * 只读：分析的是提交里的文件，导出到系统临时目录；输出不能写在被分析的仓库里
 */
import { parseArgs } from 'node:util'
import { basename, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, writeFileSafely } from '../core/output.js'
import { scanApi } from '../api/scan.js'
import { traceApiHistory } from '../api/history.js'

const USAGE = `用法：code-audit api --root <仓库> --profile <配置> [选项]

列出项目里定义的每个接口（方法 + 路径），判断在不在用，每条结论写明依据。
请求是怎么发出去的写在 profile 的 api 里（见 profiles/example.js），规则可以由模型生成、人审核。
同时输出覆盖报告：像请求却没有规则命中的调用、算不出地址的定义，用来补规则。

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填）：要有 entries、aliases 和 api 规则
  --out      结果写到这个文件；不传就打印出来。不能写在被分析的仓库里，文件不能已存在
  --rev      分析哪个提交，默认 HEAD
  --project  写进结果的项目名，默认取仓库目录名
  --knip     knip 的安装目录；不传时用 code-audit 自己安装的 knip
  --history  给没人用的接口查 git 历史：什么时候、哪个提交、为什么不再调用；从没调用过的查定义时间
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
        history: { type: 'boolean' },
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
  if (!values.profile) return fail(`缺少 --profile\n\n${USAGE}`)

  const root = resolve(values.root ?? '.')
  try {
    const config = await loadProfile(values.profile)
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件，请换一个文件名）`)
    }
    const result = scanApi({ root, project: values.project ?? basename(root), config, rev: values.rev, knipDir: values.knip })
    if (values.history) {
      const t0 = Date.now()
      traceApiHistory({ root, result, config, progress: (i, n) => process.stderr.write(`\r查历史 ${i}/${n}`) })
      process.stderr.write(`\r查历史：完成，用时 ${Math.round((Date.now() - t0) / 1000)} 秒\n`)
    }
    printSummary(result)
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

function printSummary(r) {
  console.error(`分析提交 ${r.project.rev}（工作区没提交的改动不算），规则版本 ${r.rules.version}`)
  console.error(`解析 ${r.summary.files} 个源码文件，接口 ${r.summary.endpoints} 个`)
  console.error(`  状态：${Object.entries(r.summary.byStatus).map(([k, v]) => `${k} ${v} 个`).join('，') || '无'}`)
  const c = r.coverage
  const show = (title, list, fmt, hint) => {
    if (list.length === 0) return
    console.error(`  ${title} ${list.length} 处${hint ? `（${hint}）` : ''}：`)
    for (const x of list.slice(0, 30)) console.error(`    - ${fmt(x)}`)
    if (list.length > 30) console.error(`    …… 还有 ${list.length - 30} 处，见输出文件的 coverage`)
  }
  console.error('覆盖报告：')
  show('像请求、但没有规则命中的调用', c.suspects, (x) => `${x.from}:${x.line} ${x.shape}  ${x.text}`, '补进 api.calls，或确认不是请求后写进 api.ignoreCalls')
  show('地址由参数传入的封装函数', c.wrappers, (x) => `${x.from}:${x.line} ${x.fn}（参数 ${x.param}）`, '把这个函数的写法加进 api.calls，调用它的地方才认得出')
  show('算不出地址的定义', c.dynamic, (x) => `${x.from}:${x.line} ${x.fn}  ${x.raw ?? '(整个是变量)'}`, '确认是哪个接口后写进 api.manual，不是固定接口的写进 api.reviewedDynamic')
  show('解析失败的文件', c.parseErrors, (x) => `${x.from}  ${x.message}`)
  show('没用上的 api.manual', c.unusedManual, (x) => `${x.from} ${x.fn}`, '代码改了？')
  show('没用上的 api.reviewedDynamic', c.unusedReviewed, (x) => `${x.from} ${x.fn}`, '代码改了？')
  if (r.historyTraced) {
    const dead = r.endpoints.filter((e) => ['dead', 'dead-only-ref'].includes(e.status))
    const lost = dead.filter((e) => e.history?.type === 'lost')
    const never = dead.filter((e) => e.history?.type === 'never')
    const weak = lost.filter((e) => e.history.weak)
    console.error(`历史：没人用的 ${dead.length} 个里，查到失去引用的提交 ${lost.length} 个（其中只按名字匹配的 ${weak.length} 个），从没被调用过 ${never.length} 个，没查到 ${dead.length - lost.length - never.length} 个`)
  }
  const total = c.suspects.length + c.wrappers.length + c.dynamic.length + c.parseErrors.length
  if (total === 0) console.error('  没有需要补的规则')
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
