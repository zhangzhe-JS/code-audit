import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo } from './helpers/repo.js'
import { validateCandidates, buildReport, MANUAL_EVIDENCE } from '../src/history/batch.js'
import { validate } from '../src/core/schema.js'
import { resolveConfig } from '../src/core/config.js'
import { TOOL } from '../src/core/tool.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

/** 一个有两个候选文件的仓库：math 被引用后又去掉，unused 从未被引用 */
function demoRepo() {
  const repo = createRepo()
  repo.write('src/utils/math.js', 'export const add = 1\n')
  repo.write('src/utils/unused.js', 'export const u = 1\n')
  repo.commit('新增工具', { date: '2024-01-01', author: 'alice' })
  repo.write('src/views/Home.vue', "<script>\nimport { add } from '@/utils/math'\n</script>\n")
  repo.commit('首页使用 math', { date: '2024-02-01', author: 'bob' })
  repo.write('src/views/Home.vue', '<script>\nexport default {}\n</script>\n')
  repo.commit('首页去掉 math', { date: '2024-03-01', author: 'carol' })
  return repo
}

/** 系统临时目录下的空目录：输出写在被分析的仓库外面 */
function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-out-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const candidates = (overrides = {}) => ({
  project: 'demo',
  entries: ['src/main.js'],
  files: [
    { file: 'src/utils/unused.js' },
    { file: 'src/utils/math.js', notes: ['恢复前先确认依赖还在'] }
  ],
  ...overrides
})

// ---------- 候选清单校验 ----------

test('候选清单：正确的清单没有错误，entries 可以不写', () => {
  assert.deepEqual(validateCandidates(candidates()), [])
  const c = candidates()
  delete c.entries
  assert.deepEqual(validateCandidates(c), [])
})

test('候选清单：各种写错的情况都报出来，包括拼错的字段名', () => {
  const msg = validateCandidates({
    project: '',
    entries: ['/abs'],
    files: [{ file: 'a.js', note: ['拼错了'] }, { file: 'a.js' }, { file: '/abs.js' }, 'x', { file: 'b.js', pattern: '', notes: [''] }, { file: 'src/../x.js' }],
    extra: 1
  }).join('\n')
  for (const re of [/不认识的字段：extra/, /project 必须是非空字符串/, /entries 必须是相对路径/, /files\[0\] 不认识的字段：note/,
    /files\[1\]\.file 重复：a\.js/, /files\[2\]\.file 必须是相对/, /files\[3\] 必须是对象/, /files\[4\]\.pattern/, /files\[4\]\.notes/, /files\[5\]\.file 必须是相对/]) {
    assert.match(msg, re)
  }
  assert.deepEqual(validateCandidates({ project: 'p', files: [] }), ['files 必须是非空数组'])
  assert.deepEqual(validateCandidates(null), ['候选清单必须是对象'])
})

// ---------- 批量查询 ----------

test('buildReport：输出符合 schema 的完整数据，items 按 id 排序', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())

  const now = new Date('2026-11-06T00:00:00.000Z')
  const report = buildReport({ root: repo.root, candidates: candidates(), now })

  assert.deepEqual(validate(report), [])
  assert.equal(report.generatedAt, '2026-11-06T00:00:00.000Z')
  assert.deepEqual(report.tool, TOOL)
  assert.equal(report.project.name, 'demo')
  assert.equal(report.project.rev, repo.run(['rev-parse', 'HEAD'])) // 完整提交号，不是 HEAD
  assert.deepEqual(report.items.map((i) => i.id), ['file:src/utils/math.js', 'file:src/utils/unused.js'])
})

test('buildReport：每项状态是 unknown、证据是人工候选，不替规则下结论', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())

  const [math, unused] = buildReport({ root: repo.root, candidates: candidates() }).items
  for (const item of [math, unused]) {
    assert.equal(item.status, 'unknown')
    assert.deepEqual(item.evidence, [MANUAL_EVIDENCE])
  }
  assert.deepEqual(math.notes, ['恢复前先确认依赖还在'])
  assert.equal('notes' in unused, false) // 没写备注就不加这个字段
})

test('buildReport：history 里记下搜索用的 pattern；候选清单里写了 pattern 就用它', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())

  const c = candidates({ files: [{ file: 'src/utils/math.js', pattern: 'utils/math' }, { file: 'src/utils/unused.js' }] })
  const [math, unused] = buildReport({ root: repo.root, candidates: c }).items
  assert.equal(math.history.pattern, 'utils/math')
  assert.equal(unused.history.pattern, 'utils/unused') // 没写就自动推
  assert.equal(math.history.lostRef.subject, '首页去掉 math')
})

