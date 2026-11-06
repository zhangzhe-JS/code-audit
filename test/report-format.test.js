import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  shortHash, formatCommit, escapeComment, escapeTableCell, groupTimeline
} from '../src/report/format.js'

const c1 = { hash: '44bd21eb'.padEnd(40, '0'), date: '2022-04-14', author: 'alice', subject: 'first commit' }
const c2 = { hash: '8adb63a8'.padEnd(40, '0'), date: '2026-08-05', author: 'bob', subject: '移除死代码' }

// ---------- 提交显示 ----------

test('shortHash 截成 8 位', () => {
  assert.equal(shortHash(c1.hash), '44bd21eb')
})

test('formatCommit 默认带提交说明', () => {
  assert.equal(formatCommit(c1), '2022-04-14 44bd21eb alice「first commit」')
})

test('formatCommit 可以不带提交说明', () => {
  assert.equal(formatCommit(c1, { subject: false }), '2022-04-14 44bd21eb alice')
})

test('提交号长度可以配置', () => {
  assert.equal(shortHash(c1.hash, 7), '44bd21e')
  assert.equal(formatCommit(c1, { subject: false, hashLength: 12 }), '2022-04-14 44bd21eb0000 alice')
})

// ---------- 转义 ----------

test('escapeComment：*/ 换成 *\\/，所有出现的地方都换', () => {
  assert.equal(escapeComment('a */ b */ c'), 'a *\\/ b *\\/ c')
  assert.equal(escapeComment('普通说明'), '普通说明')
})

test('escapeComment：转义后放进块注释，代码仍然合法', () => {
  const subject = 'fix: 修复 /* 注释 */ 解析'
  // 不转义：注释被提前结束，「解析」变成了代码，会报语法错误
  assert.throws(() => new Function(`/** ${subject} */`))
  // 转义后：整段仍是注释
  assert.doesNotThrow(() => new Function(`/** ${escapeComment(subject)} */`))
})

test('escapeTableCell：| 换成 \\|', () => {
  assert.equal(escapeTableCell('a | b'), 'a \\| b')
})

test('escapeTableCell：换行换成空格', () => {
  assert.equal(escapeTableCell('第一行\n第二行\r\n第三行'), '第一行 第二行 第三行')
})

// ---------- 时间线分组 ----------

test('groupTimeline：同一次提交的多条合成一组，保持时间顺序', () => {
  const timeline = [
    { commit: c1, change: 'add', from: 'src/a.vue' },
    { commit: c1, change: 'add', from: 'src/b.vue' },
    { commit: c2, change: 'remove', from: 'src/a.vue' },
    { commit: c2, change: 'remove', from: 'src/b.vue' }
  ]
  assert.deepEqual(groupTimeline(timeline), [
    { commit: c1, added: ['src/a.vue', 'src/b.vue'], removed: [] },
    { commit: c2, added: [], removed: ['src/a.vue', 'src/b.vue'] }
  ])
})

test('groupTimeline：同一次提交里既有增加也有去掉', () => {
  const timeline = [
    { commit: c1, change: 'add', from: 'src/new.vue' },
    { commit: c1, change: 'remove', from: 'src/old.vue' }
  ]
  assert.deepEqual(groupTimeline(timeline), [
    { commit: c1, added: ['src/new.vue'], removed: ['src/old.vue'] }
  ])
})

test('groupTimeline：空时间线返回空数组', () => {
  assert.deepEqual(groupTimeline([]), [])
})
// ---------- 输入边界 ----------

test('提交号长度不合法时报错，不返回看起来正常的错误结果', () => {
  for (const bad of [-1, 0, 3, 41, 1.5, '8']) {
    assert.throws(() => shortHash(c1.hash, bad), RangeError, `长度 ${bad} 应该报错`)
  }
})

test('groupTimeline：不认识的 change 报错，不悄悄当成去掉', () => {
  assert.throws(() => groupTimeline([{ commit: c1, change: 'oops', from: 'src/a.vue' }]), /change 不合法/)
})

test('escapeHtmlComment：--> 换成 -- >，所有出现的地方都换', async () => {
  const { escapeHtmlComment } = await import('../src/report/format.js')
  assert.equal(escapeHtmlComment('a --> b --> c'), 'a -- > b -- > c')
  assert.equal(escapeHtmlComment('普通说明'), '普通说明')
})

test('escapeTableCell：先转义反斜杠，再转义 |', () => {
  assert.equal(escapeTableCell('a \\| b'), 'a \\\\\\| b') // a \| b → a \\\| b
  assert.equal(escapeTableCell('C:\\dir'), 'C:\\\\dir')
})

test('oneLine：换行换成空格', async () => {
  const { oneLine } = await import('../src/report/format.js')
  assert.equal(oneLine('a\nb\r\nc'), 'a b c')
})

test('inlineCode：普通文字用一个反引号；文字里有反引号时用两个并加空格', async () => {
  const { inlineCode } = await import('../src/report/format.js')
  assert.equal(inlineCode('src/a.js'), '`src/a.js`')
  assert.equal(inlineCode('a`b'), '`` a`b ``')
  assert.equal(inlineCode('a\nb'), '`a b`')
})
