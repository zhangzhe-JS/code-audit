import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { renderReport } from '../src/report/markdown.js'
import { resolveConfig } from '../src/core/config.js'

// 完整样例：internal、dormant、dead 各一项，dead 那项有历史、验证和备注
const full = () => JSON.parse(readFileSync(new URL('./samples/full.json', import.meta.url), 'utf8'))
const HASH = 'a'.repeat(40)
const commit = (date = '2024-01-01', subject = 's') => ({ hash: HASH, date, author: 'alice', subject })

/** 一份只有一项的最小报告，方便改坏某个字段 */
function one(itemOverrides = {}) {
  const r = full()
  r.items = [{ ...r.items[2], ...itemOverrides }] // 用 dead 那项做底
  return r
}

/** 取出某个二级标题下的内容 */
function section(md, title) {
  const start = md.indexOf(`## ${title}`)
  const next = md.indexOf('\n## ', start + 1)
  return md.slice(start, next === -1 ? undefined : next)
}

test('报告按 概况 → 状态汇总 → 清单 → 详情 的顺序，以换行结尾', () => {
  const md = renderReport(full())
  assert.match(md, /^# 排查报告：demo\n/)
  const order = ['## 状态汇总', '## 清单', '## 详情'].map((t) => md.indexOf(t))
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])))
  assert.ok(md.endsWith('\n'))
})

test('概况：分析提交按配置的长度截短，列出入口', () => {
  const md = renderReport(full())
  assert.match(md, /- 分析提交：`11111111`\n/)
  assert.match(md, /- 入口：`src\/main\.js`\n/)
})

test('状态汇总：按状态优先级排列，只列出现过的状态，最后是合计', () => {
  const summary = section(renderReport(full()), '状态汇总')
  assert.deepEqual(summary.trim().split('\n').slice(4), [
    '| dormant（注释停用） | 1 |',
    '| internal（只在本文件内部使用） | 1 |',
    '| dead（无引用） | 1 |',
    '| 合计 | 3 |'
  ])
})

test('清单部分就是隔离清单表格', () => {
  assert.match(section(renderReport(full()), '清单'), /\| 文件 \| 原路径 \| 状态 \|/)
})

test('详情：证据、引用、历史、验证、备注都列出', () => {
  const md = renderReport(full())
  assert.match(md, /### `file:src\/utils\/check\.js`\n\n- 状态：dormant（注释停用）\n- 证据：\n  - \[commented-import\] main\.js 里的 import 被注释\n- 引用：\n  - `src\/main\.js:12`（comment）\n- 历史：未查询\n- 验证：未验证/)
  assert.match(md, /  - 2025-06-01 33333333 bob：去掉引用 `src\/views\/Old\.vue`\n  - 失去引用：2025-06-01 33333333 bob「chore: 移除旧页面」/)
  assert.match(md, /- 验证：删除后与基线一致（提交 `11111111`）\n  - 构建：通过，新增警告 0 条\n  - 测试：新增失败 0 个/)
  assert.match(md, /- ⚠️ 依赖的计算库已从 package\.json 移除/)
})

test('详情：证据带标签时显示标签', () => {
  const md = renderReport(one({ evidence: [{ rule: 'side-effect-import', detail: '只为副作用引入', tag: 'side-effect' }] }))
  assert.match(md, /  - \[side-effect-import\] 只为副作用引入（标签：side-effect）/)
})

test('详情：文件移动过时显示原路径', () => {
  const r = one()
  r.items[0].history.paths = ['src/utils/math.js', 'src/old/math.js']
  assert.match(renderReport(r), /  - 原路径：`src\/old\/math\.js`/)
})

test('详情：从未被引用、仍被引用如实显示', () => {
  assert.match(renderReport(one({ history: { introduced: commit(), lostRef: null, timeline: [] } })), /  - 从未被引用/)
  const still = one({ history: { introduced: commit(), lostRef: null, timeline: [{ commit: commit(), change: 'add', from: 'src/a.vue' }] } })
  assert.match(renderReport(still), /  - 仍被引用/)
})

test('详情：验证不一致时列出新增的警告和失败的测试', () => {
  const md = renderReport(one({
    verify: { rev: HASH, build: { ok: false, newWarnings: ['"x" is not exported'] }, test: { newFailures: ['a.test.js > 计算'] }, passed: false }
  }))
  assert.match(md, /- 验证：删除后与基线不一致（提交 `aaaaaaaa`）\n  - 构建：失败，新增警告 1 条\n    - "x" is not exported\n  - 测试：新增失败 1 个\n    - a\.test\.js > 计算/)
})

test('内容里的换行换成空格、路径里的反引号不会打断行内代码', () => {
  const md = renderReport(one({
    evidence: [{ rule: 'r', detail: '第一行\n第二行' }],
    notes: ['备注\n换行'],
    refs: [{ from: 'src/we`ird.js', line: 1, via: 'static' }]
  }))
  assert.match(md, /  - \[r\] 第一行 第二行\n/)
  assert.match(md, /- ⚠️ 备注 换行/)
  assert.match(md, /  - `` src\/we`ird\.js:1 ``（static）/)
})

test('没有排查对象时：合计 0，详情写「无」', () => {
  const r = full()
  r.items = []
  const md = renderReport(r)
  assert.match(md, /\| 合计 \| 0 \|/)
  assert.match(md, /## 详情\n\n无\n$/)
})

test('输入不符合格式时报错，并列出具体错误，不生成半成品', () => {
  const r = full()
  r.items[0].status = 'unused'
  delete r.project.rev
  assert.throws(() => renderReport(r), (e) => /无法生成报告/.test(e.message) && /status 不合法/.test(e.message) && /project\.rev/.test(e.message))
})

test('状态文案、表格的列、提交号长度来自配置', () => {
  const config = resolveConfig({ statusLabels: { dead: 'unused' }, tableColumns: ['target', 'status'], shortHashLength: 7 })
  const md = renderReport(full(), { config })
  assert.match(section(md, '状态汇总'), /\| dead（unused） \| 1 \|/)
  assert.match(section(md, '清单'), /\| 文件 \| 状态 \|\n/)
  assert.match(md, /- 分析提交：`1111111`\n/)
  assert.match(md, /- 状态：dead（unused）/)
})
