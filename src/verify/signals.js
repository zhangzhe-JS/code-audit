/**
 * 从构建、测试的输出里取出要比较的信号，和基线比较
 *
 * 只看「新增」：基线里本来就有的失败、警告不算删文件引起的（项目的测试本来就有失败是常见情况）
 *
 * - 构建：成功 / 失败；警告行
 * - 测试：失败的测试。不同测试工具的格式不同，按常见写法认：
 *     vitest / jest：FAIL  src/a.test.js > 分组 > 用例
 *     各种 reporter：✗ × ✕ 开头的行
 *   只比失败的用例不够：基线本来就有失败时，退出码本来就不是 0，删坏了（测试工具整个崩了、
 *   少跑了一批用例）也可能只打印出原来那几条失败。所以还要比：
 *   - 退出码变了
 *   - 基线认得出失败的用例，删后一个都认不出，又没成功：测试多半没正常跑完
 *   - 通过的用例变少（读汇总行「Tests … 718 passed」，没有汇总行时数 ✓ / PASS 开头的行）
 *   基线成功、删后失败又认不出是哪些测试时，按「成功 / 失败」比较
 *
 * 输出很长时只保留开头和结尾（run-command.js），但关键行（失败、警告、通过、汇总、报错）一行不漏地另外收着，
 * 比较时用的是关键行，不受截断影响
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
    const beforeLines = new Set([...lines(before.output, workDir), ...lines(before.signals ?? '', workDir)])
    const added = unique([...lines(after.output, workDir), ...lines(after.signals ?? '', workDir)]).filter((l) => !beforeLines.has(l))
    newLines.push(...added)

    if (step === 'build') {
      result.build.ok = after.ok
      if (before.ok && !after.ok) problems.push(after.timedOut ? '构建超时' : `构建失败（退出码 ${after.exitCode}）`)
      const was = new Set(warnings(full(before), workDir))
      result.build.newWarnings = unique(warnings(full(after), workDir).filter((w) => !was.has(w)))
    } else if (step === 'test') {
      const was = failures(full(before), workDir)
      const now = failures(full(after), workDir)
      const old = new Set(was)
      result.test.newFailures = unique(now.filter((f) => !old.has(f)))
      if (result.test.newFailures.length > 0) problems.push(`新增失败的测试 ${result.test.newFailures.length} 个`)
      // 认不出具体用例、但能看出变差了：写进 newFailures（报告里显示），也算问题
      const worse = (msg) => {
        result.test.newFailures.push(msg)
        problems.push(msg)
      }
      if (after.timedOut && !before.timedOut) {
        worse('测试超时')
      } else if (!after.ok) {
        if (before.ok && result.test.newFailures.length === 0) {
          worse(`测试失败（退出码 ${after.exitCode}，认不出是哪些测试）`)
        } else if (!before.ok && after.exitCode !== before.exitCode) {
          worse(`测试的退出码从 ${before.exitCode} 变成 ${after.exitCode}`)
        } else if (!before.ok && was.length > 0 && now.length === 0) {
          worse('测试没有正常跑完：基线认得出失败的用例，删后一个都认不出（可能整个崩了）')
        }
      }
      // 删后用和基线同一种办法数：基线读的是汇总行就读汇总行，数的是 ✓ 就数 ✓；删后一个都数不出来按 0 算
      const pb = passedCount(full(before), workDir)
      const pa = pb ? passedCount(full(after), workDir, pb.by) : null
      if (pb && pb.n > 0 && (pa?.n ?? 0) < pb.n) worse(`通过的测试变少了：${pb.n} → ${pa?.n ?? 0}${pa ? '' : '（删后认不出通过的用例）'}`)
    }
  }
  result.passed = problems.length === 0
  return result
}

/** 用来比较的文本：有关键行（整个输出里一行不漏收集的）就用关键行，否则用保留下来的输出 */
function full(r) {
  return r.signals ?? r.output
}

/**
 * 通过的用例数：优先读汇总行（vitest「Tests  10 failed | 718 passed (728)」、jest「Tests: 1 failed, 99 passed, 100 total」），
 * 没有汇总行时数 ✓ / ✔ / PASS 开头的行。都没有返回 null。by：只用这一种办法数（和基线比较时用基线的办法）
 * @returns {{n: number, by: 'summary'|'marks'} | null}
 */
export function passedCount(output, workDir, by = null) {
  const all = lines(output, workDir)
  if (by !== 'marks') {
    const summary = all.filter((l) => /^Tests?:?\s/.test(l)).map((l) => l.match(/(\d+) passed/)).filter(Boolean).at(-1)
    if (summary) return { n: Number(summary[1]), by: 'summary' }
    if (by === 'summary') return null
  }
  const marks = all.filter((l) => /^(PASS\b|[✓✔]\s)/.test(l)).length
  return marks > 0 ? { n: marks, by: 'marks' } : null
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
