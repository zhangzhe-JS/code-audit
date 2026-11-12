import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { collectModules, instrument as realInstrument } from '../src/verify/bundlers/index.js'
import { bundlerEnv } from '../src/verify/bundlers/wrap.js'
import { isEsm } from '../src/verify/bundlers/webpack.js'
import { ORIGINAL_MARK } from '../src/verify/bundlers/vite.js'
import { resolveConfig } from '../src/core/config.js'

const require = createRequire(import.meta.url)

// 测试进程里直接加载包装配置：记录目录照基线构建的方式放进环境变量
const instrument = (o) => {
  Object.assign(process.env, bundlerEnv(o.outDir))
  return realInstrument(o)
}

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-webpack-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function setup(t, files) {
  const dir = tempDir(t)
  const tree = join(dir, 'tree')
  for (const [f, code] of Object.entries(files)) {
    mkdirSync(join(tree, f, '..'), { recursive: true })
    writeFileSync(join(tree, f), code)
  }
  return { tree, out: join(dir, 'modules') }
}

/** 假的 webpack：照 webpack 5 / 4 / 3 的样子调插件的 done */
function fakeCompiler({ hooks = true } = {}) {
  const taps = []
  const compiler = hooks ? { hooks: { done: { tap: (_n, fn) => taps.push(fn) } } } : { plugin: (ev, fn) => ev === 'done' && taps.push(fn) }
  return { compiler, done: (compilation, errors = false) => taps.forEach((fn) => fn({ compilation, hasErrors: () => errors })) }
}

function records(out) {
  if (!existsSync(out)) return []
  return readdirSync(out).map((f) => JSON.parse(readFileSync(join(out, f), 'utf8')))
}

/** webpack 5 的模块和 moduleGraph：exports 写 { 名字: [provided, 使用状态] } */
function wp5(modules) {
  const info = new Map()
  const mods = modules.map((m) => {
    const mod = { resource: m.resource, modules: m.modules }
    info.set(mod, { orderedExports: Object.entries(m.exports ?? {}).map(([name, [provided, used]]) => ({ name, provided, getUsed: (rt) => (rt === undefined ? used : -1) })) })
    return mod
  })
  return { mods, graph: { getExportsInfo: (m) => info.get(m) ?? { orderedExports: [] } } }
}

// ---------- webpack 适配器：包装配置 ----------

