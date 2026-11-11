/**
 * MCP 的 check_change：跑两次接口分析再比较；结果目录里其他项目的结果用来判断「别的项目还在不在用」
 */
import { basename, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { checkChange, checkMarkdown } from '../api/check.js'
import { loadIndex } from '../query/index.js'
import { resultFiles } from './server.js'

export async function runCheck({ root, profile, base, head = 'HEAD', dir }) {
  const config = await loadProfile(profile)
  const abs = resolve(root)
  let others = []
  try {
    others = loadIndex(resultFiles(dir)).apis
  } catch {
    // 结果目录空或坏了：照样检查，只是看不出别的项目用不用
  }
  const result = checkChange({ root: abs, project: basename(abs), config, base, head, others })
  return { summary: result.summary, findings: result.findings, markdown: checkMarkdown(result) }
}
