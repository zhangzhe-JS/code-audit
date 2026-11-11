import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRepo } from './helpers/repo.js'
import { buildPlan } from '../src/quarantine/plan.js'
import { applyPlan, insertHeader, readmeContent } from '../src/quarantine/apply.js'
import { makeLocator, rewriteRelativePaths } from '../src/quarantine/rewrite.js'
import { makeRecaptureCheck } from '../src/quarantine/recapture.js'
import { resolveConfig } from '../src/core/config.js'
import { SCHEMA_VERSION, validate } from '../src/core/schema.js'
import { TOOL } from '../src/core/tool.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

/**
 * 小项目：
 * - src/utils/chart/Area.js 引用同目录的 Point.js（一组）和 ../../api/user.js（在用）
 * - src/utils/old.js：dead，验证通过
 * - src/utils/unverified.js：dead，没验证
 * - src/utils/failed.js：dead，验证没通过
 * - src/utils/data.json：dead，验证通过（不能写注释）
 * - src/other/x.js：dead，验证通过，但不在 base（src/utils）下
 * - src/utils/_deprecated/prev.js：已经在隔离区
 */
function projectRepo() {
  const repo = createRepo()
  repo.write('src/main.js', "import './api/user.js'\n")
  repo.write('src/api/user.js', 'export const u = 1\n')
  repo.write('src/utils/chart/Area.js', "import { P } from './Point.js'\nimport { u } from '../../api/user.js'\nexport const S = [P, u]\n")
  repo.write('src/utils/chart/Point.js', 'export const P = 2\n')
  repo.write('src/utils/old.js', '#!/usr/bin/env node\nconsole.log(1)\n')
  repo.write('src/utils/unverified.js', '')
  repo.write('src/utils/failed.js', '')
  repo.write('src/utils/data.json', '{}\n')
  repo.write('src/other/x.js', '')
  repo.write('src/utils/_deprecated/prev.js', '')
  repo.write('.eslintignore', 'dist\n')
  repo.commit('init', { date: '2024-01-01' })
  return repo
}

function dataFor(repo) {
  const rev = repo.run(['rev-parse', 'HEAD'])
  const commit = { hash: rev, date: '2024-01-01', author: 'alice', subject: 'init' }
  const verify = (passed) => ({ rev, build: { ok: passed, newWarnings: [] }, test: { newFailures: [] }, passed })
  const item = (target, status, v, refs = []) => ({
    id: `file:${target}`,
    kind: 'file',
    target,
    status,
    evidence: [{ rule: 'no-ref', detail: '没人用' }],
    refs,
    history: { introduced: commit, lostRef: null, timeline: [], paths: [target] },
    verify: v
  })
  const items = [
    item('src/utils/chart/Area.js', 'dead', verify(true)),
    item('src/utils/chart/Point.js', 'dead-only-ref', verify(true), [{ from: 'src/utils/chart/Area.js', line: 1, via: 'static' }]),
    item('src/utils/old.js', 'dead', verify(true)),
    item('src/utils/unverified.js', 'dead', null),
    item('src/utils/failed.js', 'dead', verify(false)),
    item('src/utils/data.json', 'dead', verify(true)),
    item('src/other/x.js', 'dead', verify(true)),
    item('src/utils/_deprecated/prev.js', 'dead', verify(true)),
    item('src/api/kept.js', 'external', null)
  ].sort((a, b) => (a.id < b.id ? -1 : 1))
  return { version: SCHEMA_VERSION, generatedAt: '2026-11-09T00:00:00.000Z', tool: { ...TOOL }, project: { name: 'p', root: repo.root, rev, entries: ['src/main.js'] }, items }
}

const config = resolveConfig({ aliases: { '@': 'src' }, quarantine: { layout: 'central', dir: 'src/utils/_deprecated', base: 'src/utils' }, headerTitle: '[DEPRECATED] 已隔离' })
const planFor = (repo, data = dataFor(repo), cfg = config) => {
  const files = repo.run(['ls-files']).split('\n')
  const readFile = (p) => readFileSync(join(repo.root, p), 'utf8')
  return buildPlan({ data, config: cfg, files, readFile, movedAt: '2026-11-09', branch: 'main', recaptured: makeRecaptureCheck({ files, readFile, config: cfg }) })
}
const nearby = resolveConfig({ aliases: { '@': 'src' }, headerTitle: '[DEPRECATED] 已隔离' })

// ---------- 计划 ----------

