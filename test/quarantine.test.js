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
import { resolveConfig } from '../src/core/config.js'
import { SCHEMA_VERSION, validate } from '../src/core/schema.js'
import { TOOL } from '../src/core/tool.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

/**
 * 小项目：
 * - src/utils/canvas/Rect.js 引用同目录的 Vector2.js（一组）和 ../../api/user.js（在用）
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
  repo.write('src/utils/canvas/Rect.js', "import { V } from './Vector2.js'\nimport { u } from '../../api/user.js'\nexport const R = [V, u]\n")
  repo.write('src/utils/canvas/Vector2.js', 'export const V = 2\n')
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
    item('src/utils/canvas/Rect.js', 'dead', verify(true)),
    item('src/utils/canvas/Vector2.js', 'dead-only-ref', verify(true), [{ from: 'src/utils/canvas/Rect.js', line: 1, via: 'static' }]),
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

const config = resolveConfig({ aliases: { '@': 'src' }, quarantine: { dir: 'src/utils/_deprecated', base: 'src/utils' }, headerTitle: '[DEPRECATED] 已隔离' })
const planFor = (repo, data = dataFor(repo)) => {
  const files = repo.run(['ls-files']).split('\n')
  return buildPlan({ data, config, files, readFile: (p) => readFileSync(join(repo.root, p), 'utf8'), movedAt: '2026-11-09', branch: 'main' })
}

// ---------- 计划 ----------

test('buildPlan：只隔离 dead / dead-only-ref、验证通过、在 base 下、不在隔离区里的；不隔离的写明原因', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo)
  assert.deepEqual(plan.moves.map((m) => [m.from, m.to]), [
    ['src/utils/canvas/Rect.js', 'src/utils/_deprecated/canvas/Rect.js'],
    ['src/utils/canvas/Vector2.js', 'src/utils/_deprecated/canvas/Vector2.js'],
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
  assert.deepEqual(rect.changes, [{ line: 2, before: '../../api/user.js', after: '@/api/user.js' }]) // 同一组的 ./Vector2.js 不用改
  assert.match(rect.header, /^\/\*\*\n \* \[DEPRECATED\] 已隔离/)
  assert.equal(plan.moves[2].header, null) // .json 不能写注释
  assert.match(plan.moves[2].headerSkipped, /不支持为 \.json 文件生成头注释/)
  assert.deepEqual(plan.readme, { path: 'src/utils/_deprecated/README.md', exists: false })
  assert.deepEqual(plan.lintHints, ['.eslintignore 里加一行：src/utils/_deprecated/'])
})

test('buildPlan：一组里有一个不能移，整组都不移；隔离区里已有同名文件的不移；默认隔离区是 <源码目录>/_deprecated', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const data = dataFor(repo)
  data.items.find((i) => i.target === 'src/utils/canvas/Vector2.js').verify.passed = false
  repo.write('src/utils/_deprecated/old.js', '')
  repo.commit('占位')
  const plan = planFor(repo, data)
  assert.deepEqual(plan.moves.map((m) => m.from), ['src/utils/data.json'])
  assert.match(plan.skipped.find((s) => s.file === 'src/utils/canvas/Rect.js').reason, /和 src\/utils\/canvas\/Vector2\.js 互相引用，要一起移/)
  assert.match(plan.skipped.find((s) => s.file === 'src/utils/old.js').reason, /隔离区里已经有同名文件/)

  const defaults = buildPlan({ data: dataFor(repo), config: resolveConfig({}), files: repo.run(['ls-files']).split('\n'), readFile: () => '', movedAt: '2026-11-09' })
  assert.equal(defaults.dir, 'src/_deprecated')
  assert.ok(defaults.moves.some((m) => m.to === 'src/_deprecated/utils/old.js'))
  // 项目里别的隔离区（路径里有 _deprecated）的文件不再移：不会隔离区套隔离区
  assert.equal(defaults.moves.some((m) => m.from === 'src/utils/_deprecated/prev.js'), false)
  assert.match(defaults.skipped.find((x) => x.file === 'src/utils/_deprecated/prev.js').reason, /已经在别的隔离区里（路径里有 _deprecated）/)
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

// ---------- 头注释、README ----------

test('insertHeader：放在最前面；#! 开头的放在它后面', () => {
  assert.equal(insertHeader('a\n', '/** h */'), '/** h */\na\n')
  assert.equal(insertHeader('#!/usr/bin/env node\nx\n', '/** h */'), '#!/usr/bin/env node\n/** h */\nx\n')
})

