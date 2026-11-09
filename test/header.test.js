import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderHeader } from '../src/report/header.js'
import { resolveConfig } from '../src/core/config.js'

const commit = (hash, date, author, subject) => ({ hash: hash.padEnd(40, '0'), date, author, subject })
const c1 = commit('11111111', '2022-04-14', 'alice', '新增计算工具')
const c2 = commit('22222222', '2023-02-10', 'bob', '排行榜使用计算工具')
const c3 = commit('33333333', '2026-08-05', 'carol', '移除旧页面')

/** 一个典型的隔离文件：引入 → 两处引用 → 都被去掉 → 已移到 src/legacy/ */
function item(overrides = {}) {
  return {
    id: 'file:src/legacy/math.js',
    kind: 'file',
    target: 'src/legacy/math.js', // 当前路径（移动后），和原路径不同
    status: 'dead',
    evidence: [{ rule: 'no-import', detail: '无引用' }],
    refs: [],
    history: {
      introduced: c1,
      lostRef: c3,
      timeline: [
        { commit: c1, change: 'add', from: 'src/views/Home.vue' },
        { commit: c2, change: 'add', from: 'src/views/Rank.vue' },
        { commit: c3, change: 'remove', from: 'src/views/Home.vue' },
        { commit: c3, change: 'remove', from: 'src/views/Rank.vue' }
      ],
      paths: ['src/legacy/math.js', 'src/utils/math.js']
    },
    verify: null,
    ...overrides
  }
}

test('完整的头注释', () => {
  const header = renderHeader(item({ notes: ['依赖的计算库已移除，恢复引用会导致构建失败'] }), {
    movedAt: '2026-11-05',
    branch: 'dev'
  })
  assert.equal(header, [
    '/**',
    ' * [code-audit] 文件排查记录',
    ' * 状态：dead（无引用）',
    ' * 原路径：src/utils/math.js',
    ' * 移入：2026-11-05（分支 dev）',
    ' * 引入：2022-04-14 11111111 alice「新增计算工具」',
    ' * 引用历史：',
    ' *   - 2022-04-14 11111111 alice：新增引用 src/views/Home.vue',
    ' *   - 2023-02-10 22222222 bob：新增引用 src/views/Rank.vue',
    ' *   - 2026-08-05 33333333 carol：去掉引用 src/views/Home.vue、src/views/Rank.vue',
    ' *   - 失去引用：2026-08-05 33333333 carol「移除旧页面」',
    ' * ⚠️ 依赖的计算库已移除，恢复引用会导致构建失败',
    ' */'
  ].join('\n'))
})

test('生成的头注释放在代码前面，代码仍然合法', () => {
  const header = renderHeader(item())
  assert.doesNotThrow(() => new Function(`${header}\nconst x = 1`))
})

test('没传移入日期就不显示「移入」这一行', () => {
  assert.doesNotMatch(renderHeader(item()), /移入/)
})

test('原路径取 history.paths 的最后一个；没有 paths 时用 target', () => {
  const noPaths = item()
  delete noPaths.history.paths
  noPaths.target = 'src/a/b.js'
  assert.match(renderHeader(noPaths), /原路径：src\/a\/b\.js/)
})

test('从未被引用', () => {
  const header = renderHeader(item({ history: { introduced: c1, lostRef: null, timeline: [] } }))
  assert.match(header, / \* 引用历史：\n \*   - 从未被引用/)
})

test('仍被引用：时间线不为空，但没有失去引用', () => {
  const header = renderHeader(item({
    history: { introduced: c1, lostRef: null, timeline: [{ commit: c1, change: 'add', from: 'src/a.vue' }] }
  }))
  assert.match(header, /仍被引用/)
})

test('状态不是 dead 时如实显示，不替规则下结论', () => {
  assert.match(renderHeader(item({ status: 'unknown' })), /状态：unknown（无法判定，需人工确认）/)
})

test('一次提交涉及的文件太多时只列前几个', () => {
  const files = ['a', 'b', 'c', 'd', 'e'].map((n) => `src/${n}.vue`)
  const header = renderHeader(item({
    history: {
      introduced: c1,
      lostRef: c3,
      timeline: [
        ...files.map((from) => ({ commit: c1, change: 'add', from })),
        ...files.map((from) => ({ commit: c3, change: 'remove', from }))
      ]
    }
  }))
  assert.match(header, /去掉引用 src\/a\.vue、src\/b\.vue、src\/c\.vue 等 5 个文件/)
})

