import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, pickStatus } from '../src/core/schema.js'
import { readFileSync } from 'node:fs'

const HASH = 'a'.repeat(40)
const commit = (date = '2024-01-01') => ({ hash: HASH, date, author: 'alice', subject: 'x' })

// 一份正确的数据；每个测试拿一份新的，改坏一处
function sample() {
    return {
        version: 1,
        generatedAt: '2026-11-05T08:00:00.000Z',
        tool: { name: 'code-audit', version: '1.0.0' },
        project: { name: 'demo', root: '/tmp/demo', rev: HASH, entries: ['src/main.js'] },
        items: [
            {
                id: 'file:src/a.js',
                kind: 'file',
                target: 'src/a.js',
                status: 'dead',
                evidence: [{ rule: 'no-import', detail: '无引用' }],
                refs: [],
                history: null,
                verify: null
            }
        ]
    }
}

// ---------- validate ----------

test('正确的数据没有错误', () => {
    assert.deepEqual(validate(sample()), [])
})

test('没有证据的结论不通过', () => {
    const d = sample()
    d.items[0].evidence = []

    assert.match(validate(d).join(), /至少要有一条证据/)
})

test('不认识的状态不通过', () => {
    const d = sample()
    d.items[0].status = 'unused'
    assert.match(validate(d).join(), /status 不合法/)
})

test('不认识的标签不通过', () => {
    const d = sample()
    d.items[0].evidence[0].tag = 'xxx'
    assert.match(validate(d).join(), /tag 不合法/)
})

test('id 重复不通过', () => {
    const d = sample()
    d.items.push(structuredClone(d.items[0]))
    assert.match(validate(d).join(), /id 重复/)
})

test('version 不对不通过', () => {
    const d = sample()
    d.version = 2
    assert.match(validate(d).join(), /version/)
})

// ---------- pickStatus ----------

test('多种情况同时满足时，取更不敢删的那个', () => {
    assert.equal(pickStatus(['dead', 'pending']), 'pending')
    assert.equal(pickStatus(['dead', 'dormant', 'unknown']), 'unknown')
})

test('没有任何候选时返回 unknown', () => {
    assert.equal(pickStatus([]), 'unknown')
})


// ---------- 测试用例 ----------

const full = JSON.parse(
    readFileSync(new URL('./samples/full.json', import.meta.url), 'utf8')
)

test('完整样例符合格式', () => {
    assert.deepEqual(validate(full), [])
})

test('缺少 refs 不通过', () => {
    const d = sample()
    delete d.items[0].refs
    assert.match(validate(d).join(), /refs 必须是数组/)
})
// ---------- 非法输入只返回错误，不抛异常 ----------

test('evidence / refs 里有 null 时返回错误，不抛异常', () => {
  const d = sample()
  d.items[0].evidence = [null]
  d.items[0].refs = [null]
  const errors = validate(d)
  assert.match(errors.join(), /evidence\[0\] 必须是对象/)
  assert.match(errors.join(), /refs\[0\] 必须是对象/)
})

test('各种奇怪的输入都不抛异常', () => {
  for (const bad of [null, 1, 'x', [], { items: [1, null, 'x'] }, { items: [{ evidence: 'x', refs: 'x' }] }]) {
    assert.doesNotThrow(() => validate(bad))
  }
})

// ---------- 字段契约 ----------

test('缺少 id、evidence 缺 rule/detail 不通过', () => {
  const d = sample()
  delete d.items[0].id
  d.items[0].evidence = [{}]
  const msg = validate(d).join()
  assert.match(msg, /id 必须是非空字符串/)
  assert.match(msg, /rule 必须是非空字符串/)
  assert.match(msg, /detail 必须是非空字符串/)
})

test('refs 缺 from / line / via 不通过', () => {
  const d = sample()
  d.items[0].refs = [{}]
  const msg = validate(d).join()
  assert.match(msg, /from 必须是相对路径/)
  assert.match(msg, /line 必须是正整数/)
  assert.match(msg, /via 不合法/)
})

test('project 缺 name / rev、entries 不是数组不通过', () => {
  const d = sample()
  delete d.project.name
  d.project.rev = 'abc1234' // 短提交号不行
  d.project.entries = 'src/main.js'
  const msg = validate(d).join()
  assert.match(msg, /project.name/)
  assert.match(msg, /project.rev 必须是完整提交号/)
  assert.match(msg, /project.entries 必须是数组/)
})

test('路径必须是相对路径', () => {
  const d = sample()
  d.items[0].target = '/abs/src/a.js'
  d.items[0].id = 'file:/abs/src/a.js'
  assert.match(validate(d).join(), /target 必须是相对路径/)
})

