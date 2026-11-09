import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findGlobImports, resolvePattern } from '../src/collect/glob-imports.js'
import { scriptOnly } from '../src/collect/source-text.js'

const find = (path, content, aliases) => findGlobImports({ files: [{ path, content }], aliases })

test('resolvePattern：相对路径按写 glob 的文件换算', () => {
  assert.equal(resolvePattern('./menu/*/zh.js', 'src/i18n/index.js'), 'src/i18n/menu/*/zh.js')
  assert.equal(resolvePattern('../views/**/*.vue', 'src/router/index.js'), 'src/views/**/*.vue')
})

test('resolvePattern：/ 开头相对项目根目录', () => {
  assert.equal(resolvePattern('/src/pages/*.vue', 'src/router/index.js'), 'src/pages/*.vue')
})

test('resolvePattern：别名按配置换算，取最长的匹配', () => {
  const aliases = { '@': 'src', '@/lib': 'packages/lib' }
  assert.equal(resolvePattern('@/views/*.vue', 'src/a.js', aliases), 'src/views/*.vue')
  assert.equal(resolvePattern('@/lib/*.js', 'src/a.js', aliases), 'packages/lib/*.js')
})

test('resolvePattern：别名必须整段匹配，@views 不算 @ 开头', () => {
  assert.equal(resolvePattern('@views/*.vue', 'src/a.js', { '@': 'src' }), null)
})

test('resolvePattern：排除写法保留 !', () => {
  assert.equal(resolvePattern('!./menu/_*.js', 'src/i18n/index.js'), '!src/i18n/menu/_*.js')
})

test('resolvePattern：跑到仓库外面、不认识的写法返回 null', () => {
  assert.equal(resolvePattern('../../x/*.js', 'src/a.js'), null)
  assert.equal(resolvePattern('menu/*.js', 'src/a.js'), null)
  assert.equal(resolvePattern('./', 'a.js'), null)
})

test('找到字符串参数的 import.meta.glob，记下行号', () => {
  const r = find('src/i18n/index.js', "import a from 'a'\nconst m = import.meta.glob('./menu/*.js', { eager: true })\n")
  assert.deepEqual(r.globs, [{ from: 'src/i18n/index.js', line: 2, pattern: './menu/*.js', resolved: 'src/i18n/menu/*.js' }])
  assert.deepEqual(r.warnings, [])
})

test('数组参数：每一项都换算', () => {
  const r = find('src/a.js', 'import.meta.glob([\n  "./x/*.js",\n  `./y/*.js`,\n  "!./x/skip.js"\n])')
  assert.deepEqual(r.globs.map((g) => g.resolved), ['src/x/*.js', 'src/y/*.js', '!src/x/skip.js'])
})

test('import.meta.globEager（旧写法）也认', () => {
  const r = find('src/a.js', "import.meta.globEager('./x/*.js')")
  assert.deepEqual(r.globs.map((g) => g.resolved), ['src/x/*.js'])
})

test('参数是变量或带 ${} 的模板字符串：记警告，不猜', () => {
  const r = find('src/a.js', 'import.meta.glob(dir)\nimport.meta.glob(`./${lang}/*.js`)\n')
  assert.deepEqual(r.globs, [])
  assert.equal(r.warnings.length, 2)
  assert.deepEqual(r.warnings.map((w) => w.line), [1, 2])
  assert.match(r.warnings[0].detail, /不是字符串/)
})

test('换算不了的写法：记警告', () => {
  const r = find('src/a.js', "import.meta.glob('menu/*.js')")
  assert.deepEqual(r.globs, [])
  assert.match(r.warnings[0].detail, /无法换算.*menu\/\*\.js/)
})

test('注释里的 glob 不算', () => {
  const r = find('src/a.js', "// import.meta.glob('./old/*.js')\n/* import.meta.glob('./x/*.js') */\n")
  assert.deepEqual(r.globs, [])
  assert.deepEqual(r.warnings, [])
})

test('require.context 不归这里管（由 dynamic-imports 处理）', () => {
  const r = find('src/a.js', "const ctx = require.context('./svg', false, /\\.svg$/)")
  assert.deepEqual(r, { globs: [], warnings: [], unresolved: [] })
})

test('.vue 文件只看 <script>：模板里的撇号不会让后面的代码被当成字符串', () => {
  const vue = [
    '<template>',
    "  <p>Don't panic</p>",
    '</template>',
    '<script setup>',
    "const pages = import.meta.glob('./pages/*.vue')",
    '</script>'
  ].join('\n')
  const r = find('src/App.vue', vue)
  assert.deepEqual(r.globs, [{ from: 'src/App.vue', line: 5, pattern: './pages/*.vue', resolved: 'src/pages/*.vue' }])
})

test('scriptOnly：保留 script 内容，其余换成同样多的空行', () => {
  const vue = '<template>\n  <a/>\n</template>\n<script>\nx()\n</script>\n<style>\n</style>\n'
  const out = scriptOnly(vue)
  assert.equal(out.split('\n').length, vue.split('\n').length)
  assert.equal(out.split('\n')[4], 'x()')
  assert.doesNotMatch(out, /template|style/)
})

test('scriptOnly：.astro 开头 --- 之间的代码也保留', () => {
  const astro = "---\nconst p = import.meta.glob('./posts/*.md')\n---\n<h1>Don't</h1>\n"
  const r = find('src/pages/index.astro', astro)
  assert.deepEqual(r.globs.map((g) => [g.line, g.resolved]), [[2, 'src/pages/posts/*.md']])
})

test('没有 glob 的文件直接跳过', () => {
  assert.deepEqual(find('src/a.js', "import x from './x'"), { globs: [], warnings: [], unresolved: [] })
})

test('globToRegExp：整条路径匹配，支持 **、*、?、{a,b}、(a|b)', async () => {
  const { globToRegExp } = await import('../src/collect/glob-imports.js')
  assert.ok(globToRegExp('src/views/**/*.vue').test('src/views/a/_deprecated/Old.vue'))
  assert.ok(globToRegExp('src/views/**/*.vue').test('src/views/Old.vue'))
  assert.ok(!globToRegExp('src/views/*.vue').test('src/views/a/b.vue'))
  assert.ok(globToRegExp('src/i18n/*/zh-CN.(js|ts)').test('src/i18n/menu/zh-CN.ts'))
  assert.ok(!globToRegExp('src/i18n/*/zh-CN.(js|ts)').test('src/i18n/menu/zh-CN.vue'))
  assert.ok(globToRegExp('src/x/*.{js,ts}').test('src/x/a.js'))
  assert.ok(globToRegExp('src/x/?.js').test('src/x/a.js'))
})
