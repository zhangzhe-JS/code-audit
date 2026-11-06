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