test('webpack 适配器：CommonJS 配置导出对象时原样返回，只在 plugins 末尾加一个；其他属性照样能用', (t) => {
  const { tree, out } = setup(t, { 'webpack.config.js': "module.exports = { mode: 'production', plugins: [{ own: 1 }], resolve: { alias: { '@': 'src' } } }\n" })
  const r = instrument({ type: 'webpack', dir: tree, outDir: out })
  assert.equal(r.config, 'webpack.config.js')
  assert.ok(existsSync(join(tree, `webpack.config${ORIGINAL_MARK}.js`)))
  const c = require(join(tree, 'webpack.config.js'))
  assert.equal(c.mode, 'production')
  assert.deepEqual(c.resolve, { alias: { '@': 'src' } })
  assert.equal(c.plugins.length, 2)
  assert.deepEqual(c.plugins[0], { own: 1 })
  assert.equal(c.plugins[1].constructor.name, 'CodeAuditModules')
  r.restore()
  assert.match(readFileSync(join(tree, 'webpack.config.js'), 'utf8'), /^module\.exports = \{ mode/)
  assert.equal(existsSync(join(tree, `webpack.config${ORIGINAL_MARK}.js`)), false)
})

test('webpack 适配器：数组、函数 (env, argv)、Promise 以及它们的组合都套上；函数的 this 和参数原样传', async (t) => {
  const { tree, out } = setup(t, {
    'webpack.config.js': `module.exports = function (env, argv) {
  return [
    { name: 'a', mode: argv.mode, self: this.tag },
    (e) => ({ name: 'b', env: e }),
    Promise.resolve({ name: 'c' })
  ]
}
`
  })
  instrument({ type: 'webpack', dir: tree, outDir: out })
  const fn = require(join(tree, 'webpack.config.js'))
  assert.equal(typeof fn, 'function')
  const arr = fn.call({ tag: 't' }, { x: 1 }, { mode: 'production' })
  assert.equal(arr.length, 3)
  assert.equal(arr[0].mode, 'production')
  assert.equal(arr[0].self, 't')
  const b = arr[1]({ y: 2 })
  assert.deepEqual(b.env, { y: 2 })
  const c = await arr[2]
  for (const cfg of [arr[0], b, c]) assert.equal(cfg.plugins.at(-1).constructor.name, 'CodeAuditModules', cfg.name)
})

test('webpack 适配器：编译出来的 __esModule 配置套 default；ESM（.mjs、type: module 的 .js）用 ESM 包装，具名导出转出去', async (t) => {
  const { tree, out } = setup(t, {
    'webpack.config.js': "Object.defineProperty(exports, '__esModule', { value: true }); exports.default = { plugins: [] }; exports.paths = { src: 'src' }\n"
  })
  instrument({ type: 'webpack', dir: tree, outDir: out })
  const m = require(join(tree, 'webpack.config.js'))
  assert.equal(m.__esModule, true)
  assert.deepEqual(m.paths, { src: 'src' })
  assert.equal(m.default.plugins[0].constructor.name, 'CodeAuditModules')

  const e = setup(t, { 'webpack.config.mjs': "export const shared = 1\nexport default async () => ({ mode: 'production', plugins: [] })\n" })
  assert.equal(instrument({ type: 'webpack', dir: e.tree, outDir: e.out }).config, 'webpack.config.mjs')
  const mod = await import(pathToFileURL(join(e.tree, 'webpack.config.mjs')).href)
  assert.equal(mod.shared, 1)
  const p = mod.default()
  assert.equal(typeof p.then, 'function', '异步函数返回的还是 Promise')
  const resolved = await p
  assert.equal(resolved.mode, 'production')
  assert.equal(resolved.plugins[0].constructor.name, 'CodeAuditModules')

  const j = setup(t, { 'package.json': '{"type":"module"}', 'webpack.config.js': 'export default { plugins: [] }\n' })
  instrument({ type: 'webpack', dir: j.tree, outDir: j.out })
  assert.match(readFileSync(join(j.tree, 'webpack.config.js'), 'utf8'), /^import /m)
  const jm = await import(pathToFileURL(join(j.tree, 'webpack.config.js')).href)
  assert.equal(jm.default.plugins[0].constructor.name, 'CodeAuditModules')
})

test('isEsm：看扩展名；.js/.ts 看最近的 package.json，不出临时目录；package.json 坏了按 CommonJS', (t) => {
  const { tree } = setup(t, {
    'package.json': '{"type":"module"}',
    'web/package.json': '{"name":"web"}',
    'bad/package.json': '{',
    'x.js': '',
    'web/x.js': '',
    'bad/x.ts': '',
    'a.cjs': '',
    'web/b.mts': ''
  })
  assert.equal(isEsm(join(tree, 'x.js'), tree), true)
  assert.equal(isEsm(join(tree, 'web/x.js'), tree), false, '最近的 package.json 没写 type')
  assert.equal(isEsm(join(tree, 'bad/x.ts'), tree), false)
  assert.equal(isEsm(join(tree, 'a.cjs'), tree), false)
  assert.equal(isEsm(join(tree, 'web/b.mts'), tree), true)
  const inner = join(tree, 'web')
  writeFileSync(join(tree, 'web/package.json.bak'), '')
  rmSync(join(tree, 'web/package.json'))
  assert.equal(isEsm(join(inner, 'x.js'), inner), false, '临时目录（这里是 web）外面的 package.json 不看')
})

test('webpack 适配器：按 webpack-cli 的顺序找配置；找不到时提示写 verify.bundlerConfig；老项目的 build/webpack.prod.conf.js 可以指定', (t) => {
  const { tree, out } = setup(t, { '.webpack/webpack.config.ts': 'export default {}\n', 'webpack.config.cjs': 'module.exports = {}\n' })
  assert.equal(instrument({ type: 'webpack', dir: tree, outDir: out }).config, 'webpack.config.cjs')
  const e = setup(t, { 'build/webpack.prod.conf.js': 'module.exports = { plugins: [] }\n' })
  assert.throws(() => instrument({ type: 'webpack', dir: e.tree, outDir: e.out }), /没有找到 webpack 配置文件.*verify\.bundlerConfig/)
  assert.throws(() => instrument({ type: 'webpack', dir: e.tree, outDir: e.out, config: 'build/nope.js' }), /配置文件不在提交里：build\/nope\.js/)
  instrument({ type: 'webpack', dir: e.tree, outDir: e.out, config: 'build/webpack.prod.conf.js' })
  assert.equal(require(join(e.tree, 'build/webpack.prod.conf.js')).plugins[0].constructor.name, 'CodeAuditModules')
  assert.deepEqual(resolveConfig({ verify: { build: 'npm run build', bundler: 'webpack', bundlerConfig: 'build/webpack.prod.conf.js' } }).verify.bundler, 'webpack')
  assert.equal(resolveConfig({ verify: { build: 'npm run build', bundler: 'vue-cli' } }).verify.bundler, 'vue-cli')
})

// ---------- webpack 适配器：记录插件 ----------

function pluginOf(t) {
  const { tree, out } = setup(t, { 'webpack.config.js': 'module.exports = {}\n' })
  instrument({ type: 'webpack', dir: tree, outDir: out })
  return { plugin: require(join(tree, 'webpack.config.js')).plugins[0], out, tree }
}

test('记录插件（webpack 5）：合并模块展开、同一模块只记一次；Unused 记摇掉，用到的记保留，没算（NoInfo）和不是确定提供的导出不记', (t) => {
  const { plugin, out, tree } = pluginOf(t)
  const { mods, graph } = wp5([
    { resource: join(tree, 'src/lib.js'), exports: { used: [true, 4], unused: [true, 0], props: [true, 1], dyn: [null, 0] } },
    { resource: join(tree, 'src/side.js'), exports: { s: [true, 0] } },
    { resource: join(tree, 'src/dev.js'), exports: { d: [true, 2] } },
    { resource: join(tree, 'src/a.vue?vue&type=script&lang=js'), exports: { default: [true, 3] } }
  ])
  const concat = { modules: [{ resource: join(tree, 'src/index.js') }, mods[0], mods[1]] } // 合并模块本身没有 resource
  const css = { identifier: () => 'css|x' }
  const { compiler, done } = fakeCompiler()
  plugin.apply(compiler)
  done({ modules: new Set([...mods, concat, css]), moduleGraph: graph })
  const [r] = records(out)
  assert.deepEqual(r.ids.sort(), [join(tree, 'src/a.vue?vue&type=script&lang=js'), join(tree, 'src/dev.js'), join(tree, 'src/index.js'), join(tree, 'src/lib.js'), join(tree, 'src/side.js')])
  assert.deepEqual(r.exports[join(tree, 'src/lib.js')], { rendered: ['used', 'props'], removed: ['unused'] }, 'lib.js 出现两次也只记一次')
  assert.deepEqual(r.exports[join(tree, 'src/side.js')], { rendered: [], removed: ['s'] })
  assert.equal(r.exports[join(tree, 'src/dev.js')], undefined, '开发模式没算使用情况的不记')
  assert.deepEqual(r.exports[join(tree, 'src/a.vue?vue&type=script&lang=js')], { rendered: ['default'], removed: [] })

  const m = collectModules(out, [tree])
  assert.equal(m.builds, 1)
  assert.deepEqual([...m.exports.get('src/a.vue').rendered], ['default'], '带查询参数的 id 换成源码文件')
})

test('记录插件（webpack 4 / 3）：usedExports 是数组 / true / false 时记，null 不记；providedExports 不是数组（CommonJS）不记；webpack 3 用 compiler.plugin', (t) => {
  const { plugin, out, tree } = pluginOf(t)
  const f = (n) => join(tree, `src/${n}.js`)
  const { compiler, done } = fakeCompiler()
  plugin.apply(compiler)
  done({
    modules: [
      { modules: [{ resource: f('arr'), buildMeta: { providedExports: ['a', 'b'] }, usedExports: ['a'] }, { resource: f('root'), buildMeta: { providedExports: [] }, usedExports: true }] },
      { resource: f('all'), buildMeta: { providedExports: ['x'] }, usedExports: true },
      { resource: f('none'), buildMeta: { providedExports: ['y'] }, usedExports: false },
      { resource: f('dev'), buildMeta: { providedExports: ['z'] }, usedExports: null },
      { resource: f('cjs'), buildMeta: { providedExports: true }, usedExports: true }
    ]
  })
  const [r] = records(out)
  assert.deepEqual(r.ids.sort(), ['all', 'arr', 'cjs', 'dev', 'none', 'root'].map(f))
  assert.deepEqual(r.exports, { [f('arr')]: { rendered: ['a'], removed: ['b'] }, [f('all')]: { rendered: ['x'], removed: [] }, [f('none')]: { rendered: [], removed: ['y'] } })

  // webpack 3：没有 hooks；导出信息直接挂在模块上
  const p3 = fakeCompiler({ hooks: false })
  plugin.apply(p3.compiler)
  p3.done({ modules: [{ resource: f('w3'), providedExports: ['k', 'j'], usedExports: ['k'] }] })
  const r3 = records(out).find((x) => x.ids.includes(f('w3')))
  assert.deepEqual(r3.exports, { [f('w3')]: { rendered: ['k'], removed: ['j'] } })
})

test('记录插件：构建有错误时不写记录（没有记录 = 不拿来救文件，也不当佐证）；每次 done 写一份', (t) => {
  const { plugin, out, tree } = pluginOf(t)
  const { compiler, done } = fakeCompiler()
  plugin.apply(compiler)
  done({ modules: [{ resource: join(tree, 'src/a.js') }] }, true)
  assert.equal(records(out).length, 0)
  done({ modules: [{ resource: join(tree, 'src/a.js') }] })
  done({ modules: [{ resource: join(tree, 'src/b.js') }] })
  assert.equal(collectModules(out, [tree]).builds, 2)
})

// ---------- Vue CLI 适配器 ----------

/** 照 Vue CLI 的方式调 chainWebpack：只用到 config.plugin(name).use(Plugin) */
function chain() {
  const plugins = []
  return { plugins, plugin: (name) => ({ use: (P, args = []) => plugins.push({ name, instance: new P(...args) }) }) }
}

test('vue-cli 适配器：原来的 chainWebpack 先照常跑（this 原样），再加记录插件；其他选项不动', (t) => {
  const { tree, out } = setup(t, {
    'vue.config.js': "module.exports = { publicPath: './', chainWebpack(config) { config.plugin('own').use(class Own {}); this.called = true } }\n"
  })
  assert.equal(instrument({ type: 'vue-cli', dir: tree, outDir: out }).config, 'vue.config.js')
  const options = require(join(tree, 'vue.config.js'))
  assert.equal(options.publicPath, './')
  const c = chain()
  const self = {}
  options.chainWebpack.call(self, c)
  assert.deepEqual(c.plugins.map((p) => p.name), ['own', 'code-audit-modules'])
  assert.equal(c.plugins[1].instance.constructor.name, 'CodeAuditModules')
  assert.equal(self.called, true)
})

test('vue-cli 适配器：没写 chainWebpack、导出函数 / Promise、ESM 的 vue.config.mjs 都能套；写在 package.json 里的提示加配置文件', async (t) => {
  const { tree, out } = setup(t, { 'vue.config.js': "module.exports = () => Promise.resolve({ lintOnSave: false })\n" })
  instrument({ type: 'vue-cli', dir: tree, outDir: out })
  const options = await require(join(tree, 'vue.config.js'))()
  assert.equal(options.lintOnSave, false)
  const c = chain()
  options.chainWebpack(c)
  assert.deepEqual(c.plugins.map((p) => p.name), ['code-audit-modules'])

  const e = setup(t, { 'vue.config.mjs': 'export default { chainWebpack() {} }\n' })
  instrument({ type: 'vue-cli', dir: e.tree, outDir: e.out })
  const mod = await import(pathToFileURL(join(e.tree, 'vue.config.mjs')).href)
  const c2 = chain()
  mod.default.chainWebpack(c2)
  assert.equal(c2.plugins.length, 1)

  const p = setup(t, { 'package.json': '{"vue":{"publicPath":"./"}}' })
  assert.throws(() => instrument({ type: 'vue-cli', dir: p.tree, outDir: p.out }), /没有找到 Vue CLI 配置文件.*package\.json 的 "vue" 字段/)
})
