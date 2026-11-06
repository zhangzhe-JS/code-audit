import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRepo } from './helpers/repo.js'
import { traceHistory, defaultPattern } from '../src/history/index.js'
import { validate } from '../src/core/schema.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

/** 一个典型的隔离场景：引入 → 被引用 → 引用被删 → 移进 _deprecated */
function quarantinedRepo() {
  const repo = createRepo()
  repo.write('src/utils/math.js', 'export const add = (a, b) => a + b\n')
  const introduced = repo.commit('新增 math', { date: '2024-01-01', author: 'alice' })
  repo.write('src/views/Home.vue', "<script>\nimport { add } from '@/utils/math'\n</script>\n")
  repo.commit('首页使用 math', { date: '2024-02-01', author: 'bob' })
  repo.write('src/views/Home.vue', '<script>\nexport default {}\n</script>\n')
  const lost = repo.commit('首页去掉 math', { date: '2024-03-01', author: 'carol' })
  repo.write('src/utils/_deprecated/.keep', '')
  repo.run(['mv', 'src/utils/math.js', 'src/utils/_deprecated/math.js'])
  repo.commit('隔离 math', { date: '2024-04-01' })
  return { repo, introduced, lost }
}

// ---------- traceHistory ----------

test('traceHistory：组合出引入、时间线、失去引用', (t) => {
  const { repo, introduced, lost } = quarantinedRepo()
  t.after(() => repo.cleanup())

  const { history: h } = traceHistory({ root: repo.root, file: 'src/utils/_deprecated/math.js', pattern: 'utils/math' })
  assert.equal(h.introduced.hash, introduced)
  assert.equal(h.lostRef.hash, lost)
  assert.deepEqual(h.timeline.map((e) => `${e.commit.date} ${e.change} ${e.from}`), [
    '2024-02-01 add src/views/Home.vue',
    '2024-03-01 remove src/views/Home.vue'
  ])
})

test('traceHistory 的结果符合 schema 里的 History 结构', (t) => {
  const { repo } = quarantinedRepo()
  t.after(() => repo.cleanup())

  const { history } = traceHistory({ root: repo.root, file: 'src/utils/_deprecated/math.js', pattern: 'utils/math' })
  const report = {
    version: 1,
    generatedAt: new Date().toISOString(),
    tool: { name: 'code-audit', version: '1.0.0' },
    project: { name: 'demo', root: repo.root, rev: repo.run(['rev-parse', 'HEAD']), entries: ['src/main.js'] },
    items: [{
      id: 'file:src/utils/_deprecated/math.js',
      kind: 'file',
      target: 'src/utils/_deprecated/math.js',
      status: 'dead',
      evidence: [{ rule: 'no-import', detail: '无引用' }],
      refs: [],
      history,
      verify: null
    }]
  }
  assert.deepEqual(validate(report), [])
})

test('traceHistory：文件不存在时报错', (t) => {
  const { repo } = quarantinedRepo()
  t.after(() => repo.cleanup())
  assert.throws(() => traceHistory({ root: repo.root, file: 'src/none.js', pattern: 'none' }), /找不到文件/)
})

test('defaultPattern：去掉 src/ 和扩展名', () => {
  assert.equal(defaultPattern('src/utils/math.js'), 'utils/math')
  assert.equal(defaultPattern('src/views/Home.vue'), 'views/Home')
  assert.equal(defaultPattern('lib/a.b.js'), 'lib/a.b')
  assert.equal(defaultPattern('src/utils/ setting.js'), 'utils/ setting') // 空格保留，当年就是这么引用的
  assert.equal(defaultPattern('src/utils/relayout/index.js'), 'utils/relayout') // 引用目录时不写 index
})

// ---------- 命令行 ----------

test('history 命令输出 JSON', (t) => {
  const { repo, lost } = quarantinedRepo()
  t.after(() => repo.cleanup())

  const r = cli('history', '--root', repo.root, '--file', 'src/utils/_deprecated/math.js', '--pattern', 'utils/math')
  assert.equal(r.status, 0, r.stderr)
  const out = JSON.parse(r.stdout)
  assert.equal(out.pattern, 'utils/math')
  assert.equal(out.history.lostRef.hash, lost)
})

test('history 命令缺少 --file 时报错，退出码为 1', () => {
  const r = cli('history')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /缺少 --file/)
})

test('history 命令遇到不认识的参数时报错，退出码为 1', () => {
  const r = cli('history', '--file', 'a.js', '--oops')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /用法/)
})

test('history 命令仓库不存在时报错，退出码为 1', () => {
  const r = cli('history', '--root', '/no/such/repo', '--file', 'a.js')
  assert.equal(r.status, 1)
  assert.ok(r.stderr.length > 0)
})

// ---------- finicr-web 实测发现的问题 ----------

test('不传 pattern 时，用文件最初的路径推出（移动过的文件也能查到引用）', (t) => {
  const { repo, lost } = quarantinedRepo()
  t.after(() => repo.cleanup())

  const r = traceHistory({ root: repo.root, file: 'src/utils/_deprecated/math.js' })
  assert.equal(r.pattern, 'utils/math')
  assert.deepEqual(r.paths, ['src/utils/_deprecated/math.js', 'src/utils/math.js'])
  assert.equal(r.history.lostRef.hash, lost)
})

