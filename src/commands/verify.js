/**
 * verify 子命令：在临时目录里实际删掉候选文件，跑构建、测试，和基线比较
 *
 * 两种用法：
 *   code-audit verify --root <仓库> --profile <配置>                       试跑基线：确认配置的命令能在临时目录里无人值守跑通
 *   code-audit verify --root <仓库> --profile <配置> --in <data.json> --out <结果.json>
 *                                                                         删掉 dead / dead-only-ref 后和基线比较，结果写进数据
 *
 * 只读：代码导出到系统临时目录，依赖克隆一份，构建、测试都在那里跑；目标仓库不写任何东西
 */
import { parseArgs } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, readJson, writeFileSafely } from '../core/output.js'
import { MAX_ROUNDS, verifyReport } from '../verify/index.js'
import { git } from '../history/git.js'
import { createWorkspace } from '../verify/workspace.js'
import { describe, prepareBaseline } from '../verify/baseline.js'
import { tail } from '../verify/run-command.js'

const USAGE = `用法：
  code-audit verify --root <仓库> --profile <配置>                          试跑基线
  code-audit verify --root <仓库> --profile <配置> --in <数据> --out <结果>  删掉候选后和基线比较

在临时目录里跑项目的构建、测试。
- 试跑基线：确认配置的命令能无人值守跑通
- 带 --in：把 dead、dead-only-ref 实际删掉再跑，和基线比较。全部通过一般只要 2 轮；
  不通过时先从报错里认出是哪些文件，认不出再对半找（最多 ${MAX_ROUNDS} 轮）。
  删了会出问题的，状态改为 unknown，证据写上出了什么问题
- 基线结果按提交、命令、依赖缓存起来，重跑时直接复用（试跑基线也会存）；加 --fresh 不用缓存
- 配置了 verify.bundler 时，基线构建顺便记下打包器加载过的模块：静态分析说用不到、构建却加载了的，判 unknown，不删

会执行项目自己的命令（构建脚本等）：只在系统临时目录里的拷贝上跑，依赖克隆一份，不碰原项目。

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填），要写 verify 的命令，如：
               verify: { build: 'npm run build', test: 'npm test', bundler: 'vite' }
             命令必须能无人值守跑完；超时默认 30 分钟，可以写 timeoutSeconds
             bundler 可选（vite、webpack、vue-cli），配置文件不在默认位置时写 bundlerConfig
  --in       history 输出的数据（data.json）；用数据里记录的提交
  --out      结果写到这个文件；不传就打印出来。不能写在被分析的仓库里，文件不能已存在
  --rev      试跑基线时用哪个提交，默认 HEAD（带 --in 时用数据里的提交）
  --fresh    不复用缓存的基线，重跑一遍（构建受环境变量影响、或怀疑缓存不对时用）
  --keep     试跑基线时跑完不删临时目录（排查用），会打印路径
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        profile: { type: 'string' },
        rev: { type: 'string' },
        in: { type: 'string' },
        out: { type: 'string' },
        keep: { type: 'boolean' },
        fresh: { type: 'boolean' },
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
  if (!values.profile) return fail(`缺少 --profile（要在配置里写 verify 的命令）\n\n${USAGE}`)

  const root = resolve(values.root ?? '.')
  if (values.in) {
    if (values.rev) return fail('带 --in 时用数据里记录的提交，不能再传 --rev')
    if (values.keep) return fail('--keep 只用于试跑基线')
    return verifyData(root, values)
  }
  if (values.out) return fail('--out 要和 --in 一起用')
  const rev = values.rev ?? 'HEAD'
  let ws = null
  try {
    const config = await loadProfile(values.profile)
    if (!config.verify.build && !config.verify.test) {
      throw new Error(`配置里没有写 verify 的命令。命令没有默认值：各项目不同，猜错了就是乱跑。\n${suggestScripts(root, rev)}`)
    }

    const log = (msg) => console.error(msg)
    log('准备临时目录：导出代码、克隆依赖…')
    const started = Date.now()
    ws = createWorkspace({ root, rev })
    log(`  提交 ${ws.commit}，${ws.files} 个文件，用时 ${Math.round((Date.now() - started) / 1000)} 秒`)
    if (ws.deps.length === 0) log('  没有找到 node_modules：原项目没装依赖的话，构建多半会失败')
    for (const d of ws.deps) log(`  依赖 ${d.dir || '.'}/node_modules：${d.method === 'clone' ? '克隆（不占额外磁盘）' : '复制'}`)

    const logDir = join(dirname(ws.dir), 'logs')
    // 试跑就是要真跑一遍：不读缓存，跑通了照样存起来，接下来带 --in 时直接复用
    const base = await prepareBaseline({ root, ws, verify: config.verify, useCache: false, logDir, log })
    const results = base.results
    if (config.verify.bundler) {
      log(base.bundlerDropped
        ? `没有打包器证据：${base.bundlerDropped}，已撤掉重跑`
        : base.modules
          ? `打包器（${config.verify.bundler}）记录了 ${base.builds} 次构建，加载了 ${base.modules.size} 个源码文件`
          : '没拿到打包器的模块列表：构建没有经过套好的配置（构建命令用了别的配置文件？可以在 verify.bundlerConfig 里写上）')
    }

    const failed = Object.entries(results).filter(([, r]) => !r.ok)
    for (const [step, r] of failed) {
      log(`\n${step} 的最后 30 行：\n${tail(r.output)}`)
    }
    if (failed.length === 0) {
      log('\n基线正常：配置的命令都能在临时目录里跑通（结果已缓存，接下来带 --in 验证时直接复用）')
    } else {
      log(`\n基线有 ${failed.length} 步没通过（${failed.map(([s, r]) => `${s} ${describe(r)}`).join('、')}）`)
      log('删文件以后对比时，基线本来就失败的步骤看不出删文件有没有影响。先确认命令写得对、能无人值守跑完')
      process.exitCode = 1
    }
    if (values.keep) log(`\n临时目录保留在：${dirname(ws.dir)}（代码在 tree/，完整输出在 logs/）`)
  } catch (e) {
    fail(e.message)
  } finally {
    if (ws && !values.keep) ws.cleanup()
  }
}

/** 带 --in：删掉候选后和基线比较 */
async function verifyData(root, values) {
  try {
    const config = await loadProfile(values.profile)
    if (!config.verify.build && !config.verify.test) {
      throw new Error(`配置里没有写 verify 的命令。命令没有默认值：各项目不同，猜错了就是乱跑。\n${suggestScripts(root, 'HEAD')}`)
    }
    // 先检查输出位置再开始：跑一遍要几分钟，别跑完才发现写不进去
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件，请换一个文件名）`)
    }
    const started = Date.now()
    const log = (msg) => console.error(msg)
    const { data, summary } = await verifyReport({ data: readJson(values.in), root, config, log, useCache: !values.fresh })
    const json = `${JSON.stringify(data, null, 2)}\n`

    log(`\n验证了 ${summary.targets} 个文件，共 ${summary.rounds} 轮，用时 ${Math.round((Date.now() - started) / 60000)} 分钟`)
    if (summary.baselineCachedAt) log('  基线复用了缓存')
    if (summary.bundlerDropped) log(`  没有打包器证据：${summary.bundlerDropped}`)
    if (summary.contradicted?.length > 0) {
      log(`  构建加载过、和静态分析矛盾（状态改为 unknown）：${summary.contradicted.length} 个${summary.bundled.length > 0 ? `，其中 ${summary.bundled.length} 个要删的不删` : ''}`)
      for (const f of summary.contradicted) log(`    - ${f}`)
    }
    log(`  删掉后和基线一致：${summary.passed} 个`)
    if (summary.failed > 0) {
      log(`  删了会出问题（状态改为 unknown）：${summary.failed} 个`)
      for (const b of summary.bad ?? []) log(`    - ${b.files.join('、')}：${b.problems.join('、')}`)
    }
    if (summary.unverified > 0) log(`  轮数用完还没确认（未验证）：${summary.unverified} 个`)
    if (summary.newWarnings?.length > 0) {
      log(`  删掉后新增的构建警告 ${summary.newWarnings.length} 条（不算失败，请人工看一下）：`)
      for (const w of summary.newWarnings.slice(0, 10)) log(`    - ${w}`)
    }
    if (values.out) {
      writeFileSafely(values.out, json)
      log(`结果写入：${resolve(values.out)}`)
    } else {
      process.stdout.write(json)
    }
  } catch (e) {
    fail(e.message)
  }
}

/** 没写命令时，把 package.json 里像构建、测试的脚本列出来，供挑选 */
export function suggestScripts(root, rev) {
  let scripts = {}
  try {
    scripts = JSON.parse(git(root, ['show', `${rev}:package.json`])).scripts ?? {}
  } catch {
    return '在 profile 里写上，如 verify: { build: "npm run build", test: "npm test" }'
  }
  const names = Object.keys(scripts).filter((n) => /build|test/i.test(n))
  if (names.length === 0) return 'package.json 里没有找到 build、test 相关的脚本，请在 profile 里写上要跑的命令'
  return (
    'package.json 里可能用得上的脚本（要选不会停下来等人输入的）：\n' +
    names.map((n) => `  - ${n}：${scripts[n]}`).join('\n') +
    '\n在 profile 里写上，如 verify: { build: "npm run <脚本名>", test: "npm test" }'
  )
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