test('buildPlan（集中）：只隔离 dead / dead-only-ref、验证通过、在 base 下、不在隔离区里的；不隔离的写明原因', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo)
  assert.deepEqual(plan.moves.map((m) => [m.from, m.to]), [
    ['src/utils/chart/Area.js', 'src/utils/_deprecated/chart/Area.js'],
    ['src/utils/chart/Point.js', 'src/utils/_deprecated/chart/Point.js'],
    ['src/utils/data.json', 'src/utils/_deprecated/data.json'],
    ['src/utils/old.js', 'src/utils/_deprecated/old.js']
  ])
  assert.deepEqual(plan.skipped, [
    { file: 'src/other/x.js', reason: '不在 quarantine.base（src/utils）下，不知道放进隔离区哪里' },
    { file: 'src/utils/_deprecated/prev.js', reason: '已经在隔离区里' },
    { file: 'src/utils/failed.js', reason: '实删验证没通过' },
    { file: 'src/utils/unverified.js', reason: '没有实删验证（先跑 verify）' }
  ])
  const rect = plan.moves[0]
  assert.deepEqual(rect.changes, [{ line: 2, before: '../../api/user.js', after: '@/api/user.js' }]) // 同一组的 ./Point.js 不用改
  assert.match(rect.header, /^\/\*\*\n \* \[DEPRECATED\] 已隔离/)
  assert.equal(plan.moves[2].header, null) // .json 不能写注释
  assert.match(plan.moves[2].headerSkipped, /不支持为 \.json 文件生成头注释/)
  assert.deepEqual(plan.readmes.map((r) => [r.path, r.exists, r.moves.length]), [['src/utils/_deprecated/README.md', false, 4]])
  assert.deepEqual(plan.lintHints, ['.eslintignore 里加一行：src/utils/_deprecated/**'])
})

test('buildPlan：一组里有一个不能移，整组都不移；隔离区里已有同名文件的不移；默认隔离区是 <源码目录>/_deprecated', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const data = dataFor(repo)
  data.items.find((i) => i.target === 'src/utils/chart/Point.js').verify.passed = false
  repo.write('src/utils/_deprecated/old.js', '')
  repo.commit('占位')
  const plan = planFor(repo, data)
  assert.deepEqual(plan.moves.map((m) => m.from), ['src/utils/data.json'])
  assert.match(plan.skipped.find((s) => s.file === 'src/utils/chart/Area.js').reason, /和 src\/utils\/chart\/Point\.js 互相引用，要一起移/)
  assert.match(plan.skipped.find((s) => s.file === 'src/utils/old.js').reason, /新位置已经有同名文件/)

  const central = buildPlan({ data: dataFor(repo), config: resolveConfig({ quarantine: { layout: 'central' } }), files: repo.run(['ls-files']).split('\n'), readFile: () => '', movedAt: '2026-11-09' })
  assert.equal(central.dir, 'src/_deprecated')
  assert.ok(central.moves.some((m) => m.to === 'src/_deprecated/utils/old.js'))
  // 项目里别的隔离区（路径里有 _deprecated）的文件不再移：不会隔离区套隔离区
  assert.equal(central.moves.some((m) => m.from === 'src/utils/_deprecated/prev.js'), false)
  assert.match(central.skipped.find((x) => x.file === 'src/utils/_deprecated/prev.js').reason, /已经隔离过（路径里有 _deprecated）/)
})

// ---------- 改相对路径 ----------

test('rewriteRelativePaths：优先改成别名；指向一起移走的按新位置；注释、找不到的不改；后缀保留；样式和模板里的也改', () => {
  const files = new Set(['src/api/user.js', 'src/a/R.vue', 'src/a/V.js', 'src/assets/a.png', 'src/styles/base.scss', 'src/x/index.js', 'lib/tool.js'])
  const moved = new Map([['src/a/R.vue', 'src/_d/a/R.vue'], ['src/a/V.js', 'src/_trash/V.js']])
  const content = [
    "import u from '../api/user'",
    "import V from './V'",
    "import X from '../x'",
    "// import y from '../old'",
    "import Z from './missing'",
    "@import '../styles/base.scss';",
    '<img src="../assets/a.png?url">',
    "const t = require('../../lib/tool.js')"
  ].join('\n')
  const r = rewriteRelativePaths({ content, from: 'src/a/R.vue', to: 'src/_d/a/R.vue', moved, aliases: { '@': 'src' }, locate: makeLocator(files, ['.js', '.vue']) })
  assert.deepEqual(r.content.split('\n'), [
    "import u from '@/api/user'",
    "import V from '../../_trash/V'",
    "import X from '@/x'",
    "// import y from '../old'",
    "import Z from './missing'",
    "@import '@/styles/base.scss';",
    '<img src="@/assets/a.png?url">',
    "const t = require('../../../lib/tool.js')" // 不在别名目录下：按新位置算相对路径
  ])
  assert.deepEqual(r.unresolved, [{ line: 5, spec: './missing' }])
})

