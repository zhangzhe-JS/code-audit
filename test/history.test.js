import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRepo } from './helpers/repo.js'
import { findIntroduced } from '../src/history/introduced.js'
import { buildTimeline, findLostRef, refsAt } from '../src/history/refs.js'
import { git } from '../src/history/git.js'

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

test('中文文件名：引用方和目标文件的路径原样处理，不被 git 转义', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/工具/数学.js', 'export const add = 1\n')
  const introduced = repo.commit('新增', { date: '2024-01-01' })
  repo.write('src/页面/首页可用.js', "import { add } from '@/工具/数学'\n")
  const added = repo.commit('引用', { date: '2024-02-01' })
  repo.write('src/页面/首页可用.js', 'export {}\n')
  const removed = repo.commit('去掉引用', { date: '2024-03-01' })

  const timeline = buildTimeline(repo.root, '工具/数学', { exclude: 'src/工具/数学.js' })
  assert.deepEqual(timeline.map((e) => [e.commit.hash, e.change, e.from]), [
    [added, 'add', 'src/页面/首页可用.js'],
    [removed, 'remove', 'src/页面/首页可用.js']
  ])
  assert.equal(findIntroduced(repo.root, 'src/工具/数学.js').hash, introduced)
})

test('文件名里有引号时明确报错，不拿转义后的路径去查', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/a.js', 'export const a = 1\n')
  repo.write('src/say"hi".js', "import '@/a'\n")
  repo.commit('init')
  assert.throws(() => buildTimeline(repo.root, 'a', { exclude: 'src/a.js' }), /文件名里有引号、反斜杠或控制字符/)
})

test('git raw：输出原样返回，以空格开头的文件名不会被去掉空格', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write(' a.js', '')
  repo.commit('init')
  assert.deepEqual(git(repo.root, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean), [' a.js'])
  assert.equal(git(repo.root, ['ls-files']), 'a.js') // 默认去掉首尾空白
})

test('refsAt / buildTimeline：类型声明文件（.d.ts）不算引用方', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/components/Kx.vue', '<template><i /></template>\n')
  repo.write('src/App.vue', "<script>\nimport Kx from './components/Kx.vue'\n</script>\n")
  repo.write('src/components.d.ts', "export interface GlobalComponents { Kx: typeof import('./components/Kx.vue')['default'] }\n")
  repo.commit('add', { date: '2024-01-01' })
  repo.write('src/App.vue', '<script>\n</script>\n')
  const lost = repo.commit('drop', { date: '2024-02-01' })

  assert.deepEqual([...refsAt(repo.root, 'HEAD', 'components/Kx', new Set(), ['.vue', '.ts'])], [])
  const timeline = buildTimeline(repo.root, 'components/Kx', { exclude: ['src/components/Kx.vue'], extensions: ['.vue', '.ts'] })
  assert.deepEqual(timeline.map((e) => [e.change, e.from]), [['add', 'src/App.vue'], ['remove', 'src/App.vue']])
  assert.equal(findLostRef(timeline).hash, lost)
})

// ---------- 按 import 路径解析引用 ----------

test('refsAt：同目录的相对路径（./math）认得出；省略扩展名、别名、目录 index 都认', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/math.js', '')
  repo.write('src/utils/layout/index.js', '')
  repo.write('src/utils/sum.js', "import { a } from './math'\n")
  repo.write('src/views/A.vue', "<script>\nimport m from '@/utils/math.js'\nimport l from '../utils/layout'\n</script>\n")
  repo.write('src/b.js', "const x = require('./utils/math')\n")
  repo.commit('init')
  const refs = (paths, pattern) => [...refsAt(repo.root, 'HEAD', pattern, new Set(paths), ['.js', '.vue'], { '@': 'src' })].sort()
  assert.deepEqual(refs(['src/utils/math.js'], 'utils/math'), ['src/b.js', 'src/utils/sum.js', 'src/views/A.vue'])
  assert.deepEqual(refs(['src/utils/layout/index.js'], 'utils/layout'), ['src/views/A.vue'])
})

test('refsAt：名字相近的文件、同名目录下的其他文件、接口地址字符串、.vue 模板注释、JS 注释都不算', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/math.js', '')
  repo.write('src/api/document.js', '')
  repo.write('src/config/field/index.js', '')
  repo.write('src/a.js', "import c from './utils/math.config'\nimport d from './config/field/other'\nconst url = '/api/document/stream'\n// import m from './utils/math'\n")
  repo.write('src/B.vue', "<template>\n  <!-- <x src=\"./utils/math\" /> -->\n</template>\n<script>\nexport default {}\n</script>\n")
  repo.commit('init')
  const refs = (paths, pattern) => [...refsAt(repo.root, 'HEAD', pattern, new Set(paths), ['.js', '.vue'], { '@': 'src' })]
  assert.deepEqual(refs(['src/utils/math.js'], 'utils/math'), [])
  assert.deepEqual(refs(['src/api/document.js'], 'api/document'), [])
  assert.deepEqual(refs(['src/config/field/index.js'], 'config/field'), [])
})

