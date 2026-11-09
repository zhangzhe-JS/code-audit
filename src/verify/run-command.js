/**
 * 在工作目录里跑一条项目配置的命令（构建、测试）
 *
 * - 命令来自 profile，按 shell 命令执行（可以写 "pnpm run build:ci"、"npm test -- --run" 等）
 * - 设 CI=1：大多数工具在 CI 模式下不会停下来等人输入；关掉颜色，日志才好比较
 * - 超时：连同它启动的子进程一起结束（pnpm → node → vite 是一串进程，只结束 shell 会留下孤儿进程）
 * - 输出只留最后一段：构建日志可能很长
 */
import { spawn } from 'node:child_process'

/** 输出最多保留多少字符（只留最后的部分：报错一般在结尾） */
const OUTPUT_MAX = 2 * 1024 * 1024

/**
 * @typedef {object} CommandResult
 * @property {string} command
 * @property {boolean} ok         退出码为 0 且没有超时
 * @property {number|null} exitCode
 * @property {boolean} timedOut
 * @property {number} durationMs
 * @property {string} output      stdout 和 stderr 按时间顺序合在一起，去掉颜色；过长时只留结尾
 */

/**
 * @param {string} command
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {number} opts.timeoutSeconds
 * @param {Record<string, string>} [opts.env]
 * @returns {Promise<CommandResult>}
 */
export function runCommand(command, { cwd, timeoutSeconds, env = {} }) {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32', // 自成一个进程组：超时时整组结束
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...env }
    })
    let output = ''
    const append = (chunk) => {
      output += chunk.toString('utf8')
      if (output.length > OUTPUT_MAX * 2) output = output.slice(-OUTPUT_MAX)
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref()
    }, timeoutSeconds * 1000)

    const finish = (exitCode, extra = '') => {
      clearTimeout(timer)
      const text = stripAnsi(output + extra)
      resolvePromise({
        command,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output: text.length > OUTPUT_MAX ? text.slice(-OUTPUT_MAX) : text
      })
    }
    child.on('error', (e) => finish(null, `\n[code-audit] 命令启动失败：${e.message}\n`))
    child.on('close', (code) => finish(code))
  })
}

function killTree(child, signal) {
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'])
    } else {
      process.kill(-child.pid, signal) // 负数：整个进程组
    }
  } catch {
    // 进程已经结束
  }
}

/** 去掉终端颜色等控制序列 */
export function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n?/g, '\n')
}

/** 输出的最后几行：报告里给人看 */
export function tail(output, lines = 30) {
  return output.trimEnd().split('\n').slice(-lines).join('\n')
}
