import { test } from 'node:test'
import assert from 'node:assert/strict'
import { validate, pickStatus } from '../src/core/schema.js'
import { readFileSync } from 'node:fs'

// 一份正确的数据；每个测试拿一份新的，改坏一处
function sample() {
    return {
        version: 1,
        project: { name: 'demo', root: '/tmp/demo', rev: 'abc1234', entries: ['src/main.js'] },
        items: [
            {
                id: 'file:src/a.js',
                kind: 'file',
                target: 'src/a.js',
                status: 'dead',
                evidence: [{ rule: 'no-import', detail: '无引用' }],
                refs: [],
                history: null,
                verify: null,
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