test('readmeContent：没有就新建；已有的原样保留，在最后追加这一批', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const plan = planFor(repo)
  const created = readmeContent(null, plan, { config, movedAt: '2026-11-09', branchName: 'qb' })
  assert.match(created, /^# src\/utils\/_deprecated（隔离区）/)
  assert.match(created, /## 2026-11-09 隔离（code-audit，分支 qb）/)
  assert.match(created, /\| src\/utils\/_deprecated\/canvas\/Rect\.js \| src\/utils\/canvas\/Rect\.js \|/)
  const appended = readmeContent('# 人工写的\n\n## 已恢复\n\n（暂无）\n\n\n', plan, { config, movedAt: '2026-11-09', branchName: 'qb' })
  assert.ok(appended.startsWith('# 人工写的\n\n## 已恢复\n\n（暂无）\n\n## 2026-11-09 隔离'))
})

// ---------- 执行 ----------

test('applyPlan：新建分支提交两次（第一次只移动，git 认得出改名）；头注释、路径、README 在第二次；原分支不动', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const before = repo.run(['rev-parse', 'HEAD'])
  const r = applyPlan({ root: repo.root, plan: planFor(repo), config, branchName: 'code-audit/q', movedAt: '2026-11-09' })
  assert.equal(r.from, 'main')
  assert.equal(r.commits.length, 2)
  assert.equal(repo.run(['rev-parse', 'main']), before) // 原分支不动
  assert.equal(repo.run(['symbolic-ref', '--short', 'HEAD']), 'code-audit/q')

  // 第一次提交只有改名，内容不变
  const first = repo.run(['show', '--format=', '--name-status', '-M', r.commits[0]]).split('\n').sort()
  assert.deepEqual(first, [
    'R100\tsrc/utils/canvas/Rect.js\tsrc/utils/_deprecated/canvas/Rect.js',
    'R100\tsrc/utils/canvas/Vector2.js\tsrc/utils/_deprecated/canvas/Vector2.js',
    'R100\tsrc/utils/data.json\tsrc/utils/_deprecated/data.json',
    'R100\tsrc/utils/old.js\tsrc/utils/_deprecated/old.js'
  ])
  // 第二次：头注释、相对路径、README
  const rect = readFileSync(join(repo.root, 'src/utils/_deprecated/canvas/Rect.js'), 'utf8')
  assert.match(rect, /^\/\*\*\n \* \[DEPRECATED\] 已隔离/)
  assert.match(rect, /import \{ u \} from '@\/api\/user\.js'/)
  assert.match(rect, /import \{ V \} from '\.\/Vector2\.js'/)
  assert.ok(readFileSync(join(repo.root, 'src/utils/_deprecated/old.js'), 'utf8').startsWith('#!/usr/bin/env node\n/**'))
  assert.equal(readFileSync(join(repo.root, 'src/utils/_deprecated/data.json'), 'utf8'), '{}\n')
  assert.ok(existsSync(join(repo.root, 'src/utils/_deprecated/README.md')))
  assert.equal(repo.run(['status', '--porcelain']), '')
  // 历史接得上
  assert.match(repo.run(['log', '--follow', '--format=%s', '--', 'src/utils/_deprecated/canvas/Rect.js']), /init/)
})

