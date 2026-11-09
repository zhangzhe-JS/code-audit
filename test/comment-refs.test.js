import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findCommentRefs, htmlComments } from '../src/collect/comment-refs.js'
import { resolveSpec } from '../src/collect/path-refs.js'

const find = (files, targets, aliases = { '@': 'src' }) =>
  Object.fromEntries(findCommentRefs({ files: Object.entries(files).map(([path, content]) => ({ path, content })), targets, aliases }))
const at = (r, t) => (r[t] ?? []).map((x) => `${x.from}:${x.line}`)

test('resolveSpec：相对、别名（取最长）、/ 开头、从仓库根目录写起', () => {
  const aliases = { '@': 'src', '@/c': 'src/components' }
  assert.equal(resolveSpec('./a.js', 'src/views/x.js', aliases), 'src/views/a.js')
  assert.equal(resolveSpec('../a', 'src/views/x.js', aliases), 'src/a')
  assert.equal(resolveSpec('@/utils/a.js', 'src/main.js', aliases), 'src/utils/a.js')
  assert.equal(resolveSpec('@/c/Btn.vue', 'src/main.js', aliases), 'src/components/Btn.vue')
  assert.equal(resolveSpec('/src/a.js?raw', 'index.html', aliases), 'src/a.js')
  assert.equal(resolveSpec('src/a/', 'vite.config.js', aliases), 'src/a')
})

test('resolveSpec：不像路径的返回 null（网址、跑出仓库、空的）；文字里带空格的当成句子', () => {
  for (const spec of ['https://x.com/a.js', '../../a.js', '', '.', '  ']) {
    assert.equal(resolveSpec(spec, 'src/x.js', {}), null, spec)
  }
  assert.equal(resolveSpec('a b', 'src/x.js', {}, { text: true }), null)
  // import 里的路径：文件名真有带空格的，照常解析
  assert.equal(resolveSpec('./ setting.js', 'src/utils/x.js', {}), 'src/utils/ setting.js')
  assert.equal(resolveSpec('@/utils/ setting', 'src/x.js', { '@': 'src' }), 'src/utils/ setting')
})

test('注释掉的 import：别名、相对路径、省略扩展名、index 目录写法，都算', () => {
  const r = find(
    {
      'src/main.js': [
        "import './used.js'",
        "// import { a } from '@/utils/a.js'",
        "/* import B from './views/B' */",
        "// const c = require('./legacy')"
      ].join('\n')
    },
    ['src/utils/a.js', 'src/views/B.vue', 'src/legacy/index.js', 'src/used.js']
  )
  assert.deepEqual(at(r, 'src/utils/a.js'), ['src/main.js:2'])
  assert.deepEqual(at(r, 'src/views/B.vue'), ['src/main.js:3'])
  assert.deepEqual(at(r, 'src/legacy/index.js'), ['src/main.js:4'])
  assert.equal(r['src/used.js'], undefined) // 没注释掉的引用不算
  assert.equal(r['src/utils/a.js'][0].text, "// import { a } from '@/utils/a.js'")
})

test('块注释跨行时，记引用所在的那一行', () => {
  const r = find({ 'src/main.js': "/*\n  旧代码：\n  import A from './a.js'\n*/" }, ['src/a.js'])
  assert.deepEqual(at(r, 'src/a.js'), ['src/main.js:3'])
})

test('.vue 只看 <script> 里的注释；模板里注释掉的组件标签不认', () => {
  const vue = [
    '<template>',
    '  <!-- <Old src="./Old.vue" /> -->',
    '</template>',
    '<script>',
    "// import Tip from '@/components/Tip/index.vue'",
    '</script>'
  ].join('\n')
  const r = find({ 'src/App.vue': vue }, ['src/components/Tip/index.vue', 'src/Old.vue'])
  assert.deepEqual(at(r, 'src/components/Tip/index.vue'), ['src/App.vue:5'])
  assert.equal(r['src/Old.vue'], undefined)
})

test('构建配置、html 里注释掉的路径都算；json 没有注释', () => {
  const r = find(
    {
      'vite.config.js': "export default {\n  // old: path.resolve(__dirname, 'src/old.js')\n}",
      'index.html': '<body>\n<!-- <script src="/src/old.js"></script> -->\n</body>',
      'a.json': '{ "x": "src/old.js" }'
    },
    ['src/old.js']
  )
  assert.deepEqual(at(r, 'src/old.js'), ['index.html:2', 'vite.config.js:2'])
})

test('注释里不带引号的文字、名字相近的文件不算', () => {
  const r = find({ 'src/main.js': "// 旧的 src/a.js 已不用\n// import x from './a.config.js'\n// import y from './ab'" }, ['src/a.js'])
  assert.deepEqual(r, {})
})

test('htmlComments：跨行注释记开始的行号', () => {
  assert.deepEqual(htmlComments('a\n<!-- x\ny -->\n<!--z-->'), [
    { line: 2, text: ' x\ny ' },
    { line: 4, text: 'z' }
  ])
})