test('buildReport：--rev 指定提交时，只查到那个提交为止', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())

  const second = repo.run(['rev-parse', 'HEAD~1']) // 「首页使用 math」那次
  const report = buildReport({ root: repo.root, candidates: candidates(), rev: 'HEAD~1' })
  assert.equal(report.project.rev, second)
  const math = report.items.find((i) => i.id === 'file:src/utils/math.js')
  assert.equal(math.history.lostRef, null) // 那时还在被引用
  assert.equal(math.history.timeline.length, 1)
})

test('buildReport：有文件查询失败时整批失败，列出所有失败的文件', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())

  const c = candidates({ files: [{ file: 'src/utils/math.js' }, { file: 'src/none.js' }, { file: 'app/x.js' }] })
  assert.throws(
    () => buildReport({ root: repo.root, candidates: c }),
    (e) => /有 2 个文件查询失败/.test(e.message) && /src\/none\.js：.*找不到文件/.test(e.message) && /app\/x\.js：.*找不到文件/.test(e.message)
  )
})

test('buildReport：提交不存在、候选清单有误时报错', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())
  assert.throws(() => buildReport({ root: repo.root, candidates: candidates(), rev: 'no-such' }), /找不到提交：no-such/)
  assert.throws(() => buildReport({ root: repo.root, candidates: { project: 'p' } }), /候选清单有误/)
})

test('buildReport：使用项目配置（源码根目录不是 src）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('app/lib/x.js', 'export const x = 1\n')
  repo.commit('新增 x')

  const config = resolveConfig({ sourceRoots: ['app'] })
  const report = buildReport({ root: repo.root, candidates: { project: 'p', files: [{ file: 'app/lib/x.js' }] }, config })
  assert.equal(report.items[0].history.pattern, 'lib/x')
})

// ---------- history 命令：批量模式 ----------

test('history --in --out：结果写入文件，提示写到 stderr', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())
  const dir = tempDir(t)
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(candidates()))

  const out = join(dir, 'result', 'report.json') // 父目录不存在也能写
  const r = cli('history', '--root', repo.root, '--in', join(dir, 'candidates.json'), '--out', out)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout, '')
  assert.match(r.stderr, /已查询 2 个文件/)
  assert.deepEqual(validate(JSON.parse(readFileSync(out, 'utf8'))), [])
})

test('history --in 不传 --out：结果打印到 stdout', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())
  const dir = tempDir(t)
  writeFileSync(join(dir, 'c.json'), JSON.stringify(candidates()))

  const r = cli('history', '--root', repo.root, '--in', join(dir, 'c.json'))
  assert.equal(r.status, 0, r.stderr)
  assert.equal(JSON.parse(r.stdout).items.length, 2)
})

test('history --in：查询失败时不写出文件，退出码为 1', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())
  const dir = tempDir(t)
  writeFileSync(join(dir, 'c.json'), JSON.stringify(candidates({ files: [{ file: 'src/none.js' }] })))

  const out = join(dir, 'report.json')
  const r = cli('history', '--root', repo.root, '--in', join(dir, 'c.json'), '--out', out)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /查询失败/)
  assert.equal(existsSync(out), false)
})

test('history --in：输出不能写在被分析的仓库里', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())
  const dir = tempDir(t)
  writeFileSync(join(dir, 'c.json'), JSON.stringify(candidates()))

  const r = cli('history', '--root', repo.root, '--in', join(dir, 'c.json'), '--out', join(repo.root, 'report.json'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /输出位置在被分析的仓库里/)
  assert.equal(existsSync(join(repo.root, 'report.json')), false)
})

test('history --in：输出文件已存在时不覆盖', (t) => {
  const repo = demoRepo()
  t.after(() => repo.cleanup())
  const dir = tempDir(t)
  writeFileSync(join(dir, 'c.json'), JSON.stringify(candidates()))
  writeFileSync(join(dir, 'report.json'), '旧内容')

  const r = cli('history', '--root', repo.root, '--in', join(dir, 'c.json'), '--out', join(dir, 'report.json'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /输出文件已存在/)
  assert.equal(readFileSync(join(dir, 'report.json'), 'utf8'), '旧内容')
})

test('history 命令：参数混用、候选清单不是合法 JSON 时报错', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'bad.json'), '{ 不是 json')

  for (const [args, re] of [
    [['--file', 'a.js', '--in', 'c.json'], /只能用一个/],
    [['--in', 'c.json', '--pattern', 'x'], /不能用 --pattern/],
    [['--file', 'a.js', '--out', 'x.json'], /--out 只用于批量查询/],
    [['--in', join(dir, 'bad.json')], /不是合法的 JSON/],
    [['--in', join(dir, 'none.json')], /读不到文件/]
  ]) {
    const r = cli('history', ...args)
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, re, args.join(' '))
  }
})
