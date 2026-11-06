import { test } from 'node:test'
import assert from 'node:assert/strict'
import { stripComments } from '../src/collect/strip-comments.js'

const P = 'utils/x'
const hasRef = (code) => stripComments(code).includes(P)

test('行尾注释里提到的不算', () => {
  assert.equal(hasRef('foo() // 以前用 utils/x'), false)
})

test('代码后面跟着行尾注释，代码部分仍算', () => {
  assert.equal(hasRef("import x from '@/utils/x' // 工具"), true)
})

test('字符串里的 // 不是注释', () => {
  assert.equal(hasRef("const u = 'https://cdn.com/utils/x.js'"), true)
})

test('字符串里的 /* 不是注释（i18n glob 的坑）', () => {
  // pattern 要放在 /* 后面：误把 /* 当成注释开头时，后面的内容会被整段吃掉
  assert.equal(hasRef("import.meta.glob('/src/*/utils/x.json')"), true)
})

test('乘号开头的续行不是注释', () => {
  assert.equal(hasRef('  * utils/x.length'), true)
})

test('行首块注释后面的代码仍算', () => {
  assert.equal(hasRef("/* eslint-disable */ import x from '@/utils/x'"), true)
})

test('多行块注释中间的行不算', () => {
  assert.equal(hasRef("/*\nimport x from '@/utils/x'\n*/"), false)
})

test('字符串里的转义引号不会提前结束字符串', () => {
  // 实际字符串是 it\'s，没有处理转义的话，字符串会在 \' 处提前结束
  assert.equal(hasRef("const s = 'it\\'s // utils/x'"), true)
})

test('去掉注释后行号不变', () => {
  const code = 'a\n/*\nb\n*/\nc // d'
  assert.equal(stripComments(code).split('\n').length, code.split('\n').length)
})

// ---------- 正则字面量 ----------

test('正则里的 // 不是注释，后面的代码保留', () => {
  assert.equal(hasRef("const r = /\\/\\//g; import './utils/x.js'"), true)
})

test('正则里的引号不会被当成字符串开头', () => {
  // 没识别正则时，/'/ 里的 ' 会打乱后面字符串的配对，导致 'http://a' 里的 // 被当成注释，吃掉后面的 import
  assert.equal(hasRef("s.replace(/'/g, ''); const u = 'http://a'; import './utils/x.js'"), true)
})

test('正则的 [...] 里的 / 不结束正则', () => {
  assert.equal(hasRef("const r = /[/]+/; import './utils/x.js'"), true)
})

test('关键字后面的 / 是正则', () => {
  assert.equal(hasRef("function f() { return /'/.test(s) }\nimport './utils/x.js' // c"), true)
})

test('除号不会被当成正则', () => {
  // 如果把 a / b 误判成正则开头，正则会一直读到下一个 /，中间的 // 注释就去不掉了
  assert.equal(hasRef('const half = a / 2 // utils/x'), false)
  assert.equal(hasRef('const v = (a + b) / 2 // utils/x'), false)
})

test('误判成正则时，读到换行就退回，不影响下一行', () => {
  assert.equal(hasRef("x = a++ / 2\n// utils/x"), false)
})

// ---------- 模板字符串 ${} ----------

test('模板字符串 ${} 里的注释要去掉', () => {
  assert.equal(hasRef('const s = `${ a /* utils/x */ }`'), false)
})

test('模板字符串 ${} 里的代码保留', () => {
  assert.equal(hasRef("const m = `${ await import('./utils/x.js') }`"), true)
})

test('${} 里字符串中的反引号不会结束模板字符串', () => {
  assert.equal(hasRef("const a = `${ b ? '`' : c } // 不是注释 utils/x`"), true)
})

test('${} 里的对象字面量不会提前结束表达式', () => {
  assert.equal(hasRef('const s = `${ JSON.stringify({ a: 1 }) } utils/x`'), true)
})

test('嵌套的模板字符串', () => {
  assert.equal(hasRef('const s = `a ${ `b ${ c } // utils/x` } d`'), true)
  assert.equal(hasRef('const s = `a ${ `b ${ c }` } d` // utils/x'), false)
})
