/**
 * verify 子命令：在临时目录里实际删掉候选文件，跑构建、测试，和基线比较
 *
 * 现在支持：
 *   code-audit verify --root <仓库> --profile <配置>     试跑基线：确认配置的命令能在临时目录里无人值守跑通
 * 下一步支持：
 *   --in <data.json> --out <结果.json>                   删掉候选后对比
 *
 * 只读：代码导出到系统临时目录，依赖克隆一份，构建、测试都在那里跑；目标仓库不写任何东西
 */
import { parseArgs } from 'node:util'
import { dirname, join, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { git } from '../history/git.js'
import { createWorkspace } from '../verify/workspace.js'
import { describe, runSteps } from '../verify/baseline.js'
import { tail } from '../verify/run-command.js'

const USAGE = `用法：code-audit verify --root <仓库> --profile <配置> [选项]

在临时目录里跑项目的构建、测试。现在只支持试跑基线：确认配置的命令能无人值守跑通。

会执行项目自己的命令（构建脚本等）：只在系统临时目录里的拷贝上跑，依赖克隆一份，不碰原项目。

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填），要写 verify 的命令，如：
               verify: { build: 'npm run build', test: 'npm test' }
             命令必须能无人值守跑完；超时默认 30 分钟，可以写 timeoutSeconds
  --rev      用哪个提交，默认 HEAD
  --keep     跑完不删临时目录（排查用），会打印路径
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
        keep: { type: 'boolean' },
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
    const results = await runSteps({ cwd: ws.dir, verify: config.verify, logDir, log })

    const failed = Object.entries(results).filter(([, r]) => !r.ok)
    for (const [step, r] of failed) {
      log(`\n${step} 的最后 30 行：\n${tail(r.output)}`)
    }
    if (failed.length === 0) {
      log('\n基线正常：配置的命令都能在临时目录里跑通')
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
