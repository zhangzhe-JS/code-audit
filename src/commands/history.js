/**
 * history 子命令：查一个文件的 git 历史（引入、引用时间线、失去引用），输出 JSON
 *
 * 用法：
 *   code-audit history --file <路径> [--root <仓库目录>] [--pattern <字符串>] [--rev <提交>] [--profile <配置文件>]
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { traceHistory } from '../history/index.js'
import { DEFAULT_CONFIG, loadProfile } from '../core/config.js'

const USAGE = `用法：code-audit history --file <路径> [选项]

选项：
  --file     目标文件，相对仓库根目录（必填）
  --root     仓库目录，默认当前目录
  --pattern  引用方代码里会出现的字符串，如 utils/math
             默认由文件最初的路径推出：去掉配置的源码根目录（默认 src）和扩展名
             移动过的文件会自动用旧路径；文件不在源码根目录下时必须手动指定
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
        root: { type: 'string' },
        pattern: { type: 'string' },
        rev: { type: 'string' },
        profile: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (e) {
    // 不认识的参数等：报错 + 用法
    console.error(`${e.message}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  if (values.help) {
    console.log(USAGE)
    return
  }
  if (!values.file) {
    console.error(`缺少 --file\n\n${USAGE}`)
    process.exitCode = 1
    return
  }

  const root = resolve(values.root ?? '.')
  try {
    const config = values.profile ? await loadProfile(values.profile) : DEFAULT_CONFIG
    const result = traceHistory({ root, file: values.file, pattern: values.pattern, rev: values.rev, config })
    console.log(JSON.stringify({ file: values.file, ...result }, null, 2))
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
