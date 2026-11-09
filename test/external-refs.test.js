import { test } from 'node:test'
import assert from 'node:assert/strict'
import { externalFiles, findExternalRefs } from '../src/collect/external-refs.js'

const find = (files, targets) => Object.fromEntries(findExternalRefs({ files: Object.entries(files).map(([path, content]) => ({ path, content })), targets }))
const lines = (r, t) => (r[t] ?? []).map((x) => `${x.from}:${x.line}`)

test('externalFiles：knip 分析的源码之外的文本文件；测试文件、锁文件不搜', () => {
  const all = [
    'vite.config.js', 'index.html', 'scripts/gen.js', 'package.json', 'pnpm-lock.yaml', 'sub/package-lock.json',
    'src/main.js', 'src/App.vue', 'src/menu.json', 'src/tpl.html', 'src/a.ts', 'tests/a.test.js'
  ]
  const r = externalFiles({ all, sourceRoots: ['src'], extensions: ['.js', '.vue'], exclude: new Set(['tests/a.test.js']) })
  assert.deepEqual(r, ['vite.config.js', 'index.html', 'scripts/gen.js', 'package.json', 'src/menu.json', 'src/tpl.html', 'src/a.ts'])
})

test('带不带扩展名、前面有 ./ / ../ 都算；记下行号和那一行', () => {
  const r = find(
    {
      'vite.config.js': "const a = 1\nalias: { x: path.resolve(__dirname, 'src/shims/stub.js') }\n",
      'index.html': '<script type="module" src="/src/shims/stub"></script>',
      'scripts/gen.js': "import m from '../src/shims/stub.js'"
    },
    ['src/shims/stub.js']
  )
  assert.deepEqual(lines(r, 'src/shims/stub.js'), ['index.html:1', 'scripts/gen.js:1', 'vite.config.js:2'])
  assert.equal(r['src/shims/stub.js'][2].text, "alias: { x: path.resolve(__dirname, 'src/shims/stub.js') }")
})

test('边界：不匹配名字更长的文件、多一段扩展名、下一级路径、别的扩展名', () => {
  const r = find(
    { 'a.js': "['src/ab.js', 'xsrc/a.js', 'src/a.config.js', 'src/a/b.js', 'src/a.ts', 'my-src/a.js', '@src/a']" },
    ['src/a.js']
  )
  assert.deepEqual(r, {})
})

test('index 文件也认目录写法（带不带结尾的 /）', () => {
  const r = find({ 'pages.json': '{ "a": "src/legacy", "b": "src/legacy/", "c": "src/legacy/other.js" }' }, ['src/legacy/index.js'])
  assert.equal(r['src/legacy/index.js'].length, 1) // 同一行只记一次
  assert.deepEqual(find({ 'p.json': '"src/legacy/other.js"' }, ['src/legacy/index.js']), {})
})

test('JS 类文件里注释掉的不算；html、json 原样搜', () => {
  const r = find(
    {
      'vite.config.js': "// path.resolve(__dirname, 'src/old.js')\n/* 'src/old.js' */\n",
      'index.html': '<!-- <script src="/src/old.js"></script> -->'
    },
    ['src/old.js']
  )
  assert.deepEqual(lines(r, 'src/old.js'), ['index.html:1'])
})

test('同一个文件里多处、多个候选', () => {
  const r = find({ 'c.js': "'src/a.js'\n'src/b.js'\n'src/a'\n" }, ['src/a.js', 'src/b.js', 'src/c.js'])
  assert.deepEqual(lines(r, 'src/a.js'), ['c.js:1', 'c.js:3'])
  assert.deepEqual(lines(r, 'src/b.js'), ['c.js:2'])
  assert.equal(r['src/c.js'], undefined)
})

test('路径里的特殊字符按原样匹配；那一行过长时截断', () => {
  const r = find({ 'a.json': `"src/a+b (1).js" ${'x'.repeat(100)}` }, ['src/a+b (1).js'])
  assert.equal(r['src/a+b (1).js'][0].text.length, 80)
})