test('kind 为 export 时必须有 name，且 id 要和 kind/target/name 一致', () => {
  const d = sample()
  d.items[0].kind = 'export'
  assert.match(validate(d).join(), /必须有导出名/)

  d.items[0].name = 'foo'
  assert.match(validate(d).join(), /应为 export:src\/a.js#foo/)

  d.items[0].id = 'export:src/a.js#foo'
  assert.deepEqual(validate(d), [])
})

test('api 的 target 必须是「方法 路径」', () => {
  const d = sample()
  d.items[0].kind = 'api'
  d.items[0].target = '/api/user'
  d.items[0].id = 'api:/api/user'
  assert.match(validate(d).join(), /方法 路径/)
})

test('items 没按 id 排序不通过', () => {
  const d = sample()
  const b = structuredClone(d.items[0])
  b.id = 'file:src/b.js'
  b.target = 'src/b.js'
  d.items.unshift(b) // b 排到 a 前面
  assert.match(validate(d).join(), /没有按 id 排序/)
})

test('history 内部结构不对不通过', () => {
  const d = sample()
  d.items[0].history = 123
  assert.match(validate(d).join(), /history 必须是对象或 null/)

  d.items[0].history = { introduced: { hash: 'short' }, lostRef: null, timeline: [{ change: 'x' }] }
  const msg = validate(d).join()
  assert.match(msg, /introduced.hash 必须是完整提交号/)
  assert.match(msg, /timeline\[0\].change 必须是 add 或 remove/)

  d.items[0].history = { introduced: commit(), lostRef: commit('2025-01-01'), timeline: [] }
  assert.deepEqual(validate(d), [])
})

test('verify 内部结构不对不通过', () => {
  const d = sample()
  d.items[0].verify = { rev: HASH, build: { ok: 'yes' }, test: {}, passed: 1 }
  const msg = validate(d).join()
  assert.match(msg, /verify.build/)
  assert.match(msg, /verify.test/)
  assert.match(msg, /verify.passed/)
})
// ---------- notes ----------

test('notes 可以不写', () => {
  const d = sample()
  assert.equal('notes' in d.items[0], false)
  assert.deepEqual(validate(d), [])
})

test('notes 写了就必须是非空字符串数组', () => {
  const d = sample()
  d.items[0].notes = ['恢复引用会导致构建失败']
  assert.deepEqual(validate(d), [])

  d.items[0].notes = '不是数组'
  assert.match(validate(d).join(), /notes 必须是数组/)

  d.items[0].notes = ['正常', '', 123]
  const msg = validate(d).join()
  assert.match(msg, /notes\[1\] 必须是非空字符串/)
  assert.match(msg, /notes\[2\] 必须是非空字符串/)
})

test('notes 为 null 也不通过（null 不等于没写）', () => {
  const d = sample()
  d.items[0].notes = null
  assert.match(validate(d).join(), /notes 必须是数组/)
})
// ---------- 状态说明、history.paths ----------

test('每种状态都有中文说明', async () => {
  const { STATUSES, STATUS_LABELS } = await import('../src/core/schema.js')
  for (const s of STATUSES) assert.ok(STATUS_LABELS[s], `${s} 缺少说明`)
  assert.equal(Object.keys(STATUS_LABELS).length, STATUSES.length)
})

test('history.paths 可以不写；写了必须是非空的相对路径数组', () => {
  const d = sample()
  d.items[0].history = { introduced: commit(), lostRef: null, timeline: [] }
  assert.deepEqual(validate(d), [])

  d.items[0].history.paths = ['src/a.js', 'src/legacy/a.js'] // 从当前到最初
  assert.deepEqual(validate(d), [])

  d.items[0].history.paths = []
  assert.match(validate(d).join(), /paths 必须是非空的相对路径数组/)

  d.items[0].history.paths = ['/abs/a.js']
  assert.match(validate(d).join(), /paths 必须是非空的相对路径数组/)
})
test('history.paths 的第一项必须是当前路径，不能有重复', () => {
  const d = sample()
  d.items[0].history = { introduced: commit(), lostRef: null, timeline: [] }

  d.items[0].history.paths = ['src/legacy/a.js', 'src/a.js'] // 顺序反了
  assert.match(validate(d).join(), /paths 的第一项必须是当前路径 src\/a\.js/)

  d.items[0].history.paths = ['src/a.js', 'src/old/a.js', 'src/old/a.js']
  assert.match(validate(d).join(), /paths 里有重复的路径/)
})
