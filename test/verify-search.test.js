import { test } from 'node:test'
import assert from 'node:assert/strict'
import { compare, failures, normalize, warnings } from '../src/verify/signals.js'
import { locate } from '../src/verify/locate.js'
import { searchDeletions } from '../src/verify/search.js'
import { groupUnits } from '../src/verify/index.js'

const res = (output, ok = true, extra = {}) => ({ command: 'x', ok, exitCode: ok ? 0 : 1, timedOut: false, durationMs: 1, output, ...extra })

// ---------- 和基线比较 ----------

test('normalize：去掉临时目录路径、耗时、文件大小', () => {
  assert.equal(normalize('  /tmp/ws/tree/src/a.js built in 12.3s  ', '/tmp/ws/tree'), 'src/a.js built in #')
  assert.equal(normalize('✓ src/a.test.js (3 tests) 12ms', ''), '✓ src/a.test.js (3 tests) #')
  assert.equal(normalize('dist/x.js  120.5 kB', ''), 'dist/x.js #')
  // macOS：/var 是 /private/var 的软链接，两种写法都要去掉
  assert.equal(normalize("open '/private/var/t/ws/src/a.js'", ['/var/t/ws', '/private/var/t/ws']), "open 'src/a.js'")
})

test('warnings、failures：认常见写法', () => {
  const out = ['(!) Some chunks are larger', 'WARN deprecated', 'warning: x', 'nothing', ' FAIL  src/a.test.js > g > c', '× b fails', 'FAILURE is not FAIL'].join('\n')
  assert.deepEqual(warnings(out, ''), ['(!) Some chunks are larger', 'WARN deprecated', 'warning: x'])
  assert.deepEqual(failures(out, ''), ['src/a.test.js > g > c', 'b fails'])
})

test('compare：只看新增；基线本来就失败的测试不算', () => {
  const base = { build: res('ok\nwarning: old'), test: res(' FAIL  t/old.test.js > broken', false) }
  const same = compare(base, { build: res('ok\nwarning: old'), test: res(' FAIL  t/old.test.js > broken', false) }, '')
  assert.equal(same.passed, true)
  assert.deepEqual(same.test.newFailures, [])

  const worse = compare(base, { build: res('ok\nwarning: old\nwarning: new one'), test: res(' FAIL  t/old.test.js > broken\n FAIL  t/a.test.js > uses a', false) }, '')
  assert.equal(worse.passed, false)
  assert.deepEqual(worse.build.newWarnings, ['warning: new one'])
  assert.deepEqual(worse.test.newFailures, ['t/a.test.js > uses a'])
  assert.deepEqual(worse.problems, ['新增失败的测试 1 个'])
  assert.ok(worse.newLines.includes('FAIL t/a.test.js > uses a'))
})

test('compare：新增警告不算失败；构建失败、超时算', () => {
  const base = { build: res('ok') }
  assert.equal(compare(base, { build: res('warning: x') }, '').passed, true)
  assert.deepEqual(compare(base, { build: res('Error: boom', false) }, '').problems, ['构建失败（退出码 1）'])
  assert.deepEqual(compare(base, { build: res('', false, { timedOut: true, exitCode: null }) }, '').problems, ['构建超时'])
})

test('compare：认不出是哪些测试时，按成功 / 失败比较', () => {
  const r = compare({ test: res('all good') }, { test: res('something went wrong', false) }, '')
  assert.deepEqual(r.test.newFailures, ['测试失败（退出码 1，认不出是哪些测试）'])
  assert.equal(r.passed, false)
})

// ---------- 从报错里认出文件 ----------

const deleted = ['src/utils/a.js', 'src/views/B.vue', 'src/c/index.js', 'src/helper.js', 'src/other.js']
const loc = (newLines, newFailures = [], files = {}) =>
  [...locate({ newLines, newFailures, deleted, aliases: { '@': 'src' }, readFile: (p) => files[p] ?? null })].sort()

test('locate：import 路径按同一行的引用方解析（rollup、vite、webpack 的写法）', () => {
  assert.deepEqual(loc(['Could not resolve "./utils/a" from "src/main.js"']), ['src/utils/a.js'])
  assert.deepEqual(loc(['[vite]: Rollup failed to resolve import "@/views/B.vue" from "src/router/index.js".']), ['src/views/B.vue'])
  assert.deepEqual(loc(["Module not found: Error: Can't resolve '../c' in 'src/views/x.js'"]), ['src/c/index.js'])
})

test('locate：报错里直接写着路径；绝对路径已在归一化时去掉', () => {
  assert.deepEqual(loc(["Error: ENOENT: no such file or directory, open 'src/helper.js'"]), ['src/helper.js'])
  assert.deepEqual(loc(['at src/other.js:3:5']), ['src/other.js'])
})

test('locate：新失败的测试 import 了哪些被删的文件', () => {
  const files = { 'tests/h.test.js': "import { h } from '../src/helper.js'\n" }
  assert.deepEqual(loc([], ['tests/h.test.js > helper > works', 'tests/missing.test.js > x'], files), ['src/helper.js'])
})

test('locate：认不出时返回空', () => {
  assert.deepEqual(loc(['Error: something broke', 'src/main.js 12 errors']), [])
})

// ---------- 搜索 ----------

