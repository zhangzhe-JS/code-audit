import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRepo } from './helpers/repo.js'
import { findBranchRefs, globToRegExp } from '../src/collect/branch-refs.js'
import { judge } from '../src/rules/index.js'
import { resolveConfig } from '../src/core/config.js'

/**
 * main 上 src/x.js、src/y.js、src/z.js 都没人用；各分支：
 * - feature/new-page（新）：新增 src/page.js import 了 x
 * - feature/edit-y：改了 y 本身
 * - feature/delete-z：删了 z（不算在用）
 * - merged：import 了 z，但已经合并进 main（不算）
 * - old/stale：很久以前 import 了 y
 * main 在 feature 分出去以后去掉了 src/late.js 里对 z 的引用：分支没动 late.js，合并后用 main 的版本，不算
 */
function branchRepo() {
  const repo = createRepo()
  repo.write('src/main.js', "import './used.js'\n")
  repo.write('src/used.js', '')
  for (const f of ['x', 'y', 'z']) repo.write(`src/${f}.js`, `export const ${f} = 1\n`)
  repo.commit('init', { date: '2024-01-01' })

  repo.run(['checkout', '-q', '-b', 'old/stale'])
  repo.write('src/legacy.js', "import { y } from './y.js'\n")
  repo.commit('old', { date: '2024-01-02' })

  repo.run(['checkout', '-q', 'main'])
  repo.run(['checkout', '-q', '-b', 'merged'])
  repo.write('src/m.js', "import './z.js'\n")
  repo.commit('merged work', { date: '2024-02-01' })
  repo.run(['checkout', '-q', 'main'])
  repo.merge('merged', 'merge', { date: '2024-02-02' })
  repo.write('src/m.js', '') // main 后来又不用 z 了
  repo.commit('drop z', { date: '2024-02-03' })

  repo.write('src/late.js', "import './z.js'\n")
  repo.commit('late uses z', { date: '2024-05-01' })

  for (const [name, change] of [
    ['feature/new-page', () => repo.write('src/page.js', "import { x } from '@/x.js'\n")],
    ['feature/edit-y', () => repo.write('src/y.js', 'export const y = 2\n')],
    ['feature/delete-z', () => repo.run(['rm', '-q', 'src/z.js'])]
  ]) {
    repo.run(['checkout', '-q', '-b', name, 'main'])
    change()
    repo.commit(name, { date: '2024-06-01' })
  }
  repo.run(['checkout', '-q', 'main'])
  repo.write('src/late.js', '')
  repo.commit('main drops z again', { date: '2024-06-02' })
  return repo
}

const scan = (repo, branches = {}) =>
  findBranchRefs({
    root: repo.root,
    rev: repo.run(['rev-parse', 'HEAD']),
    targets: ['src/x.js', 'src/y.js', 'src/z.js'],
    extensions: ['.js'],
    aliases: { '@': 'src' },
    branches: resolveConfig({ branches }).branches
  })

test('findBranchRefs：分支新增的文件 import 了候选、分支改了候选本身，都算；删了它、已合并的不算', (t) => {
  const repo = branchRepo()
  t.after(() => repo.cleanup())
  const r = scan(repo)
  assert.deepEqual(r.refs.get('src/x.js'), [{ branch: 'feature/new-page', date: '2024-06-01', kind: 'import', from: 'src/page.js', line: 1 }])
  const y = r.refs.get('src/y.js').map((x) => [x.branch, x.kind]).sort()
  assert.deepEqual(y, [['feature/edit-y', 'modified'], ['old/stale', 'import']])
  assert.equal(r.refs.has('src/z.js'), false)
  assert.deepEqual(r.checked.map((b) => b.name).sort(), ['feature/delete-z', 'feature/edit-y', 'feature/new-page', 'old/stale'])
})

test('findBranchRefs：按名字排除、太久没动的不查，并说明原因', (t) => {
  const repo = branchRepo()
  t.after(() => repo.cleanup())
  const r = scan(repo, { ignore: ['feature/edit-*'], maxAgeDays: 30 })
  assert.deepEqual(r.refs.get('src/y.js'), undefined)
  assert.deepEqual(
    r.skipped.map((s) => [s.name, s.reason.replace(/\d+ 天前/, 'N 天前')]).sort(),
    [['feature/edit-y', '配置里排除'], ['old/stale', '最后提交在 N 天前，超过 30 天']]
  )
})

test('findBranchRefs：同一个提交的多个分支名合在一起；指向别的分支的名字（origin/HEAD）跳过', (t) => {
  const repo = branchRepo()
  t.after(() => repo.cleanup())
  repo.run(['branch', 'copy-of-new-page', 'feature/new-page'])
  repo.run(['symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/heads/feature/new-page'])
  const r = scan(repo)
  assert.deepEqual(r.refs.get('src/x.js').map((x) => x.branch), ['copy-of-new-page、feature/new-page'])
})

test('findBranchRefs：没有候选时什么都不查', (t) => {
  const repo = branchRepo()
  t.after(() => repo.cleanup())
  const r = findBranchRefs({ root: repo.root, rev: 'HEAD', targets: [], extensions: ['.js'], branches: resolveConfig({}).branches })
  assert.deepEqual([r.refs.size, r.checked.length], [0, 0])
})

test('globToRegExp：* 不跨 /，** 跨 /', () => {
  assert.ok(globToRegExp('origin/dev_2.*').test('origin/dev_2.4.2'))
  assert.ok(!globToRegExp('origin/dev_2.*').test('origin/dev_2/x'))
  assert.ok(globToRegExp('origin/**').test('origin/a/b'))
  assert.ok(!globToRegExp('dev_2.?').test('dev_2x4'))
})

test('pending 规则：判为 pending，证据写明分支和日期；被它引用的候选跟着保留', () => {
  const ev = { rule: 'knip-unreachable', detail: '走不到' }
  const branchRefs = new Map([
    ['src/x.js', [{ branch: 'feature/a', date: '2024-06-01', kind: 'import', from: 'src/page.js', line: 3 }]],
    ['src/y.js', [{ branch: 'feature/b', date: '2024-06-02', kind: 'modified' }]]
  ])
  const importers = new Map([['src/child.js', [{ from: 'src/x.js', line: 1 }]]])
  const files = ['src/x.js', 'src/y.js', 'src/child.js'].map((file) => ({ file, evidence: [ev] }))
  const r = Object.fromEntries(judge({ files, branchRefs, importers }).map((x) => [x.file, x]))
  assert.equal(r['src/x.js'].status, 'pending')
  assert.match(r['src/x.js'].evidence[1].detail, /没合并的分支 feature\/a（最后提交 2024-06-01）里 src\/page\.js:3 引用了它/)
  assert.match(r['src/y.js'].evidence[1].detail, /feature\/b（最后提交 2024-06-02）改了这个文件/)
  assert.equal(r['src/child.js'].status, 'pending')
})

test('branches 配置：默认都查；写错时报错', () => {
  assert.deepEqual(resolveConfig({}).branches, { ignore: [], maxAgeDays: null })
  assert.deepEqual(resolveConfig({ branches: { maxAgeDays: 90 } }).branches, { ignore: [], maxAgeDays: 90 })
  assert.throws(() => resolveConfig({ branches: { ignore: 'x' } }), /branches\.ignore 必须是/)
  assert.throws(() => resolveConfig({ branches: { maxAgeDays: 0 } }), /maxAgeDays 必须是正整数/)
  assert.throws(() => resolveConfig({ branches: { only: [] } }), /branches 里不认识的字段：only/)
})
