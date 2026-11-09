import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findDynamicLoads, inScope } from '../src/collect/dynamic-imports.js'

const find = (path, content, aliases = { '@': 'src' }) => findDynamicLoads({ files: [{ path, content }], aliases })
const scopeOf = (path, content, aliases) => {
  const loads = find(path, content, aliases)
  assert.equal(loads.length, 1, `应找到 1 处，实际 ${loads.length} 处`)
  return loads[0].scope
}

// ---------- 找出动态加载、算范围 ----------

test('模板字符串：取固定的开头和结尾，记下行号和写法', () => {
  const loads = find('src/router/index.js', "const a = 1\nconst load = (n) => import(`./views/${n}.vue`)\n")
  assert.deepEqual(loads, [
    {
      from: 'src/router/index.js',
      line: 2,
      kind: 'import',
      expr: 'import(`./views/${n}.vue`)',
      scope: { dir: 'src/router/views', wide: false, recursive: true, prefix: '', suffix: '.vue', regex: null }
    }
  ])
})

test('用 + 拼接、别名、文件名有固定开头', () => {
  assert.deepEqual(scopeOf('src/a.js', "import('@/views/page-' + name + '.vue')"), {
    dir: 'src/views',
    wide: false,
    recursive: true,
    prefix: 'page-',
    suffix: '.vue',
    regex: null
  })
})

test('require 拼接路径；结尾的查询参数去掉', () => {
  assert.deepEqual(scopeOf('src/i18n/index.js', 'const m = require(`../locale/${lang}.js?raw`)'), {
    dir: 'src/locale',
    wide: false,
    recursive: true,
    prefix: '',
    suffix: '.js',
    regex: null
  })
})

test('模板字符串里的表达式有嵌套的括号、字符串、模板', () => {
  const s = scopeOf('src/a.js', 'import(`./v/${fn(a, "x)", `y${b}`)}/index.vue`)')
  assert.deepEqual([s.dir, s.prefix, s.suffix], ['src/v', '', '/index.vue'])
})

test('路径固定的不算（knip 能处理）：字符串、没有变量的模板字符串、字符串相加', () => {
  const code = [
    "import('./a.js')",
    'import(`./b.js`)',
    "require('./c.js')",
    "import('./d/' + 'e.js')",
    "const x = () => import('@/views/login')"
  ].join('\n')
  assert.deepEqual(find('src/a.js', code), [])
})

test('确定不了目录时范围是整个仓库（wide），按固定的结尾缩小：变量、开头没有目录、包名、三元表达式', () => {
  const code = ['import(path)', "import('page-' + x + '.vue')", 'import(`lodash/${m}`)', "import(a ? './a.js' : './b.js')"].join('\n')
  const loads = find('src/a.js', code)
  assert.deepEqual(
    loads.map((l) => [l.line, l.scope.wide, l.scope.dir, l.scope.suffix]),
    [[1, true, '', ''], [2, true, '', '.vue'], [3, true, '', ''], [4, true, '', '']]
  )
})

test('require.context：默认含子目录、不限文件；false 不含子目录；正则里有括号', () => {
  const code = [
    "require.context('./modules')",
    "require.context('@/icons', false, /\\.svg$/)",
    "require.context('./m', true, /(a|b)\\.js$/i)"
  ].join('\n')
  const [a, b, c] = find('src/store/index.js', code).map((l) => l.scope)
  assert.deepEqual(a, { dir: 'src/store/modules', wide: false, recursive: true, prefix: '', suffix: '', regex: null })
  assert.deepEqual([b.dir, b.recursive, String(b.regex)], ['src/icons', false, '/\\.svg$/'])
  assert.deepEqual([c.dir, c.recursive, String(c.regex)], ['src/store/m', true, '/(a|b)\\.js$/i'])
})

test('require.context：目录不是字符串时范围是整个仓库，按正则缩小；正则写错时不限文件', () => {
  const [a, b, c] = find('src/a.js', "require.context(dir)\nrequire.context(dir, true, /\\.vue$/)\nrequire.context('./x', true, /(/)").map((l) => l.scope)
  assert.deepEqual([a.wide, a.dir, a.regex], [true, '', null])
  assert.deepEqual([b.wide, String(b.regex)], [true, '/\\.vue$/'])
  assert.equal(c.regex, null)
})