test('rewriteRelativePaths：@import url() 同时符合两种写法，只改一次（改两遍会指到别的文件）', () => {
  const files = new Set(['src/a/R.vue', 'src/b.css', 'b.css', 'src/img/x.png'])
  const moved = new Map([['src/a/R.vue', 'src/_d/a/R.vue']])
  const content = "@import url('../b.css'); .x { background: url(../img/x.png) }"
  const r = rewriteRelativePaths({ content, from: 'src/a/R.vue', to: 'src/_d/a/R.vue', moved, locate: makeLocator(files, ['.js']) })
  assert.equal(r.content, "@import url('../../b.css'); .x { background: url(../../img/x.png) }")
  assert.deepEqual(r.changes.map((c) => c.after), ['../../b.css', '../../img/x.png'])
  assert.deepEqual(r.unresolved, [])
})

// ---------- 头注释、README ----------

test('insertHeader：放在最前面；#! 开头的放在它后面', () => {
  assert.equal(insertHeader('a\n', '/** h */'), '/** h */\na\n')
  assert.equal(insertHeader('#!/usr/bin/env node\nx\n', '/** h */'), '#!/usr/bin/env node\n/** h */\nx\n')
})

test('readmeContent：没有就新建；已有的原样保留，在最后追加这一批', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo)
  const created = readmeContent(null, plan.readmes[0], { config, movedAt: '2026-11-09', branch: 'qb' })
  assert.match(created, /^# src\/utils\/_deprecated（隔离区）/)
  assert.match(created, /## 2026-11-09 隔离（code-audit，分支 qb）/)
  assert.match(created, /\| src\/utils\/_deprecated\/chart\/Area\.js \| src\/utils\/chart\/Area\.js \|/)
  const appended = readmeContent('# 人工写的\n\n## 已恢复\n\n（暂无）\n\n\n', plan.readmes[0], { config, movedAt: '2026-11-09', branch: 'qb' })
  assert.ok(appended.startsWith('# 人工写的\n\n## 已恢复\n\n（暂无）\n\n## 2026-11-09 隔离'))
})

// ---------- 执行 ----------

test('quarantine 命令：不带 --apply 只打印计划，什么都不改', (t) => {
  const repo = projectRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-q-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'p.js'), "export default { aliases: { '@': 'src' }, quarantine: { layout: 'central', dir: 'src/utils/_deprecated', base: 'src/utils' } }\n")
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dataFor(repo)))
  const before = repo.run(['rev-parse', 'HEAD'])
  const r = cli('quarantine', '--root', repo.root, '--profile', join(dir, 'p.js'), '--in', join(dir, 'data.json'), '--moved-at', '2026-11-09')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /要隔离 4 个文件/)
  assert.match(r.stderr, /src\/utils\/chart\/Area\.js → src\/utils\/_deprecated\/chart\/Area\.js/)
  assert.match(r.stderr, /第 2 行：\.\.\/\.\.\/api\/user\.js → @\/api\/user\.js/)
  assert.match(r.stderr, /不隔离 4 个/)
  assert.match(r.stderr, /只是计划，没有改任何东西/)
  assert.equal(repo.run(['rev-parse', 'HEAD']), before)
  assert.equal(repo.run(['branch', '--list']).trim(), '* main')
})

test('数据格式：测试用的数据本身是合法的', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  assert.deepEqual(validate(dataFor(repo)), [])
})

// ---------- 就近隔离（默认） ----------

