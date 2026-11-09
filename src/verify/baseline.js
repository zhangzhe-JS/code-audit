/**
 * 基线：在没删任何文件的工作目录里，按配置跑构建、测试
 *
 * 删文件以后的结果要和基线比：基线里本来就有的失败、警告不算删文件引起的
 */
import { existsSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { runCommand } from './run-command.js'

/** 按这个顺序跑 */
export const STEPS = Object.freeze(['build', 'test'])

/**
 * @param {object} opts
 * @param {string} opts.cwd  工作目录
 * @param {Readonly<import('../core/config.js').VerifyConfig>} opts.verify
 * @param {string} [opts.logDir] 完整输出写到这个目录（每步一个 .log，不截断）
 * @param {(msg: string) => void} [opts.log]
 * @param {typeof runCommand} [opts.run] 测试时可以替换
 * @returns {Promise<Record<string, import('./run-command.js').CommandResult>>} 只含配置了的步骤
 */
export async function runSteps({ cwd, verify, logDir, log = () => {}, run = runCommand }) {
  const results = {}
  for (const step of STEPS) {
    const command = verify[step]
    if (!command) continue
    log(`运行 ${step}：${command}`)
    const logFile = logDir ? join(logDir, `${step}.log`) : undefined
    if (logDir) mkdirSync(logDir, { recursive: true })
    const r = await run(command, { cwd, timeoutSeconds: verify.timeoutSeconds, logFile })
    results[step] = r
    // 替换掉的 run（测试用）可能不写日志：至少把保留下来的输出写进去
    if (logFile && !existsSync(logFile)) writeFileSync(logFile, r.output)
    log(`  ${describe(r)}`)
  }
  return results
}

/** 一步的结果，给人看 */
export function describe(r) {
  const secs = `${Math.round(r.durationMs / 1000)} 秒`
  if (r.timedOut) return `超时（${secs}）`
  if (r.ok) return `成功（${secs}）`
  return r.exitCode === null ? `没能启动（${secs}）` : `失败，退出码 ${r.exitCode}（${secs}）`
}
