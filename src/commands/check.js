/**
 * check 子命令：改之前先看风险。对比两个提交的接口，列出变化和要注意的地方（给合并请求、CI 日志看）
 *
 * 用法：
 *   code-audit check --root <仓库> --profile <配置> --base <目标分支或提交> [--head <提交>] [--index <其他项目的 api.json>...]
 *                    [--out <check.json>] [--markdown <check.md>] [--fail-on risk|warn]
 *
 * 只读：两个提交都导出到系统临时目录分析
 */
import { parseArgs } from 'node:util'
import { basename, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, readJson, writeFileSafely } from '../core/output.js'
import { checkChange, checkMarkdown } from '../api/check.js'
import { validateApiResult } from '../api/report.js'

const USAGE = `用法：code-audit check --root <仓库> --profile <配置> --base <目标分支或提交> [选项]

对比两个提交的接口（profile 里要有 api 规则），列出：
  要处理：同一个函数调用的接口地址改了（确认后端已经有新接口；别的项目还在用旧的就别删）
  要确认：新增的接口和已有的很像（可能重复写了）、在用变成没人用（定义还留着）、多处在用的定义、规则认不出的新写法
  知道一下：新增、不再定义、重新在用、改到了在用接口的定义（附使用菜单和引用方数）

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填，要有 api 规则；有 menus 时会附上使用菜单）
  --base     目标分支或提交（必填），如 origin/master
  --head     当前分支或提交，默认 HEAD
  --index    其他项目的 code-audit api 结果，可以写多次：用来判断「别的项目还在不在用」
  --out      完整结果（JSON）写到这个文件
  --markdown Markdown 写到这个文件；不传就打印出来（可以贴进合并请求）
  --fail-on  有这个等级及以上的条目时退出码为 1（CI 用）：risk 或 warn；默认不因结果失败
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { root: { type: 'string' }, profile: { type: 'string' }, base: { type: 'string' }, head: { type: 'string' }, index: { type: 'string', multiple: true }, out: { type: 'string' }, markdown: { type: 'string' }, 'fail-on': { type: 'string' }, knip: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }
  if (values.help) return console.log(USAGE)
  if (!values.profile || !values.base) return fail(`缺少 --profile 或 --base\n\n${USAGE}`)
  if (values['fail-on'] && !['risk', 'warn'].includes(values['fail-on'])) return fail(`--fail-on 只能是 risk 或 warn\n\n${USAGE}`)
  const root = resolve(values.root ?? '.')
  try {
    const config = await loadProfile(values.profile)
    for (const f of [values.out, values.markdown].filter(Boolean)) {
      assertOutsideRepo(f, root)
      if (pathExists(f)) throw new Error(`输出文件已存在：${resolve(f)}（工具不覆盖已有文件）`)
    }
    const others = (values.index ?? []).map((f) => {
      const r = readJson(f)
      const errs = validateApiResult(r)
      if (errs.length > 0) throw new Error(`${f} 不是有效的 code-audit api 结果：\n  - ${errs.slice(0, 5).join('\n  - ')}`)
      return r
    })
    const result = checkChange({ root, project: basename(root), config, base: values.base, head: values.head ?? 'HEAD', others, knipDir: values.knip })
    const md = checkMarkdown(result)
    const s = result.summary
    console.error(`对比 ${s.before.slice(0, 8)} → ${s.after.slice(0, 8)}：要处理 ${s.risk}，要确认 ${s.warn}，知道一下 ${s.info}`)
    if (values.out) writeFileSafely(values.out, `${JSON.stringify({ summary: result.summary, findings: result.findings }, null, 2)}\n`)
    if (values.markdown) {
      writeFileSafely(values.markdown, md)
      console.error(`Markdown 写入：${resolve(values.markdown)}`)
    } else {
      process.stdout.write(md)
    }
    const failOn = values['fail-on']
    if (failOn && (s.risk > 0 || (failOn === 'warn' && s.warn > 0))) process.exitCode = 1
  } catch (e) {
    fail(e.message)
  }
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