test('注释里的、.vue 模板里的不算；import.meta.glob、obj.import() 不算', () => {
  const js = ["// import(`./a/${x}`)", '/** @param {import(\'axios\').X} a */', 'import.meta.glob(`./x/*.js`)', 'loader.import(`./b/${y}`)'].join('\n')
  assert.deepEqual(find('src/a.js', js), [])
  const vue = ['<template>', '  <p>import(`./t/${x}`)</p>', '</template>', '<script>', 'export default { c: () => import(`./c/${n}.vue`) }', '</script>'].join('\n')
  const loads = find('src/App.vue', vue)
  assert.deepEqual(loads.map((l) => [l.line, l.scope.dir]), [[5, 'src/c']])
})

test('写法过长时截断，换行压成空格', () => {
  const long = `import(\n  \`./views/${'x'.repeat(100)}/\${n}.vue\`\n)`
  const [l] = find('src/a.js', long)
  assert.equal(l.expr.length, 80)
  assert.ok(l.expr.startsWith('import( `./views/'))
  assert.ok(l.expr.endsWith('…'))
})

test('没有配对的右括号时跳过，不报错', () => {
  assert.deepEqual(find('src/a.js', 'import(`./a/${x}`'), [])
})

// ---------- inScope ----------

test('inScope：含子目录、固定开头和结尾', () => {
  const s = { dir: 'src/views', recursive: true, prefix: 'page-', suffix: '.vue', regex: null }
  assert.equal(inScope('src/views/page-a.vue', s), true)
  assert.equal(inScope('src/views/page-a/b.vue', s), true)
  assert.equal(inScope('src/views/a.vue', s), false)
  assert.equal(inScope('src/views/page-a.js', s), false)
  assert.equal(inScope('src/viewsX/page-a.vue', s), false)
  assert.equal(inScope('src/other/page-a.vue', s), false)
})

test('inScope：路径省略扩展名时去掉扩展名再比较；结尾为空时不限', () => {
  const s = { dir: 'src/v', recursive: true, prefix: '', suffix: '/index', regex: null }
  assert.equal(inScope('src/v/a/index.vue', s), true)
  assert.equal(inScope('src/v/a/main.vue', s), false)
  assert.equal(inScope('src/v/a/b.js', { ...s, suffix: '' }), true)
})

test('inScope：整个仓库的范围按结尾、正则缩小', () => {
  const wide = { dir: '', wide: true, recursive: true, prefix: '', suffix: '', regex: null }
  assert.equal(inScope('src/a.js', wide), true)
  assert.equal(inScope('src/a.js', { ...wide, suffix: '.vue' }), false)
  assert.equal(inScope('src/views/a.vue', { ...wide, suffix: '.vue' }), true)
  assert.equal(inScope('src/views/a.vue', { ...wide, regex: /\.vue$/ }), true)
})

test('inScope：require.context 的正则和是否含子目录', () => {
  const s = { dir: 'src/m', recursive: false, prefix: '', suffix: '', regex: /\.js$/ }
  assert.equal(inScope('src/m/a.js', s), true)
  assert.equal(inScope('src/m/sub/a.js', s), false)
  assert.equal(inScope('src/m/a.vue', s), false)
  assert.equal(inScope('src/m/sub/a.js', { ...s, recursive: true }), true)
  // 正则对 ./相对路径 测试，和 webpack 一致
  assert.equal(inScope('src/m/a.js', { ...s, regex: /^\.\/a\.js$/ }), true)
})

test('写在字符串里的 import(、require(、import.meta.glob( 不算调用；模板字符串 ${} 里的照常算', async () => {
  const { findGlobImports } = await import('../src/collect/glob-imports.js')
  const code = [
    "const doc = 'use import(`./x/${n}`) to load'",
    'const tip = "require(name) is old"',
    'const t = `${import(`./pages/${p}`)}`',
    "const g = 'import.meta.glob(pattern)'"
  ].join('\n')
  const loads = find('src/a.js', code)
  assert.deepEqual(loads.map((l) => [l.line, l.scope.dir]), [[3, 'src/pages']])
  assert.deepEqual(findGlobImports({ files: [{ path: 'src/a.js', content: code }] }).unresolved, [])
})