test('buildPlan（就近，默认）：放进文件所在目录下的 _deprecated；每个隔离目录一份 README；lint 提示用 **/_deprecated/**', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo, dataFor(repo), nearby)
  assert.equal(plan.layout, 'nearby')
  assert.deepEqual(plan.moves.map((m) => [m.from, m.to]), [
    ['src/utils/chart/Area.js', 'src/utils/chart/_deprecated/Area.js'],
    ['src/utils/chart/Point.js', 'src/utils/chart/_deprecated/Point.js'],
    ['src/utils/data.json', 'src/utils/_deprecated/data.json'],
    ['src/utils/old.js', 'src/utils/_deprecated/old.js'],
    ['src/other/x.js', 'src/other/_deprecated/x.js']
  ].sort((a, b) => (a[0] < b[0] ? -1 : 1)))
  // 一组里两个文件在同一个目录：挪过去还在一起，./Point.js 不用改；../../api/user.js 改成别名
  assert.deepEqual(plan.moves.find((m) => m.from === 'src/utils/chart/Area.js').changes, [{ line: 2, before: '../../api/user.js', after: '@/api/user.js' }])
  assert.deepEqual(plan.readmes.map((r) => [r.path, r.moves.length]), [
    ['src/other/_deprecated/README.md', 1],
    ['src/utils/_deprecated/README.md', 2],
    ['src/utils/chart/_deprecated/README.md', 2]
  ])
  assert.deepEqual(plan.lintHints, ['.eslintignore 里加一行：**/_deprecated/**'])
  assert.match(plan.skipped.find((x) => x.file === 'src/utils/_deprecated/prev.js').reason, /已经隔离过/)
})

test('buildPlan（就近）：挪过去以后会被 import.meta.glob / require.context 重新加载的不移，写明是哪一处', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  // utils 下的 js 会被 require.context 递归加载、chart 下的会被 glob 加载（old.js、Area.js 现在不在范围里：它们在 utils 根下但不匹配）
  repo.write('src/main.js', "import './api/user.js'\nconst ctx = require.context('./utils/_deprecated', false, /\\.js$/)\nconst m = import.meta.glob('./utils/chart/*/*.js')\n")
  repo.commit('批量加载')
  const plan = planFor(repo, dataFor(repo), nearby)
  const reason = (f) => plan.skipped.find((x) => x.file === f)?.reason ?? ''
  assert.match(reason('src/utils/old.js'), /挪到 src\/utils\/_deprecated\/old\.js 以后会被 src\/main\.js:2 的 require\.context\(.*\) 重新加载，不能放这里/)
  assert.match(reason('src/utils/chart/Area.js'), /会被 src\/main\.js:3 的 import\.meta\.glob\('\.\/utils\/chart\/\*\/\*\.js'\) 重新加载/)
  assert.match(reason('src/utils/chart/Point.js'), /会被 src\/main\.js:3 的 import\.meta\.glob/) // 自己也会被圈到：写自己的原因
  assert.equal(plan.moves.some((m) => m.from === 'src/utils/data.json'), true) // .json 不在 require.context 的 /\.js$/ 里
})

test('makeRecaptureCheck：人工确认过的动态加载不算', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.js', 'const load = (p) => import(p)\n')
  repo.commit('动态加载')
  const files = repo.run(['ls-files']).split('\n')
  const readFile = (p) => readFileSync(join(repo.root, p), 'utf8')
  assert.match(makeRecaptureCheck({ files, readFile, config: nearby })('src/a/_deprecated/x.js'), /import\(p\)/)
  const reviewed = resolveConfig({ reviewedDynamicLoads: [{ from: 'src/main.js', expr: 'import(p)', reason: 'CDN' }] })
  assert.equal(makeRecaptureCheck({ files, readFile, config: reviewed })('src/a/_deprecated/x.js'), null)
})

test('makeRecaptureCheck：源码目录外的代码里的加载也查；测试文件里的不查', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  repo.write('build/load.js', "export const load = (n) => import('../src/utils/' + n)\n")
  repo.write('tests/x.spec.js', "export const l = (n) => import('../src/other/' + n)\n")
  repo.commit('目录外的加载')
  const files = repo.run(['ls-files']).split('\n')
  const readFile = (p) => readFileSync(join(repo.root, p), 'utf8')
  const check = makeRecaptureCheck({ files, readFile, config: resolveConfig({ testEntries: ['tests/**/*.spec.js'] }) })
  assert.match(check('src/utils/_deprecated/old.js'), /会被 build\/load\.js:1 的 import\('\.\.\/src\/utils\/' \+ n\) 重新加载/)
  assert.equal(check('src/other/_deprecated/x.js'), null)
})

test('quarantine 配置：layout 只能是 nearby / central；就近隔离不写 dir、base；dirName 是一个目录名', () => {
  assert.deepEqual(resolveConfig({}).quarantine, { layout: 'nearby', dirName: '_deprecated', dir: null, base: null })
  assert.throws(() => resolveConfig({ quarantine: { layout: 'x' } }), /layout 只能是 nearby/)
  assert.throws(() => resolveConfig({ quarantine: { dir: 'src/_d' } }), /只用于 layout: "central"/)
  assert.throws(() => resolveConfig({ quarantine: { dirName: 'a/b' } }), /dirName 必须是一个目录名/)
  assert.equal(resolveConfig({ quarantine: { layout: 'central', dir: 'src/_d', base: 'src' } }).quarantine.dir, 'src/_d')
})

