/**
 * context 子命令：整理「生成项目配置」需要的材料（Markdown），交给任意大模型写 profile
 *
 * 用法：code-audit context --root <仓库> [--profile <已有配置>] [--previous <上一次 api 结果>] [--out <材料.md>] [--rev <提交>]
 *
 * 只读：读提交里的文件。材料里有代码片段，主机名和密钥类取值已隐藏；发给外部模型前按公司规定确认
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, readJson, writeFileSafely } from '../core/output.js'
import { buildContext } from '../context/index.js'
import { validateApiResult } from '../api/report.js'

const USAGE = `用法：code-audit context --root <仓库> [选项]

整理生成项目配置（entries、aliases、api、menus）需要的材料，交给任意大模型写 profile；
写好后用 code-audit api 验证，按覆盖报告补规则（补的时候加 --previous 带上上一次的结果）。
工具不调用模型。材料里有代码片段：主机名、密钥类取值已隐藏，发给外部模型前按公司规定确认。

选项：
  --root      仓库目录，默认当前目录
  --profile   已有的配置：附上让模型在它的基础上改
  --previous  上一次 code-audit api 的结果：附上覆盖报告（要补的规则）
  --out       材料写到这个文件；不传就打印出来。不能写在被分析的仓库里
  --rev       读哪个提交，默认 HEAD
  -h, --help  显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { root: { type: 'string' }, profile: { type: 'string' }, previous: { type: 'string' }, out: { type: 'string' }, rev: { type: 'string' }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (values.help) return console.log(USAGE)
  const root = resolve(values.root ?? '.')
  try {
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件）`)
    }
    const profile = values.profile ? await loadProfile(values.profile) : null
    let previous = null
    if (values.previous) {
      previous = readJson(values.previous)
      const errs = validateApiResult(previous)
      if (errs.length > 0) throw new Error(`${values.previous} 不是有效的 code-audit api 结果：\n  - ${errs.slice(0, 5).join('\n  - ')}`)
    }
    const md = buildContext({ root, rev: values.rev ?? 'HEAD', profile, previous })
    if (values.out) {
      writeFileSafely(values.out, md)
      console.error(`材料写入：${resolve(values.out)}（${md.length} 字符）。发给外部模型前请按公司规定确认内容`)
    } else {
      process.stdout.write(md)
    }
  } catch (e) {
    console.error(e.message)
    process.exitCode = 1
  }
}