test('提交说明和备注里的 */ 会被转义，不会提前结束注释', () => {
  const bad = commit('44444444', '2024-01-01', 'dave', 'fix: 修复 /* xx */ 的解析')
  const header = renderHeader(item({
    notes: ['注意 */ 这里'],
    history: { introduced: bad, lostRef: null, timeline: [] }
  }))
  // 整段只有最后一个 */ 是真正的注释结尾
  assert.equal(header.match(/\*\//g).length, 1)
  assert.doesNotThrow(() => new Function(`${header}\nconst x = 1`))
})

test('备注里的换行换成空格，不会把注释拆乱', () => {
  const header = renderHeader(item({ notes: ['第一行\n第二行'] }))
  assert.match(header, / \* ⚠️ 第一行 第二行\n/)
})

test('标题、结尾提示、提交号长度来自配置', () => {
  const config = resolveConfig({
    headerTitle: '@deprecated 待删除',
    headerFooter: ['恢复前请联系维护者', '隔离清单：legacy/README.md'],
    shortHashLength: 7
  })
  const header = renderHeader(item(), { config })
  assert.match(header, /^\/\*\*\n \* @deprecated 待删除\n/)
  assert.match(header, / \* 恢复前请联系维护者\n \* 隔离清单：legacy\/README\.md\n \*\/$/)
  assert.match(header, /2022-04-14 1111111 alice/)
  assert.doesNotMatch(header, /业务代码禁止/)
})

test('结尾提示可以配置成空数组', () => {
  const header = renderHeader(item(), { config: resolveConfig({ headerFooter: [] }) })
  assert.match(header, /失去引用.*\n \*\/$/)
})

test('没有 history 时报错，提示先运行 history', () => {
  assert.throws(() => renderHeader(item({ history: null })), /请先运行 history/)
})
// ---------- 按文件类型选择注释格式 ----------

test('默认文案只陈述事实，不包含流程要求', () => {
  const header = renderHeader(item())
  assert.match(header, /^\/\*\*\n \* \[code-audit\] 文件排查记录\n/)
  assert.doesNotMatch(header, /隔离|观察期|禁止|恢复/)
})

test('不能写注释的文件类型直接报错，不生成会破坏文件的内容', () => {
  for (const target of ['src/data.json', 'public/index.html', 'src/Makefile']) {
    assert.throws(() => renderHeader(item({ target, history: { ...item().history, paths: [target] } })), /不支持为 .* 文件生成头注释/)
  }
})

test('.vue 文件用 HTML 注释', () => {
  const target = 'src/legacy/Old.vue'
  const header = renderHeader(item({ target, history: { ...item().history, paths: [target, 'src/views/Old.vue'] } }))
  assert.match(header, /^<!--\n  \[code-audit\] 文件排查记录\n  状态：dead（无引用）\n  原路径：src\/views\/Old\.vue\n/)
  assert.match(header, /\n-->$/)
})

test('HTML 注释里的 --> 会被转义，不会提前结束注释', () => {
  const target = 'src/legacy/Old.vue'
  const header = renderHeader(item({ target, notes: ['a --> b'], history: { ...item().history, paths: [target] } }))
  assert.equal(header.match(/-->/g).length, 1) // 只有最后的结尾
  assert.match(header, /a -- > b/)
})

test('注释格式可以按扩展名配置：补充新类型，或关闭某种类型', () => {
  const astro = 'src/pages/old.astro'
  const config = resolveConfig({ headerStyles: { '.astro': 'html', '.js': null } })
  assert.match(renderHeader(item({ target: astro, history: { ...item().history, paths: [astro] } }), { config }), /^<!--/)
  assert.throws(() => renderHeader(item(), { config }), /不支持为 \.js 文件生成头注释/)
})

test('状态文案来自配置，状态 ID 不变', () => {
  const config = resolveConfig({ statusLabels: { dead: 'unused' } })
  assert.match(renderHeader(item(), { config }), /状态：dead（unused）/)
})

test('引用方改名显示为一条「引用方改名 旧 → 新」', () => {
  const c = { hash: 'a'.repeat(40), date: '2024-02-01', author: 'bob', subject: 'rename' }
  const header = renderHeader(item({ history: { introduced: c, lostRef: null, timeline: [{ commit: c, change: 'add', from: 'src/Old.vue' }, { commit: c, change: 'rename', from: 'src/New.vue', previous: 'src/Old.vue' }] } }))
  assert.match(header, /引用方改名 src\/Old\.vue → src\/New\.vue/)
})

test('引入是合并提交时，头注释里写上分支上新增的提交', () => {
  const merge = { hash: 'b'.repeat(40), date: '2024-01-10', author: 'carol', subject: 'merge feature' }
  const branch = { hash: 'c'.repeat(40), date: '2024-01-05', author: 'bob', subject: 'add math' }
  const header = renderHeader(item({ history: { introduced: merge, introducedFrom: branch, lostRef: null, timeline: [] } }))
  assert.match(header, /引入：2024-01-10 bbbbbbbb carol「merge feature」\n \*   分支上新增：2024-01-05 cccccccc bob「add math」/)
})