// ---------- 执行：只改工作区，不建分支、不提交 ----------

test('applyPlan：只改工作区——改名用 git mv 暂存好，头注释、路径、README 不暂存；不建分支、不提交', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const head = repo.run(['rev-parse', 'HEAD'])
  const r = applyPlan({ root: repo.root, plan: planFor(repo), config, movedAt: '2026-11-09', branch: 'main' })
  assert.equal(repo.run(['rev-parse', 'HEAD']), head)
  assert.equal(repo.run(['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(repo.run(['branch', '--list']).trim(), '* main')

  assert.deepEqual(r.moved.map((m) => m.to), [
    'src/utils/_deprecated/chart/Area.js',
    'src/utils/_deprecated/chart/Point.js',
    'src/utils/_deprecated/data.json',
    'src/utils/_deprecated/old.js'
  ])
  assert.deepEqual(r.rewrites, [{ file: 'src/utils/_deprecated/chart/Area.js', line: 2, before: '../../api/user.js', after: '@/api/user.js' }])
  assert.deepEqual(r.headers.sort(), ['src/utils/_deprecated/chart/Area.js', 'src/utils/_deprecated/chart/Point.js', 'src/utils/_deprecated/old.js'])
  assert.deepEqual(r.readmes, [{ path: 'src/utils/_deprecated/README.md', created: true }])

  // 暂存区里只有改名（内容不变）
  const staged = repo.run(['diff', '--cached', '--name-status', '-M']).split('\n').sort()
  assert.deepEqual(staged, [
    'R100\tsrc/utils/chart/Area.js\tsrc/utils/_deprecated/chart/Area.js',
    'R100\tsrc/utils/chart/Point.js\tsrc/utils/_deprecated/chart/Point.js',
    'R100\tsrc/utils/data.json\tsrc/utils/_deprecated/data.json',
    'R100\tsrc/utils/old.js\tsrc/utils/_deprecated/old.js'
  ])
  // 其余改动在工作区：头注释、路径改了，README 是新文件
  const unstaged = repo.run(['diff', '--name-only']).split('\n').sort()
  assert.deepEqual(unstaged, ['src/utils/_deprecated/chart/Area.js', 'src/utils/_deprecated/chart/Point.js', 'src/utils/_deprecated/old.js'])
  assert.match(repo.run(['status', '--porcelain']), /\?\? src\/utils\/_deprecated\/README\.md/)
  const rect = readFileSync(join(repo.root, 'src/utils/_deprecated/chart/Area.js'), 'utf8')
  assert.match(rect, /^\/\*\*\n \* \[DEPRECATED\] 已隔离/)
  assert.match(rect, /import \{ u \} from '@\/api\/user\.js'/)
  assert.ok(readFileSync(join(repo.root, 'src/utils/_deprecated/old.js'), 'utf8').startsWith('#!/usr/bin/env node\n/**'))
  assert.match(readFileSync(join(repo.root, 'src/utils/_deprecated/README.md'), 'utf8'), /## 2026-11-09 隔离（code-audit，分支 main）/)

  // 按建议分两次提交，git 认得出改名，历史接得上
  repo.run(['commit', '-q', '-m', 'move'])
  repo.run(['add', '-A'])
  repo.run(['commit', '-q', '-m', 'headers'])
  assert.match(repo.run(['log', '--follow', '--format=%s', '--', 'src/utils/_deprecated/chart/Area.js']), /init/)
})

test('applyPlan：中途出错整体撤回——工作区、暂存区回到执行前，新建的 README 和空目录删掉', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo, dataFor(repo), nearby)
  // 最后一个移动的源文件不存在：git mv 会失败
  plan.moves.push({ ...plan.moves[0], from: 'src/nope.js', to: 'src/new-dir/_deprecated/nope.js', header: null })
  assert.throws(() => applyPlan({ root: repo.root, plan, config: nearby, movedAt: '2026-11-09' }), /隔离没有完成，已撤回/)
  assert.equal(repo.run(['status', '--porcelain', '--untracked-files=all']), '')
  assert.ok(existsSync(join(repo.root, 'src/utils/old.js')))
  assert.equal(existsSync(join(repo.root, 'src/utils/chart/_deprecated')), false)
  assert.equal(existsSync(join(repo.root, 'src/new-dir')), false)
})

test('applyPlan（就近）：每个隔离目录一份 README；暂存区里全是改名', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const r = applyPlan({ root: repo.root, plan: planFor(repo, dataFor(repo), nearby), config: nearby, movedAt: '2026-11-09' })
  assert.deepEqual(r.readmes.map((x) => x.path), ['src/other/_deprecated/README.md', 'src/utils/_deprecated/README.md', 'src/utils/chart/_deprecated/README.md'])
  assert.ok(repo.run(['diff', '--cached', '--name-status', '-M']).split('\n').every((l) => l.startsWith('R100\t')))
  assert.match(readFileSync(join(repo.root, 'src/utils/chart/_deprecated/README.md'), 'utf8'), /^# src\/utils\/chart\/_deprecated（隔离区）/)
  assert.match(readFileSync(join(repo.root, 'src/utils/chart/_deprecated/Area.js'), 'utf8'), /from '\.\/Point\.js'[\s\S]*from '@\/api\/user\.js'/)
})

test('quarantine 命令：--apply 前检查工作区干净、提交对得上；通过后只改工作区，列出改了什么', (t) => {
  const repo = projectRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-q-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'p.js'), "export default { aliases: { '@': 'src' }, quarantine: { layout: 'central', dir: 'src/utils/_deprecated', base: 'src/utils' } }\n")
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dataFor(repo)))
  const args = ['quarantine', '--root', repo.root, '--profile', join(dir, 'p.js'), '--in', join(dir, 'data.json'), '--moved-at', '2026-11-09', '--apply']

  repo.write('src/main.js', '// 改了\n')
  assert.match(cli(...args).stderr, /工作区有没提交的改动/)
  repo.run(['checkout', '--', 'src/main.js'])

  repo.write('src/new.js', '')
  repo.commit('又提交了')
  assert.match(cli(...args).stderr, /不是分析时的提交/)
  repo.run(['reset', '-q', '--hard', 'HEAD~1'])

  const head = repo.run(['rev-parse', 'HEAD'])
  const ok = cli(...args)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /隔离完成（只改了工作区，没有建分支、没有提交）/)
  assert.match(ok.stderr, /移动 4 个文件（git mv，改名已暂存）/)
  assert.match(ok.stderr, /src\/utils\/_deprecated\/chart\/Area\.js 第 2 行：\.\.\/\.\.\/api\/user\.js → @\/api\/user\.js/)
  assert.match(ok.stderr, /接下来由开发人员审核后提交/)
  assert.equal(repo.run(['rev-parse', 'HEAD']), head)
  assert.equal(repo.run(['branch', '--list']).trim(), '* main')
  assert.match(cli('quarantine', '--root', repo.root, '--branch', 'x').stderr, /--branch/) // 不再有 --branch
})

