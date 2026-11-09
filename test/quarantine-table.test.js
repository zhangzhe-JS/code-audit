import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderQuarantineTable } from '../src/report/quarantine-table.js'
import { resolveConfig } from '../src/core/config.js'

const commit = (hash, date, author, subject) => ({ hash: hash.padEnd(40, '0'), date, author, subject })
const c1 = commit('11111111', '2022-04-14', 'alice', '新增计算工具')
const c2 = commit('22222222', '2026-08-05', 'bob', '移除旧页面')

/**
 * 按 Markdown 表格的切分规则数一行里的列分隔符：
 * 反斜杠和它后面的一个字符算一组（转义），剩下的 | 才是分隔符
 */
function countDelimiters(row) {
  let n = 0
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\') { i++; continue }
    if (row[i] === '|') n++
  }
  return n
}

function item(target, overrides = {}) {
  return {
    id: `file:${target}`,
    kind: 'file',
    target,
    status: 'dead',
    evidence: [{ rule: 'no-import', detail: '无引用' }],
    refs: [],
    history: { introduced: c1, lostRef: null, timeline: [], paths: [target] },
    verify: null,
    ...overrides
  }
}

// 已移动、有失去引用、有备注
const moved = item('src/legacy/math.js', {
  history: {
    introduced: c1,
    lostRef: c2,
    timeline: [
      { commit: c1, change: 'add', from: 'src/views/Home.vue' },
      { commit: c2, change: 'remove', from: 'src/views/Home.vue' }
    ],
    paths: ['src/legacy/math.js', 'src/utils/math.js']
  },
  notes: ['依赖已移除，恢复会导致构建失败']
})

// 没移动、从未被引用
const never = item('src/utils/unused.js')

test('完整的清单表格', () => {
  assert.equal(renderQuarantineTable([moved, never]), [
    '| 文件 | 原路径 | 状态 | 引入 | 失去引用 | 备注 |',
    '| --- | --- | --- | --- | --- | --- |',
    '| src/legacy/math.js | src/utils/math.js | dead（无引用） | 2022-04-14 11111111 alice | 2026-08-05 22222222 bob「移除旧页面」 | 依赖已移除，恢复会导致构建失败 |',
    '| src/utils/unused.js | — | dead（无引用） | 2022-04-14 11111111 alice | 从未被引用 | — |'
  ].join('\n'))
})

test('仍被引用、没有 history 的情况如实显示，不猜', () => {
  const still = item('src/a.js', {
    history: { introduced: c1, lostRef: null, timeline: [{ commit: c1, change: 'add', from: 'src/b.js' }] }
  })
  const noHistory = item('src/c.js', { history: null })
  const rows = renderQuarantineTable([still, noHistory]).split('\n')
  assert.match(rows[2], /\| 仍被引用 \|/)
  assert.match(rows[3], /\| 未查询 \| 未查询 \|/)
})

test('导出和接口：文件列显示 路径#名字、方法 路径', () => {
  const exp = item('src/a.js', { id: 'export:src/a.js#toBlob', kind: 'export', name: 'toBlob' })
  const api = item('GET /api/user', { id: 'api:GET /api/user', kind: 'api', history: null })
  const rows = renderQuarantineTable([exp, api]).split('\n')
  assert.match(rows[2], /^\| src\/a\.js#toBlob \|/)
  assert.match(rows[3], /^\| GET \/api\/user \|/)
})

test('多条备注用分号连接', () => {
  const t = renderQuarantineTable([item('src/a.js', { notes: ['第一条', '第二条'] })])
  assert.match(t, /\| 第一条；第二条 \|$/)
})

test('提交说明、备注里的 | 和换行会被转义，表格列数不变', () => {
  const bad = commit('33333333', '2024-01-01', 'carol', 'fix: a | b')
  const t = renderQuarantineTable([item('src/a.js', {
    history: { introduced: c1, lostRef: bad, timeline: [{ commit: c1, change: 'add', from: 'x.js' }, { commit: bad, change: 'remove', from: 'x.js' }] },
    notes: ['x | y\n第二行']
  })])
  const row = t.split('\n')[2]
  assert.equal(countDelimiters(row), 7) // 6 列有 7 个分隔符
  assert.match(row, /fix: a \\\| b/)
  assert.match(row, /x \\\| y 第二行/)
})

test('没有排查对象时只输出表头', () => {
  assert.equal(renderQuarantineTable([]).split('\n').length, 2)
})

test('显示哪些列、列的顺序来自配置', () => {
  const config = resolveConfig({ tableColumns: ['status', 'target'] })
  assert.equal(renderQuarantineTable([never], { config }), [
    '| 状态 | 文件 |',
    '| --- | --- |',
    '| dead（无引用） | src/utils/unused.js |'
  ].join('\n'))
})

test('列标题、状态文案、提交号长度来自配置', () => {
  const config = resolveConfig({
    tableColumns: ['target', 'status', 'introduced'],
    columnTitles: { target: 'File', status: 'Status' },
    statusLabels: { dead: 'unused' },
    shortHashLength: 7
  })
  const t = renderQuarantineTable([never], { config })
  assert.match(t, /^\| File \| Status \| 引入 \|/) // 没覆盖的标题保留默认
  assert.match(t, /\| dead（unused） \| 2022-04-14 1111111 alice \|$/)
})

test('原文里已经有 \\| 或反斜杠时，表格列数也不变', () => {
  const t = renderQuarantineTable([item('src/a.js', { notes: ['原文有 \\| 转义', 'Windows 路径 C:\\dir\\', '结尾是反斜杠\\'] })])
  const row = t.split('\n')[2]
  assert.equal(countDelimiters(row), 7)
})

test('表格里的提交说明按 tableSubjectMaxLength 截断；null 不截断', () => {
  const lost = { hash: 'd'.repeat(40), date: '2024-03-01', author: 'bob', subject: "Merge branch 'feature/very-long-name' into 'dev' (http://git.example.com/group/project/merge_requests/1234)" }
  const it = {
    id: 'file:src/a.js',
    kind: 'file',
    target: 'src/a.js',
    status: 'dead',
    evidence: [{ rule: 'no-ref', detail: 'x' }],
    refs: [],
    history: { introduced: lost, lostRef: lost, timeline: [] },
    verify: null
  }
  const short = renderQuarantineTable([it], { config: resolveConfig({ tableColumns: ['target', 'lostRef'] }) })
  const subject = short.match(/「(.*)」/)[1]
  assert.equal(subject.length, 40)
  assert.ok(subject.startsWith("Merge branch 'feature/") && subject.endsWith('…'))
  const full = renderQuarantineTable([it], { config: resolveConfig({ tableColumns: ['target', 'lostRef'], tableSubjectMaxLength: null }) })
  assert.match(full, /merge_requests\/1234\)」/)
  assert.throws(() => resolveConfig({ tableSubjectMaxLength: 2 }), /tableSubjectMaxLength 必须是不小于 4 的整数/)
})
