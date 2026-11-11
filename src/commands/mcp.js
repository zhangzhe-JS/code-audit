/**
 * mcp 子命令：启动 MCP 服务（stdio），给 AI 编码工具用
 *
 * 用法：code-audit mcp --dir <结果目录>
 *
 * 在 AI 工具里登记（以 Claude Code 为例）：
 *   claude mcp add code-audit -- node /path/to/code-audit/bin/code-audit.js mcp --dir /path/to/results
 */
import { parseArgs } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { serve } from '../mcp/server.js'

const USAGE = `用法：code-audit mcp --dir <结果目录> [--check <仓库目录>::<profile>]...

启动 MCP 服务（stdio），提供工具：api_impact、similar_apis、search_apis、file_info、check_change。
结果目录里放 code-audit api / exports 生成的 JSON（每个项目一份），每次调用都重新读。
--check 登记允许 check_change 检查的项目（可以写多次），项目名取仓库目录名。
profile 是会被加载执行的 JS，所以只能检查这里登记过的，模型不能传任意路径。

在 AI 工具里登记，如 Claude Code：
  claude mcp add code-audit -- node <code-audit 目录>/bin/code-audit.js mcp --dir <结果目录>`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({ args: argv, options: { dir: { type: 'string' }, check: { type: 'string', multiple: true }, help: { type: 'boolean', short: 'h' } } }))
  } catch (e) {
    console.error(`${e.message}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  if (values.help) return console.log(USAGE)
  const dir = values.dir ? resolve(values.dir) : null
  if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
    console.error(`缺少 --dir，或者目录不存在：${values.dir ?? ''}\n\n${USAGE}`)
    process.exitCode = 1
    return
  }
  const projects = new Map()
  for (const item of values.check ?? []) {
    const [root, profile] = item.split('::')
    if (!root || !profile || !existsSync(resolve(root)) || !existsSync(resolve(profile))) {
      console.error(`--check 写法是 <仓库目录>::<profile>，两个都要存在：${item}`)
      process.exitCode = 1
      return
    }
    projects.set(basename(resolve(root)), { root: resolve(root), profile: resolve(profile) })
  }
  console.error(`code-audit MCP 服务已启动，结果目录：${dir}${projects.size ? `；可以 check_change 的项目：${[...projects.keys()].join('、')}` : ''}`)
  serve({ dir, projects })
}