test('git 没认出来的移动（移动时加了大段头注释）：仍追到最初的引入', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/math.js', 'export const add = 1\n')
  const first = repo.commit('新增 math', { date: '2022-04-14', author: 'alice' })

  // 移动的同时加上很长的头注释，内容相似度太低，git 认不出是改名
  repo.run(['rm', '-q', 'src/utils/math.js'])
  repo.write('src/utils/_deprecated/math.js', '/**\n' + ' * 头注释\n'.repeat(30) + ' */\nexport const add = 1\n')
  repo.commit('隔离并加头注释', { date: '2026-11-05' })

  const r = traceHistory({ root: repo.root, file: 'src/utils/_deprecated/math.js' })
  assert.equal(r.history.introduced.hash, first)
  assert.deepEqual(r.paths, ['src/utils/_deprecated/math.js', 'src/utils/math.js'])
})

test('移动时文件名去掉了空格，也能认出来', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/ setting.js', 'export const s = 1\n')
  const first = repo.commit('新增 setting', { date: '2025-03-25' })
  repo.run(['rm', '-q', 'src/utils/ setting.js'])
  repo.write('src/utils/_deprecated/setting.js', '/**\n' + ' * 头注释\n'.repeat(30) + ' */\nexport const s = 1\n')
  repo.commit('隔离', { date: '2026-11-05' })

  assert.equal(traceHistory({ root: repo.root, file: 'src/utils/_deprecated/setting.js' }).history.introduced.hash, first)
})

test('同一次提交删掉了多个同名文件：无法确定来源，不乱追', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/a/index.js', 'a\n')
  repo.write('src/b/index.js', 'b\n')
  repo.commit('新增两个 index', { date: '2024-01-01' })
  repo.run(['rm', '-q', 'src/a/index.js', 'src/b/index.js'])
  repo.write('src/c/index.js', '/**\n' + ' * 新内容\n'.repeat(30) + ' */\n')
  const added = repo.commit('删掉两个、新增一个', { date: '2024-02-01' })

  assert.equal(traceHistory({ root: repo.root, file: 'src/c/index.js', pattern: 'c/index' }).history.introduced.hash, added)
})

test('从别的文件复制出来的：引入是复制那次，不追被复制文件的历史', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  const content = 'export const worker = 1\n'.repeat(20)
  repo.write('public/pdf.worker.mjs', content)
  repo.commit('public 下新增 worker', { date: '2024-10-16' })

  // 复制到 src/utils，同时改动原文件，让 git 能识别出复制
  repo.write('src/utils/pdf.worker.mjs', content)
  repo.write('public/pdf.worker.mjs', content + '// changed\n')
  const copied = repo.commit('复制到 utils', { date: '2024-10-17' })

  const r = traceHistory({ root: repo.root, file: 'src/utils/pdf.worker.mjs' })
  assert.equal(r.history.introduced.hash, copied)
  assert.deepEqual(r.paths, ['src/utils/pdf.worker.mjs'])
})

test('README、构建产物、json 里出现路径不算引用', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/math.js', '1\n')
  repo.commit('新增 math', { date: '2024-01-01' })
  repo.write('src/utils/_deprecated/README.md', '| utils/math | 原路径 src/utils/math.js |\n')
  repo.write('stats.html', '<div>src/utils/math.js</div>\n')
  repo.write('untranslated.json', '{"k": "utils/math"}\n')
  repo.write('src/a.vue', "<script>\nimport '@/utils/math'\n</script>\n")
  repo.commit('各种文件', { date: '2024-02-01' })

  const { history } = traceHistory({ root: repo.root, file: 'src/utils/math.js' })
  assert.deepEqual(history.timeline.map((e) => e.from), ['src/a.vue'])
})

test('删除后又重新加入：引入取最早的那次', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/utils.js', 'v1\n')
  const first = repo.commit('第一次加入', { date: '2022-04-19' })
  repo.run(['rm', '-q', 'src/utils/utils.js'])
  repo.write('src/other.js', '1\n')
  repo.commit('删除', { date: '2022-06-07' })
  repo.write('src/utils/utils.js', 'v2\n')
  repo.commit('重新加入', { date: '2025-09-09' })

  assert.equal(traceHistory({ root: repo.root, file: 'src/utils/utils.js' }).history.introduced.hash, first)
})

test('在分支上加入的文件：引入是合并进主线的那个提交（和时间线同一套规则）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  // 每个文件内容都不一样：内容相同的文件会被 git 认成「复制」，测不到想测的规则
  repo.write('src/main.js', 'main\n')
  repo.commit('init', { date: '2024-01-01' })
  repo.run(['checkout', '-q', '-b', 'feat'])
  repo.write('src/utils/x.js', 'export const x = "only in feat"\n')
  repo.commit('分支上新增 x', { date: '2024-02-01' })
  repo.run(['checkout', '-q', 'main'])
  repo.write('src/other.js', 'other\n')
  repo.commit('主线上的其他改动', { date: '2024-02-15' })
  const merge = repo.merge('feat', '合并 feat', { date: '2024-03-01' })

  const { introduced } = traceHistory({ root: repo.root, file: 'src/utils/x.js' }).history
  assert.equal(introduced.hash, merge)
  assert.equal(introduced.date, '2024-03-01')
})