test('applyPlan：写 README 时出错也整体撤回——已经新建的 README 删掉', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo, dataFor(repo), nearby)
  // 最后一份 README 的目录不存在：写到它时失败，前面几份已经写好
  plan.readmes.push({ dir: 'src/zzz/nope', path: 'src/zzz/nope/README.md', exists: false, moves: plan.readmes[0].moves })
  assert.throws(() => applyPlan({ root: repo.root, plan, config: nearby, movedAt: '2026-11-09' }), /隔离没有完成，已撤回/)
  assert.equal(repo.run(['status', '--porcelain', '--untracked-files=all']), '')
  assert.equal(existsSync(join(repo.root, 'src/utils/chart/_deprecated')), false)
})

test('applyPlan：撤回时没被 git 跟踪的 README 写回原内容，不会丢', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo, dataFor(repo), nearby)
  // 隔离目录里本来就有一份没提交的 README（人工写的）
  const own = join(repo.root, 'src/utils/chart/_deprecated/README.md')
  repo.write('src/utils/chart/_deprecated/README.md', '# 人工写的说明\n')
  plan.readmes.push({ dir: 'src/zzz/nope', path: 'src/zzz/nope/README.md', exists: false, moves: plan.readmes[0].moves })
  assert.throws(() => applyPlan({ root: repo.root, plan, config: nearby, movedAt: '2026-11-09' }), /隔离没有完成，已撤回/)
  assert.equal(readFileSync(own, 'utf8'), '# 人工写的说明\n')
  assert.equal(repo.run(['status', '--porcelain', '--untracked-files=all']), '?? src/utils/chart/_deprecated/README.md')
})
