/**
 * 从构建、测试的输出里取出要比较的信号，和基线比较
 *
 * 只看「新增」：基线里本来就有的失败、警告不算删文件引起的（finicr-web 的 HEAD 上就有 10 个测试本来失败）
 *
 * - 构建：成功 / 失败；警告行
 * - 测试：失败的测试。不同测试工具的格式不同，按常见写法认：
 *     vitest / jest：FAIL  src/a.test.js > 分组 > 用例
 *     各种 reporter：✗ × ✕ 开头的行
 *   认不出是哪些测试失败时，退回按「成功 / 失败」比较
 *
 * 比较前先归一化：去掉临时目录的绝对路径、耗时、数字，避免每次运行都不一样的内容被当成「新增」
 */

/**
 * @typedef {object} Comparison
 * @property {boolean} passed      构建、测试都没有比基线变差（新增警告不算变差，只列出来给人看）
 * @property {{ok: boolean, newWarnings: string[]}} build
 * @property {{newFailures: string[]}} test
 * @property {string[]} problems  变差的地方，给人看
 * @property {string[]} newLines  比基线多出来的输出行：用来找是哪个文件引起的
 */

/**
 * @param {Record<string, import('./run-command.js').CommandResult>} baseline
 * @param {Record<string, import('./run-command.js').CommandResult>} current
 * @param {string|string[]} workDir 工作目录：输出里的绝对路径换成相对路径。
 *   可以传多个写法：macOS 的临时目录 /var/... 实际是 /private/var/...，工具输出里两种都可能出现
 * @returns {Comparison}
 */
export function compare(baseline, current, workDir) {
  const problems = []
  const newLines = []
  const result = { passed: true, build: { ok: true, newWarnings: [] }, test: { newFailures: [] }, problems, newLines }

  for (const step of Object.keys(current)) {
    const before = baseline[step]
    const after = current[step]
    const beforeLines = new Set(lines(before.output, workDir))
    const added = lines(after.output, workDir).filter((l) => !beforeLines.has(l))
    newLines.push(...added)

    if (step === 'build') {
      result.build.ok = after.ok
      if (before.ok && !after.ok) problems.push(after.timedOut ? '构建超时' : `构建失败（退出码 ${after.exitCode}）`)
      const was = new Set(warnings(before.output, workDir))
      result.build.newWarnings = unique(warnings(after.output, workDir).filter((w) => !was.has(w)))
    } else if (step === 'test') {
      const was = failures(before.output, workDir)
      const now = failures(after.output, workDir)
      if (now.length > 0 || was.length > 0) {
        const old = new Set(was)
        result.test.newFailures = unique(now.filter((f) => !old.has(f)))
        if (result.test.newFailures.length > 0) problems.push(`新增失败的测试 ${result.test.newFailures.length} 个`)
      } else if (before.ok && !after.ok) {
        // 认不出是哪些测试：按成功 / 失败比较
        result.test.newFailures = [after.timedOut ? '测试超时' : `测试失败（退出码 ${after.exitCode}，认不出是哪些测试）`]
        problems.push(result.test.newFailures[0])
      }
      if (after.timedOut && !before.timedOut && !problems.includes('测试超时')) problems.push('测试超时')
    }
  }
  result.passed = problems.length === 0
  return result
}

/** 归一化后的非空行 */
export function lines(output, workDir) {
  return output
    .split('\n')
    .map((l) => normalize(l, workDir))
    .filter((l) => l !== '')
}

/** 警告行：带 warn / warning 字样，或 rollup 的 (!) 开头 */
export function warnings(output, workDir) {
  return lines(output, workDir).filter((l) => /\bwarn(ing)?\b/i.test(l) || l.startsWith('(!)'))
}

/** 失败的测试 */
export function failures(output, workDir) {
  return unique(
    lines(output, workDir)
      .filter((l) => /^(FAIL\b|[✗×✕]\s)/.test(l))
      .map((l) => l.replace(/^(FAIL|[✗×✕])\s+/, ''))
  )
}

/**
 * 一行输出归一化：去掉临时目录的绝对路径、首尾空白、耗时和数字
 * 耗时、文件大小每次运行都不一样，不去掉就会被当成新增
 */
export function normalize(line, workDir) {
  let l = line
  // 长的先换：/private/var/x 要在 /var/x 之前换掉
  const dirs = (Array.isArray(workDir) ? workDir : [workDir]).filter(Boolean).sort((a, b) => b.length - a.length)
  for (const d of dirs) l = l.split(`${d}/`).join('').split(d).join('')
  return l
    .trim()
    .replace(/\s*\(\s*\d+(\.\d+)?\s*m?s\)\s*$/, '') // 结尾的 (12 ms)
    .replace(/\b\d+(\.\d+)?\s*(ms|s|kB|KiB|MB|MiB|B)\b/g, '#')
    .replace(/\s+/g, ' ')
}

function unique(arr) {
  return [...new Set(arr)]
}
