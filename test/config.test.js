import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, resolveConfig, loadProfile } from '../src/core/config.js'

test('不传配置时得到默认值', () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG)
})

test('只覆盖写了的项，其余用默认值', () => {
  const c = resolveConfig({ sourceRoots: ['app'] })
  assert.deepEqual(c.sourceRoots, ['app'])
  assert.deepEqual(c.extensions, DEFAULT_CONFIG.extensions)
  assert.equal(c.shortHashLength, DEFAULT_CONFIG.shortHashLength)
})

test('配置项拼错时报错，不悄悄忽略', () => {
  assert.throws(() => resolveConfig({ sourceRoot: ['app'] }), /不认识的配置项：sourceRoot/)
})

test('各配置项类型不对时报错，一次列出所有错误', () => {
  assert.throws(
    () => resolveConfig({ sourceRoots: ['/abs'], extensions: ['js'], shortHashLength: 2 }),
    (e) => /sourceRoots/.test(e.message) && /extensions/.test(e.message) && /shortHashLength/.test(e.message)
  )
  assert.throws(() => resolveConfig({ sourceRoots: ['src/'] }), /sourceRoots/) // 不能以 / 结尾
  assert.throws(() => resolveConfig({ extensions: [] }), /extensions/)
  assert.throws(() => resolveConfig(null), /配置必须是对象/)
})

test('得到的配置不能被修改，避免某处代码悄悄改了全局配置', () => {
  const c = resolveConfig()
  assert.throws(() => { c.sourceRoots.push('x') })
  assert.throws(() => { DEFAULT_CONFIG.extensions.push('.x') })
})

test('示例配置文件能正常加载', async () => {
  const file = fileURLToPath(new URL('../profiles/example.js', import.meta.url))
  const c = await loadProfile(file)
  assert.ok(c.extensions.includes('.astro'))
})

test('头注释的标题和结尾提示可以配置，并校验', () => {
  const c = resolveConfig({ headerTitle: '@deprecated', headerFooter: [] })
  assert.equal(c.headerTitle, '@deprecated')
  assert.deepEqual(c.headerFooter, [])
  assert.throws(() => resolveConfig({ headerTitle: '  ' }), /headerTitle/)
  assert.throws(() => resolveConfig({ headerFooter: ['ok', ''] }), /headerFooter/)
  assert.throws(() => resolveConfig({ headerFooter: 'not array' }), /headerFooter/)
})
test('默认头注释只陈述事实：标题不含流程要求，结尾提示为空', () => {
  assert.doesNotMatch(DEFAULT_CONFIG.headerTitle, /隔离|删除|禁止/)
  assert.deepEqual(DEFAULT_CONFIG.headerFooter, [])
})

test('headerStyles 按扩展名合并，并校验', () => {
  const c = resolveConfig({ headerStyles: { '.astro': 'html', '.vue': null } })
  assert.equal(c.headerStyles['.astro'], 'html')
  assert.equal(c.headerStyles['.vue'], null)
  assert.equal(c.headerStyles['.js'], 'block') // 没写的保留默认
  assert.throws(() => resolveConfig({ headerStyles: { '.js': 'line' } }), /headerStyles\["\.js"\]/)
  assert.throws(() => resolveConfig({ headerStyles: { js: 'block' } }), /键必须是扩展名/)
})

test('statusLabels 按状态合并，并校验', () => {
  const c = resolveConfig({ statusLabels: { dead: 'unused' } })
  assert.equal(c.statusLabels.dead, 'unused')
  assert.equal(c.statusLabels.live, DEFAULT_CONFIG.statusLabels.live)
  assert.throws(() => resolveConfig({ statusLabels: { removed: 'x' } }), /不认识的状态：removed/)
  assert.throws(() => resolveConfig({ statusLabels: { dead: '' } }), /statusLabels\["dead"\]/)
})