/** 假的一轮：删了 bad 里的文件就不通过；named 里的会出现在报错里 */
function fakeRun({ bad = [], named = [], together = null }) {
  const calls = []
  const run = async (deleted) => {
    calls.push([...deleted].sort())
    const broken = bad.filter((f) => deleted.has(f))
    const both = together && together.every((f) => deleted.has(f))
    const passed = broken.length === 0 && !both
    return {
      passed,
      problems: passed ? [] : ['构建失败（退出码 1）'],
      newLines: broken.filter((f) => named.includes(f)).map((f) => `Could not resolve "./${f.split('/').pop()}" from "src/main.js"`),
      build: { ok: passed, newWarnings: [] },
      test: { newFailures: [] }
    }
  }
  const locateFn = (cmp, del) => locate({ newLines: cmp.newLines, newFailures: [], deleted: del, readFile: () => null })
  return { run, calls, locate: locateFn }
}
const units = (...files) => files.map((f) => (Array.isArray(f) ? f : [f]))

test('searchDeletions：全部删掉就通过：只跑 1 轮，最后一轮的结果直接用', async () => {
  const f = fakeRun({})
  const r = await searchDeletions({ units: units('src/a.js', 'src/b.js'), run: f.run, locate: f.locate, maxRounds: 10 })
  assert.equal(r.rounds, 1)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(r.good.flat(), ['src/a.js', 'src/b.js'])
  assert.equal(r.final.passed, true)
})

test('searchDeletions：报错里认得出：放回去再跑，逐个确认，不用对半找', async () => {
  const f = fakeRun({ bad: ['src/b.js'], named: ['src/b.js'] })
  const r = await searchDeletions({ units: units('src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'), run: f.run, locate: f.locate, maxRounds: 10 })
  assert.deepEqual(r.bad.map((b) => b.unit), [['src/b.js']])
  assert.deepEqual(r.good.flat().sort(), ['src/a.js', 'src/c.js', 'src/d.js'])
  assert.equal(r.rounds, 3) // 全部删 → 放回 b → 确认 b；放回 b 那一轮就是最终结果
})

test('searchDeletions：认不出来时对半找', async () => {
  const f = fakeRun({ bad: ['src/c.js'] })
  const r = await searchDeletions({ units: units('src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'), run: f.run, locate: f.locate, maxRounds: 20 })
  assert.deepEqual(r.bad.map((b) => b.unit), [['src/c.js']])
  assert.deepEqual(r.good.flat().sort(), ['src/a.js', 'src/b.js', 'src/d.js'])
  assert.equal(r.final.passed, true)
})

test('searchDeletions：报错冤枉了人时，单独确认后放行', async () => {
  // 删 a 会出问题，但报错里只写着 b
  const f = fakeRun({ bad: ['src/a.js'], named: [] })
  const lying = (cmp, del) => (cmp.passed ? new Set() : new Set(del.includes('src/b.js') ? ['src/b.js'] : []))
  const r = await searchDeletions({ units: units('src/a.js', 'src/b.js', 'src/c.js'), run: f.run, locate: lying, maxRounds: 20 })
  assert.deepEqual(r.bad.map((b) => b.unit), [['src/a.js']])
  assert.deepEqual(r.good.flat().sort(), ['src/b.js', 'src/c.js'])
})

test('searchDeletions：分开删没问题、一起删才出问题的，过程中就能发现；最终结果是全部能删的一起删', async () => {
  const f = fakeRun({ bad: ['src/x.js'], named: ['src/x.js'], together: ['src/a.js', 'src/b.js'] })
  const r = await searchDeletions({ units: units('src/a.js', 'src/b.js', 'src/x.js'), run: f.run, locate: f.locate, maxRounds: 20 })
  assert.deepEqual(r.bad.map((b) => b.unit).sort(), [['src/b.js'], ['src/x.js']])
  assert.deepEqual(r.good.flat(), ['src/a.js'])
  assert.equal(r.final.passed, true)
  assert.ok(f.calls.some((c) => c.join() === 'src/a.js')) // 最终结果来自只删 a 的那一轮
})

test('searchDeletions：组一起删；轮数用完的记为未验证', async () => {
  const f = fakeRun({ bad: ['src/c.js'] })
  const r = await searchDeletions({ units: units(['src/a.js', 'src/a-child.js'], 'src/b.js', 'src/c.js', 'src/d.js'), run: f.run, locate: f.locate, maxRounds: 2 })
  assert.equal(r.rounds, 2)
  assert.ok(f.calls[0].includes('src/a-child.js') && f.calls[0].includes('src/a.js'))
  assert.ok(r.unverified.length > 0)
})

test('groupUnits：有 import 关系（static、引用方也要删）的绑成一组', () => {
  const item = (target, refs = []) => ({ target, refs })
  const items = [
    item('src/p.js'),
    item('src/child.js', [{ from: 'src/p.js', line: 1, via: 'static' }]),
    item('src/grand.js', [{ from: 'src/child.js', line: 1, via: 'static' }]),
    item('src/solo.js', [{ from: 'src/live.js', line: 1, via: 'static' }, { from: 'src/p.js', line: 2, via: 'comment' }]),
    item('src/q.js')
  ]
  assert.deepEqual(groupUnits(items, ['src/q.js', 'src/p.js', 'src/child.js', 'src/grand.js', 'src/solo.js']), [
    ['src/child.js', 'src/grand.js', 'src/p.js'],
    ['src/q.js'],
    ['src/solo.js']
  ])
})
