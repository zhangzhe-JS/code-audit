import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findImportRefs } from '../src/collect/path-refs.js'

const find = (files, targets, aliases = { '@': 'src' }) =>
  Object.fromEntries(
    [...findImportRefs({ files: Object.entries(files).map(([path, content]) => ({ path, content })), targets, aliases })].map(([k, v]) => [
      k,
      v.map((r) => `${r.from}:${r.line}`)
    ])
  )

test('findImportRefs：import、export from、import()、require，相对路径和别名', () => {
  const code = [
    "import a from './a.js'",
    "import '@/b'",
    "export { c } from './c/index.js'",
    "const d = () => import('./d')",
    "const e = require('../src/e.js')",
    "import { f } from './f/'"
  ].join('\n')
  assert.deepEqual(find({ 'src/main.js': code }, ['src/a.js', 'src/b.vue', 'src/c/index.js', 'src/d.js', 'src/e.js', 'src/f/index.js']), {
    'src/a.js': ['src/main.js:1'],
    'src/b.vue': ['src/main.js:2'],
    'src/c/index.js': ['src/main.js:3'],
    'src/d.js': ['src/main.js:4'],
    'src/e.js': ['src/main.js:5'],
    'src/f/index.js': ['src/main.js:6']
  })
})

test('findImportRefs：注释里的、不是 import 的字符串、自己引用自己，都不算', () => {
  const code = ["// import a from './a.js'", "const p = './a.js'", "import self from './main.js'"].join('\n')
  assert.deepEqual(find({ 'src/main.js': code }, ['src/a.js', 'src/main.js']), {})
})

test('findImportRefs：.vue 只看 <script>', () => {
  const vue = ['<template>', "  <p>import x from './a.js'</p>", '</template>', '<script>', "import B from './b.js'", '</script>'].join('\n')
  assert.deepEqual(find({ 'src/App.vue': vue }, ['src/a.js', 'src/b.js']), { 'src/b.js': ['src/App.vue:5'] })
})