test('tableColumns、columnTitles 可以配置，并校验', () => {
  const c = resolveConfig({ tableColumns: ['target', 'status'], columnTitles: { target: 'File' } })
  assert.deepEqual(c.tableColumns, ['target', 'status'])
  assert.equal(c.columnTitles.target, 'File')
  assert.equal(c.columnTitles.status, DEFAULT_CONFIG.columnTitles.status)
  assert.throws(() => resolveConfig({ tableColumns: [] }), /tableColumns/)
  assert.throws(() => resolveConfig({ tableColumns: ['target', 'size'] }), /tableColumns/)
  assert.throws(() => resolveConfig({ tableColumns: ['target', 'target'] }), /tableColumns/)
  assert.throws(() => resolveConfig({ columnTitles: { size: '大小' } }), /不认识的列：size/)
  assert.throws(() => resolveConfig({ columnTitles: { target: ' ' } }), /columnTitles\["target"\]/)
})

test('按键合并的配置项写成 null、数组、字符串时报错，不悄悄用默认值', () => {
  for (const key of ['headerStyles', 'statusLabels', 'columnTitles']) {
    for (const bad of [null, [], 'x']) {
      assert.throws(() => resolveConfig({ [key]: bad }), new RegExp(`${key} 必须是对象`), `${key} = ${JSON.stringify(bad)} 应该报错`)
    }
  }
})

test('scan 的配置项：默认为空（入口、别名不猜），并校验', () => {
  assert.deepEqual(DEFAULT_CONFIG.entries, [])
  assert.deepEqual(DEFAULT_CONFIG.aliases, {})
  const c = resolveConfig({
    entries: ['src/main.js'],
    testEntries: ['src/**/*.test.js'],
    aliases: { '@': 'src', comps: 'src/components' },
    scanIgnore: ['src/mock/**']
  })
  assert.deepEqual(c.aliases, { '@': 'src', comps: 'src/components' })
  assert.ok(Object.isFrozen(c.entries) && Object.isFrozen(c.aliases))

  assert.throws(() => resolveConfig({ entries: '/abs/main.js' }), /entries 必须是/)
  assert.throws(() => resolveConfig({ entries: ['../x.js'] }), /entries 必须是/)
  assert.throws(() => resolveConfig({ testEntries: ['!src/a.js'] }), /testEntries 必须是/)
  assert.throws(() => resolveConfig({ scanIgnore: [1] }), /scanIgnore 必须是/)
  assert.throws(() => resolveConfig({ aliases: null }), /aliases 必须是对象/)
  assert.throws(() => resolveConfig({ aliases: { '@/*': 'src' } }), /aliases 的键必须是别名本身/)
  assert.throws(() => resolveConfig({ aliases: { '@': '../src' } }), /aliases\["@"\] 必须是/)
  assert.throws(() => resolveConfig({ aliases: { '@': 'src/' } }), /aliases\["@"\] 必须是/)
})

test('reviewedDynamicLoads：默认为空；写对了原样保留并冻结', () => {
  assert.deepEqual(resolveConfig({}).reviewedDynamicLoads, [])
  const c = resolveConfig({ reviewedDynamicLoads: [{ from: 'src/a.js', expr: 'import(url)', reason: 'CDN' }] })
  assert.deepEqual(c.reviewedDynamicLoads, [{ from: 'src/a.js', expr: 'import(url)', reason: 'CDN' }])
  assert.ok(Object.isFrozen(c.reviewedDynamicLoads[0]))
})

test('reviewedDynamicLoads：写错时报错，理由不能空着', () => {
  assert.throws(() => resolveConfig({ reviewedDynamicLoads: 'x' }), /reviewedDynamicLoads 必须是数组/)
  const bad = [
    'x',
    { from: '/abs.js', expr: 'import(x)', reason: 'r' },
    { from: 'src/*.js', expr: 'import(x)', reason: 'r' },
    { from: 'src/a.js', expr: ' ', reason: 'r' },
    { from: 'src/a.js', expr: 'import(x)', reason: '' },
    { from: 'src/a.js', expr: 'import(x)', reason: 'r', line: 3 }
  ]
  const msg = (() => {
    try {
      resolveConfig({ reviewedDynamicLoads: bad })
    } catch (e) {
      return e.message
    }
  })()
  for (const re of [/\[0\] 必须是对象/, /\[1\]\.from/, /\[2\]\.from/, /\[3\]\.expr/, /\[4\]\.reason 必须写确认的理由/, /\[5\] 不认识的字段：line/]) {
    assert.match(msg, re)
  }
})
