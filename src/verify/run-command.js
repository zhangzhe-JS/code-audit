/**
 * 在工作目录里跑一条项目配置的命令（构建、测试）
 *
 * - 命令来自 profile，按 shell 命令执行（可以写 "npm run build"、"pnpm test -- --run" 等）
 * - 设 CI=1：大多数工具在 CI 模式下不会停下来等人输入；关掉颜色，日志才好比较
 * - 超时：连同它启动的子进程一起结束（pnpm → node → vite 是一串进程，只结束 shell 会留下孤儿进程）
 * - 输出可能很长：
 *   - 传了 logFile 时，完整输出（去颜色）边跑边写进日志文件，不截断
 *   - 内存里只留开头和结尾各一段，中间注明省略了多少（给人看、给报告用）
 *   - 关键行（失败、警告、通过、汇总、报错）另外一行不漏地收着：比较只用它们，不受截断影响。
 *     jest 这类工具一开始就打印失败的用例，只留结尾的话会丢
 */
import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { StringDecoder } from 'node:string_decoder'

/** 内存里保留的开头、结尾各多少字符 */
const HEAD_MAX = 256 * 1024
const TAIL_MAX = 1792 * 1024

/** 关键行：比较、定位要用的，整个输出里一行不漏地收集 */
const SIGNAL = /\bwarn(ing)?s?\b|^\s*\(!\)|\berror\b|\bfail\b|^\s*(?:not ok\b|PASS\b|[✓✔✗×✕]\s|#\s*(?:tests|pass|fail|skipped|cancelled)\b)|^\s*Tests?:?\s|cannot|could not|not found|unresolved|resolve|ENOENT|无法|失败/i
/** 关键行最多收多少（防止日志全是报错时占满内存） */
const SIGNAL_MAX_LINES = 200000

/**
 * @typedef {object} CommandResult
 * @property {string} command
 * @property {boolean} ok         退出码为 0 且没有超时
 * @property {number|null} exitCode
 * @property {boolean} timedOut
 * @property {number} durationMs
 * @property {string} output      stdout 和 stderr 按时间顺序合在一起，去掉颜色；过长时只留开头和结尾
 * @property {string} signals     整个输出里的关键行（失败、警告、通过、汇总、报错），不受截断影响
 * @property {boolean} truncated  output 中间有省略
 */

/**
 * @param {string} command
 * @param {object} opts
 * @param {string} opts.cwd
 * @param {number} opts.timeoutSeconds
 * @param {Record<string, string>} [opts.env]
 * @param {string} [opts.logFile] 完整输出写到这个文件
 * @returns {Promise<CommandResult>}
 */
export function runCommand(command, { cwd, timeoutSeconds, env = {}, logFile }) {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      detached: process.platform !== 'win32', // 自成一个进程组：超时时整组结束
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CI: '1', NO_COLOR: '1', FORCE_COLOR: '0', ...env }
    })
    const log = logFile ? createWriteStream(logFile) : null
    let logError = null
    log?.on('error', (e) => { logError = e })
    let head = ''
    let tail = ''
    let omitted = 0
    const signals = []
    const keep = (text) => {
      log?.write(text)
      if (head.length < HEAD_MAX) {
        const room = HEAD_MAX - head.length
        head += text.slice(0, room)
        text = text.slice(room)
      }
      tail += text
      if (tail.length > TAIL_MAX * 2) {
        omitted += tail.length - TAIL_MAX
        tail = tail.slice(-TAIL_MAX)
      }
    }
    const lines = (done) => {
      const text = stripAnsi(done)
      for (const line of text.split('\n')) {
        if (signals.length < SIGNAL_MAX_LINES && SIGNAL.test(line)) signals.push(line)
      }
      keep(text)
    }
    // 按整行处理：颜色控制符、关键行都不会被切开。stdout、stderr 各留各的半行，不会拼到一起
    const reader = () => {
      let partial = ''
      const decoder = new StringDecoder('utf8')
      return {
        data(chunk) {
          const text = partial + decoder.write(chunk)
          const cut = text.lastIndexOf('\n')
          if (cut < 0) {
            partial = text
            return
          }
          partial = text.slice(cut + 1)
          lines(text.slice(0, cut + 1))
        },
        flush() {
          partial += decoder.end()
          if (partial) lines(`${partial}\n`)
          partial = ''
        }
      }
    }
    const out = reader()
    const err = reader()
    child.stdout.on('data', (c) => out.data(c))
    child.stderr.on('data', (c) => err.data(c))

    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child, 'SIGTERM')
      setTimeout(() => killTree(child, 'SIGKILL'), 5000).unref()
    }, timeoutSeconds * 1000)

    let finished = false
    const finish = (exitCode, extra = '') => {
      if (finished) return
      finished = true
      clearTimeout(timer)
      out.flush() // 最后一行没有换行
      err.flush()
      if (extra) lines(extra)
      if (logError) lines(`\n[code-audit] 日志写入失败：${logError.message}\n`)
      if (tail.length > TAIL_MAX) {
        omitted += tail.length - TAIL_MAX
        tail = tail.slice(-TAIL_MAX)
      }
      const output = omitted > 0 ? `${head}\n[code-audit] …中间省略 ${omitted} 个字符${logFile ? '，完整输出见日志文件' : ''}…\n${tail}` : head + tail
      const result = {
        command,
        ok: exitCode === 0 && !timedOut,
        exitCode,
        timedOut,
        durationMs: Date.now() - started,
        output,
        signals: signals.join('\n'),
        truncated: omitted > 0
      }
      if (log) log.end(() => resolvePromise(result))
      else resolvePromise(result)
    }
    child.on('error', (e) => finish(null, `\n[code-audit] 命令启动失败：${e.message}\n`))
    // exit 表示命令本身已结束；后代进程若继承了 stdout/stderr，close 可能无限等待。
    child.on('exit', (code) => finish(code))
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