test('applyPlan：提交钩子没通过时整体撤回：切回原分支，删掉新分支，工作区和执行前一样', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const hook = join(repo.root, '.git/hooks/pre-commit')
  writeFileSync(hook, '#!/bin/sh\necho "lint 没通过" >&2\nexit 1\n')
  chmodSync(hook, 0o755)
  const before = repo.run(['rev-parse', 'HEAD'])
  assert.throws(() => applyPlan({ root: repo.root, plan: planFor(repo), config, branchName: 'code-audit/q', movedAt: '2026-11-09' }), /已撤回（切回 main，删掉分支 code-audit\/q）[\s\S]*lint 没通过/)
  assert.equal(repo.run(['symbolic-ref', '--short', 'HEAD']), 'main')
  assert.equal(repo.run(['rev-parse', 'HEAD']), before)
  assert.equal(repo.run(['branch', '--list', 'code-audit/q']), '')
  assert.equal(repo.run(['status', '--porcelain']), '')
  assert.ok(existsSync(join(repo.root, 'src/utils/old.js')))
})

// ---------- 命令 ----------

test('quarantine 命令：不带 --apply 只打印计划，什么都不改', (t) => {
  const repo = projectRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-q-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'p.js'), "export default { aliases: { '@': 'src' }, quarantine: { dir: 'src/utils/_deprecated', base: 'src/utils' } }\n")
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dataFor(repo)))
  const before = repo.run(['rev-parse', 'HEAD'])
  const r = cli('quarantine', '--root', repo.root, '--profile', join(dir, 'p.js'), '--in', join(dir, 'data.json'), '--moved-at', '2026-11-09')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /要隔离 4 个文件/)
  assert.match(r.stderr, /src\/utils\/canvas\/Rect\.js → src\/utils\/_deprecated\/canvas\/Rect\.js/)
  assert.match(r.stderr, /第 2 行：\.\.\/\.\.\/api\/user\.js → @\/api\/user\.js/)
  assert.match(r.stderr, /不隔离 4 个/)
  assert.match(r.stderr, /只是计划，没有改任何东西/)
  assert.equal(repo.run(['rev-parse', 'HEAD']), before)
  assert.equal(repo.run(['branch', '--list']).trim(), '* main')
})

test('quarantine 命令：--apply 前检查工作区干净、提交对得上、分支名没被占用；通过后执行', (t) => {
  const repo = projectRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-q-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'p.js'), "export default { aliases: { '@': 'src' }, quarantine: { dir: 'src/utils/_deprecated', base: 'src/utils' } }\n")
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dataFor(repo)))
  const args = ['quarantine', '--root', repo.root, '--profile', join(dir, 'p.js'), '--in', join(dir, 'data.json'), '--moved-at', '2026-11-09', '--apply']

  repo.write('src/main.js', '// 改了\n')
  assert.match(cli(...args).stderr, /工作区有没提交的改动/)
  repo.run(['checkout', '--', 'src/main.js'])

  repo.run(['branch', 'code-audit/quarantine-2026-11-09'])
  assert.match(cli(...args).stderr, /分支 code-audit\/quarantine-2026-11-09 已经存在/)
  repo.run(['branch', '-D', 'code-audit/quarantine-2026-11-09'])

  repo.write('src/new.js', '')
  repo.commit('又提交了')
  assert.match(cli(...args).stderr, /不是分析时的提交/)
  repo.run(['reset', '-q', '--hard', 'HEAD~1'])

  const ok = cli(...args)
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /在新分支 code-audit\/quarantine-2026-11-09 上提交了 2 次（没有 push）/)
  assert.equal(repo.run(['symbolic-ref', '--short', 'HEAD']), 'code-audit/quarantine-2026-11-09')
})

test('数据格式：测试用的数据本身是合法的', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  assert.deepEqual(validate(dataFor(repo)), [])
})