test('refsAt：别名没配置时退回按 pattern 字面匹配，不会漏', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/math.js', '')
  repo.write('src/a.js', "import m from '~/utils/math'\nimport n from 'utils/math'\n")
  repo.commit('init')
  assert.deepEqual([...refsAt(repo.root, 'HEAD', 'utils/math', new Set(['src/utils/math.js']), ['.js'])], ['src/a.js'])
})

test('buildTimeline：只用相对路径引用的文件，时间线完整（以前按字面搜 utils/math 会漏）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/math.js', '')
  repo.commit('add math', { date: '2024-01-01' })
  repo.write('src/utils/sum.js', "import { a } from './math'\n")
  repo.commit('use math', { date: '2024-02-01' })
  repo.write('src/utils/sum.js', 'export const s = 1\n')
  const lost = repo.commit('drop math', { date: '2024-03-01' })
  const timeline = buildTimeline(repo.root, 'utils/math', { exclude: ['src/utils/math.js'], extensions: ['.js'] })
  assert.deepEqual(timeline.map((e) => [e.change, e.from]), [['add', 'src/utils/sum.js'], ['remove', 'src/utils/sum.js']])
  assert.equal(findLostRef(timeline).hash, lost)
})

test('buildTimeline：引用方改名记一条 rename，不记成去掉 + 新增；失去引用照常判断', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/math.js', '')
  repo.write('src/views/Old.vue', "<script>\nimport m from '../utils/math'\nexport default { name: 'Old', data() { return { a: 1, b: 2, c: 3 } } }\n</script>\n")
  repo.commit('use', { date: '2024-01-01' })
  repo.run(['mv', 'src/views/Old.vue', 'src/views/New.vue'])
  const renamed = repo.commit('rename referrer', { date: '2024-02-01' })
  repo.write('src/views/New.vue', '<script>\nexport default {}\n</script>\n')
  const lost = repo.commit('drop', { date: '2024-03-01' })
  const timeline = buildTimeline(repo.root, 'utils/math', { exclude: ['src/utils/math.js'], extensions: ['.vue', '.js'] })
  assert.deepEqual(timeline.map((e) => [e.change, e.from, e.previous]), [
    ['add', 'src/views/Old.vue', undefined],
    ['rename', 'src/views/New.vue', 'src/views/Old.vue'],
    ['remove', 'src/views/New.vue', undefined]
  ])
  assert.equal(timeline[1].commit.hash, renamed)
  assert.equal(findLostRef(timeline).hash, lost)
})

test('traceHistory：引入是合并提交时，补上分支上真正新增文件的提交（作者）', async (t) => {
  const { traceHistory } = await import('../src/history/index.js')
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.js', '')
  repo.commit('init', { date: '2024-01-01', author: 'alice' })
  repo.run(['checkout', '-q', '-b', 'feature'])
  repo.write('src/utils/math.js', 'export const a = 1\n')
  const onBranch = repo.commit('add math', { date: '2024-01-05', author: 'bob' })
  repo.run(['checkout', '-q', 'main'])
  const merge = repo.merge('feature', 'merge feature', { date: '2024-01-10' })
  const { history } = traceHistory({ root: repo.root, file: 'src/utils/math.js' })
  assert.equal(history.introduced.hash, merge)
  assert.equal(history.introducedFrom.hash, onBranch)
  assert.equal(history.introducedFrom.author, 'bob')
  // 不是合并提交时不加
  const plain = createRepo()
  t.after(() => plain.cleanup())
  plain.write('src/a.js', '')
  plain.commit('add')
  assert.equal(traceHistory({ root: plain.root, file: 'src/a.js' }).history.introducedFrom, undefined)
})

test('buildTimeline：目标改名后旧路径上又新建了同名文件，引用那个新文件的不算', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/old/Form.vue', '<template><i /></template>\n')
  repo.write('src/old/index.vue', "<script>\nimport F from './Form.vue'\n</script>\n")
  repo.commit('init', { date: '2024-01-01' })
  repo.run(['mv', 'src/old', 'src/new'])
  repo.commit('move dir', { date: '2024-02-01' })
  repo.write('src/new/index.vue', '<script>\nexport default {}\n</script>\n')
  const lost = repo.commit('new drops Form', { date: '2024-03-01' })
  // 旧路径上又建了一个同名文件，有人引用它
  repo.write('src/old/Form.vue', '<template><b /></template>\n')
  repo.write('src/old/index.vue', "<script>\nimport F from './Form.vue'\n</script>\n")
  repo.commit('recreate old', { date: '2024-04-01' })
  const timeline = buildTimeline(repo.root, 'old/Form', { exclude: ['src/new/Form.vue', 'src/old/Form.vue'], extensions: ['.vue'] })
  assert.equal(findLostRef(timeline).hash, lost)
})

test('refsAt / buildTimeline：文件名带空格的也认（import 里的路径照常解析）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/ setting.js', '')
  repo.write('src/a.js', "import s from './utils/ setting.js'\n")
  repo.commit('init')
  assert.deepEqual([...refsAt(repo.root, 'HEAD', 'utils/ setting', new Set(['src/utils/ setting.js']), ['.js'])], ['src/a.js'])
})
