import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRepo } from './helpers/repo.js'
import { findIntroduced } from '../src/history/introduced.js'
import { buildTimeline, findLostRef, refsAt } from '../src/history/refs.js'

test('找到文件最初被加入的提交', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup()) // 测试结束后删除临时仓库，失败了也会执行

  repo.write('src/a.js', 'export const a = 1\n')
  const first = repo.commit('feat: 新增 a', { date: '2024-01-01', author: 'alice' })

  repo.write('src/a.js', 'export const a = 2\n')
  repo.commit('fix: 修改 a', { date: '2024-02-01', author: 'bob' })

  const c = findIntroduced(repo.root, 'src/a.js')
  assert.equal(c.hash, first)
  assert.equal(c.date, '2024-01-01')
  assert.equal(c.author, 'alice')
  assert.equal(c.subject, 'feat: 新增 a')
})

test('文件移动过，仍然找到最初加入的提交，而不是移动的那次', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/a.js', 'export const a = 1\n')
  const first = repo.commit('feat: 新增 a', { date: '2024-01-01' })

  repo.write('src/_deprecated/.keep', '')
  repo.run(['mv', 'src/a.js', 'src/_deprecated/a.js'])
  repo.commit('chore: 隔离 a', { date: '2025-01-01' })

  const c = findIntroduced(repo.root, 'src/_deprecated/a.js')
  assert.equal(c.hash, first)
})

test('文件不存在时返回 null', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/a.js', '1\n')
  repo.commit('init')

  assert.equal(findIntroduced(repo.root, 'src/none.js'), null)
})
// ---------- 引用时间线与失去引用 ----------

test('时间线：记录引用的增加、删除和注释掉', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/x.js', 'export const x = 1\n')
  repo.commit('新增 x', { date: '2024-01-01' })
  repo.write('src/a.js', "import { x } from './utils/x.js'\n")
  repo.commit('a 引用 x', { date: '2024-02-01' })
  repo.write('src/b.js', "import { x } from '@/utils/x.js'\n")
  repo.commit('b 引用 x', { date: '2024-03-01' })
  repo.write('src/a.js', 'export {}\n')
  repo.commit('a 去掉引用', { date: '2024-04-01' })
  repo.write('src/b.js', "// import { x } from '@/utils/x.js'\n")
  const last = repo.commit('b 注释掉引用', { date: '2024-05-01' })

  const timeline = buildTimeline(repo.root, 'utils/x', { exclude: 'src/utils/x.js' })

  assert.deepEqual(
    timeline.map((e) => `${e.commit.date} ${e.change} ${e.from}`),
    [
      '2024-02-01 add src/a.js',
      '2024-03-01 add src/b.js',
      '2024-04-01 remove src/a.js',
      '2024-05-01 remove src/b.js'
    ]
  )
  assert.equal(findLostRef(timeline).hash, last)
})

test('分支上去掉引用再合并：失去引用是合并提交，日期是合并那天', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/x.js', '1\n')
  repo.commit('新增 x', { date: '2024-01-01' })
  repo.write('src/a.js', "import './utils/x.js'\n")
  repo.commit('a 引用 x', { date: '2024-02-01' })

  repo.run(['checkout', '-q', '-b', 'feat'])
  repo.write('src/a.js', 'export {}\n')
  repo.commit('分支上去掉引用', { date: '2024-03-01' })

  repo.run(['checkout', '-q', 'main'])
  repo.write('src/other.js', '1\n')
  repo.commit('主线上的其他改动', { date: '2024-03-15' })
  const merge = repo.merge('feat', '合并 feat', { date: '2024-04-01' })

  const lost = findLostRef(buildTimeline(repo.root, 'utils/x', { exclude: 'src/utils/x.js' }))
  assert.equal(lost.hash, merge)
  assert.equal(lost.date, '2024-04-01') // 不是分支上的 03-01
})

test('从来没被引用：时间线为空，失去引用为 null', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/x.js', '1\n')
  repo.commit('新增 x')

  const timeline = buildTimeline(repo.root, 'utils/x', { exclude: 'src/utils/x.js' })
  assert.deepEqual(timeline, [])
  assert.equal(findLostRef(timeline), null)
})

test('pattern 里有正则特殊字符时，按字面匹配', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/routes/+page.js', '1\n')
  repo.commit('新增页面', { date: '2024-01-01' })
  repo.write('src/a.js', "import './routes/+page.js'\n")
  repo.commit('a 引用页面', { date: '2024-02-01' })

  const timeline = buildTimeline(repo.root, 'routes/+page', { exclude: 'src/routes/+page.js' })
  assert.equal(timeline.length, 1)
  assert.equal(timeline[0].from, 'src/a.js')
})

test('块注释包住的引用不算，行首块注释后面的代码仍算', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/utils/x.js', '1\n')
  repo.commit('新增 x', { date: '2024-01-01' })
  repo.write('src/a.js', "/*\nimport './utils/x.js'\n*/\n")
  repo.write('src/b.js', "/* eslint-disable */ import './utils/x.js'\n")
  repo.commit('a 和 b', { date: '2024-02-01' })

  const timeline = buildTimeline(repo.root, 'utils/x', { exclude: 'src/utils/x.js' })
  assert.deepEqual(timeline.map((e) => e.from), ['src/b.js'])
})

// ---------- 错误处理 ----------

test('提交号无效时 refsAt 抛错，不当成没有引用', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/a.js', '1\n')
  repo.commit('init')

  assert.throws(() => refsAt(repo.root, 'f'.repeat(40), 'x'), /git grep/)
})

test('仓库不存在时 buildTimeline 抛错', () => {
  assert.throws(() => buildTimeline('/no/such/repo', 'x'))
})

test('仓库或提交号无效时 findIntroduced 抛错，文件不存在才返回 null', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/a.js', '1\n')
  repo.commit('init')

  assert.equal(findIntroduced(repo.root, 'src/none.js'), null)
  assert.throws(() => findIntroduced(repo.root, 'src/a.js', 'no-such-rev'))
  assert.throws(() => findIntroduced('/no/such/repo', 'src/a.js'))
})

test('目标文件改名前的旧路径不会被当成引用方', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  // 目标文件自己的内容里就包含 pattern
  repo.write('src/a.js', "export const self = 'utils/a'\n")
  repo.commit('新增 a', { date: '2024-01-01' })
  repo.write('src/b.js', "import './utils/a.js'\n")
  repo.commit('b 引用 a', { date: '2024-02-01' })
  repo.write('src/utils/.keep', '')
  repo.run(['mv', 'src/a.js', 'src/utils/a.js'])
  repo.commit('a 移到 utils', { date: '2024-03-01' })

  const timeline = buildTimeline(repo.root, 'utils/a', { exclude: 'src/utils/a.js' })
  assert.deepEqual(timeline.map((e) => `${e.change} ${e.from}`), ['add src/b.js'])
})

test('不完整的时间线：findLostRef 抛错，不猜结论', () => {
  const c = { hash: 'a'.repeat(40), date: '2024-01-01', author: 'a', subject: 's' }
  assert.throws(() => findLostRef([{ commit: c, change: 'remove', from: 'src/a.js' }]), /从未引入/)
  assert.throws(
    () => findLostRef([
      { commit: c, change: 'add', from: 'src/a.js' },
      { commit: c, change: 'add', from: 'src/a.js' }
    ]),
    /重复引入/
  )
})
