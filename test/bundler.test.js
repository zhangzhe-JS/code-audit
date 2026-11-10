import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRepo } from './helpers/repo.js'
import { instrument as instrumentVite, ORIGINAL_MARK } from '../src/verify/bundlers/vite.js'
import { collectModules, instrument, instrumentAll, toRepoFile, workDirsOf } from '../src/verify/bundlers/index.js'
import { age, baselineKey, cacheDir, depsFingerprint, readBaseline, writeBaseline } from '../src/verify/cache.js'
import { verifyReport } from '../src/verify/index.js'
import { runCommand } from '../src/verify/run-command.js'
import { resolveConfig } from '../src/core/config.js'
import { SCHEMA_VERSION, validate } from '../src/core/schema.js'
import { TOOL } from '../src/core/tool.js'

process.env.CODE_AUDIT_CACHE_DIR = mkdtempSync(join(tmpdir(), 'code-audit-cache-'))

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-bundler-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 照 Vite 的方式调用插件：build 时的 buildEnd、generateBundle */
async function runPlugins(config, ids, bundle = {}) {
  const resolved = typeof config === 'function' ? await config({ command: 'build', mode: 'production' }) : await config
  for (const p of resolved.plugins ?? []) {
    if (typeof p !== 'object' || (p.apply && p.apply !== 'build')) continue
    p.buildEnd?.call({ getModuleIds: () => ids[Symbol.iterator]() })
    p.generateBundle?.call({}, {}, bundle)
  }
  return resolved
}

// ---------- Vite 适配器 ----------

test('vite 适配器：套一层后原样返回配置，只在 plugins 末尾加一个；具名导出照样能用', async (t) => {
  const dir = tempDir(t)
  const tree = join(dir, 'tree')
  mkdirSync(tree)
  writeFileSync(join(tree, 'vite.config.mjs'), "export const shared = 1\nexport default { base: './', plugins: [{ name: 'own' }] }\n")
  const out = join(dir, 'modules')
  assert.equal(instrument({ type: 'vite', dir: tree, outDir: out }).config, 'vite.config.mjs')
  assert.ok(existsSync(join(tree, `vite.config${ORIGINAL_MARK}.mjs`)))

  const mod = await import(pathToFileURL(join(tree, 'vite.config.mjs')).href)
  assert.equal(mod.shared, 1)
  assert.equal(typeof mod.default, 'object') // 还是对象：vitest.config 里 mergeConfig(viteConfig, …) 要求是对象
  assert.equal(mod.default.base, './')
  assert.deepEqual(mod.default.plugins.map((p) => p.name), ['own', 'code-audit:modules'])
  assert.equal(mod.default.plugins[1].apply, 'build') // dev、vitest 里不起作用

  // getModuleIds 和产物里的 chunk 都收
  await runPlugins(mod.default, [join(tree, 'src/a.js')], { 'x.js': { type: 'chunk', modules: { [join(tree, 'src/b.vue')]: {} } }, 'y.css': { type: 'asset' } })
  const files = readdirSync(out)
  assert.equal(files.length, 1)
  assert.deepEqual(JSON.parse(readFileSync(join(out, files[0]), 'utf8')).sort(), [join(tree, 'src/a.js'), join(tree, 'src/b.vue')])
})

test('vite 适配器：导出函数、异步函数时形状不变；CommonJS 配置也能套', async (t) => {
  const dir = tempDir(t)
  for (const [name, code] of [
    ['fn', 'export default ({ mode }) => ({ mode, plugins: [] })\n'],
    ['async', 'export default async () => ({ plugins: [[{ name: "nested" }]] })\n']
  ]) {
    const tree = join(dir, name)
    mkdirSync(tree)
    writeFileSync(join(tree, 'vite.config.mjs'), code)
    instrumentVite({ dir: tree, outDir: join(dir, `${name}-out`) })
    const mod = await import(pathToFileURL(join(tree, 'vite.config.mjs')).href)
    assert.equal(typeof mod.default, 'function', name)
    const c = await runPlugins(mod.default, [])
    assert.equal(c.plugins.at(-1).name, 'code-audit:modules', name)
    if (name === 'fn') assert.equal(c.mode, 'production')
  }

  const tree = join(dir, 'cjs')
  mkdirSync(tree)
  writeFileSync(join(tree, 'vite.config.cjs'), 'module.exports = { plugins: [] }\n')
  instrumentVite({ dir: tree, outDir: join(dir, 'cjs-out') })
  const c = createRequire(import.meta.url)(join(tree, 'vite.config.cjs'))
  assert.deepEqual(c.plugins.map((p) => p.name), ['code-audit:modules'])
})

test('vite 适配器：按 Vite 的顺序找配置文件；找不到、指定的不存在时报错；不支持的打包器报错', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
  writeFileSync(join(dir, 'vite.config.mts'), 'export default {}\n')
  assert.equal(instrumentVite({ dir, outDir: join(dir, 'o') }).config, 'vite.config.ts')
  const empty = join(dir, 'empty')
  mkdirSync(empty)
  assert.throws(() => instrumentVite({ dir: empty, outDir: join(dir, 'o') }), /没有找到 vite 配置文件.*verify\.bundlerConfig/)
  assert.throws(() => instrumentVite({ dir: empty, outDir: join(dir, 'o'), config: 'web/vite.config.js' }), /指定的 vite 配置文件不在提交里/)
  assert.throws(() => instrument({ type: 'webpack', dir, outDir: join(dir, 'o') }), /不支持的打包器：webpack/)
})

test('toRepoFile、collectModules：去掉查询参数和虚拟模块，依赖包、临时目录外的不要；两种临时目录写法都认；读完清空', (t) => {
  const dirs = ['/var/w/tree', '/private/var/w/tree']
  assert.equal(toRepoFile('/var/w/tree/src/a.vue?vue&type=style&index=0&lang.css', dirs), 'src/a.vue')
  assert.equal(toRepoFile('/private/var/w/tree/src/b.js', dirs), 'src/b.js')
  assert.equal(toRepoFile('\0plugin-helper', dirs), null)
  assert.equal(toRepoFile('/var/w/tree/node_modules/vue/index.js', dirs), null)
  assert.equal(toRepoFile('/var/w/tree-other/src/a.js', dirs), null)
  assert.equal(toRepoFile('/elsewhere/a.js', dirs), null)

  const dir = tempDir(t)
  const out = join(dir, 'm')
  assert.deepEqual(collectModules(out, dirs), { builds: 0, files: new Set(), bad: [] })
  mkdirSync(out)
  writeFileSync(join(out, '1.json'), JSON.stringify(['/var/w/tree/src/a.js', '\0x']))
  writeFileSync(join(out, '2.json'), JSON.stringify(['/private/var/w/tree/src/b.js', '/var/w/tree/src/a.js?raw']))
  writeFileSync(join(out, '3.json'), '["/var/w/tree/src/c.js", "/var/w') // 构建被结束时写了一半
  assert.deepEqual(collectModules(out, dirs), { builds: 2, files: new Set(['src/a.js', 'src/b.js']), bad: ['3.json'] })
  assert.equal(existsSync(out), false)
})

// ---------- 基线缓存 ----------

test('基线缓存：提交、命令、依赖任何一项变了键就变；读写、坏文件当没有缓存', (t) => {
  const verify = { build: 'b', test: null, timeoutSeconds: 60, bundler: null, bundlerConfig: null }
  const key = baselineKey({ commit: 'c1', verify, deps: ['.=x'] })
  assert.equal(baselineKey({ commit: 'c1', verify: { ...verify }, deps: ['.=x'] }), key)
  assert.notEqual(baselineKey({ commit: 'c2', verify, deps: ['.=x'] }), key)
  assert.notEqual(baselineKey({ commit: 'c1', verify: { ...verify, test: 't' }, deps: ['.=x'] }), key)
  assert.notEqual(baselineKey({ commit: 'c1', verify: { ...verify, bundler: 'vite' }, deps: ['.=x'] }), key)
  assert.notEqual(baselineKey({ commit: 'c1', verify, deps: ['.=y'] }), key)

  const dir = tempDir(t)
  assert.equal(readBaseline(key, dir), null)
  writeBaseline(key, { results: { build: { ok: true } }, modules: ['src/a.js'], builds: 1 }, dir)
  const hit = readBaseline(key, dir)
  assert.deepEqual([hit.results.build.ok, hit.modules, hit.builds], [true, ['src/a.js'], 1])
  writeFileSync(join(dir, `${key}.json`), '{"format":1,"res')
  assert.equal(readBaseline(key, dir), null)

  assert.match(cacheDir({ CODE_AUDIT_CACHE_DIR: '/c' }), /^\/c\/baseline$/)
  assert.match(cacheDir({ XDG_CACHE_HOME: '/x' }), /^\/x\/code-audit\/baseline$/)
  assert.equal(age('2026-11-09T00:00:00Z', Date.parse('2026-11-09T00:05:00Z')), '5 分钟前')
  assert.equal(age('2026-11-09T00:00:00Z', Date.parse('2026-11-09T03:00:00Z')), '3 小时前')
})

test('depsFingerprint：重新装过依赖（记录文件变了）指纹就变；没有记录文件时用 node_modules 目录', (t) => {
  const root = tempDir(t)
  mkdirSync(join(root, 'node_modules'))
  const bare = depsFingerprint(root, [{ dir: '' }])
  assert.match(bare[0], /^\.=dir@/)
  writeFileSync(join(root, 'node_modules/.modules.yaml'), 'a')
  const first = depsFingerprint(root, [{ dir: '' }])
  assert.match(first[0], /\.modules\.yaml@1:/)
  writeFileSync(join(root, 'node_modules/.modules.yaml'), 'abc')
  assert.notDeepEqual(depsFingerprint(root, [{ dir: '' }]), first)
})

// ---------- 和 verify 连起来 ----------

/**
 * 一个小项目，build.mjs 模仿 vite build：读 vite.config.mjs，顺着 import 走，再按 glob.json 加载文件（静态分析看不出的引用），
 * 构建结束时照 Vite 的方式调用插件；mystery.js 不经过模块图（直接看文件在不在），打包器看不到
 */
function bundlerRepo() {
  const repo = createRepo()
  repo.write('package.json', '{"name":"demo"}')
  repo.write('vite.config.mjs', 'export default { plugins: [] }\n')
  repo.write('build.mjs', `
import fs from 'node:fs'
import path from 'node:path'
const mod = await import(path.resolve('vite.config.mjs'))
const config = typeof mod.default === 'function' ? await mod.default({ command: 'build' }) : mod.default
const seen = new Set()
function walk(file) {
  if (seen.has(file)) return
  if (!fs.existsSync(file)) { console.error('Could not resolve "' + file + '"'); process.exit(1) }
  seen.add(file)
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/import ['"](.+?)['"]/g)) walk(path.join(path.dirname(file), m[1]))
}
walk('src/main.js')
for (const f of JSON.parse(fs.readFileSync('glob.json', 'utf8'))) walk(f)
const ids = [...seen].map((f) => path.resolve(f)).concat(['\\0virtual', path.resolve('node_modules/x/index.js')])
for (const p of config.plugins ?? []) {
  if (p.apply && p.apply !== 'build') continue
  p.buildEnd?.call({ getModuleIds: () => ids[Symbol.iterator]() })
  p.generateBundle?.call({}, {}, {})
}
if (!fs.existsSync('src/mystery.js')) { console.error('Error: something broke'); process.exit(1) }
console.log('built ok')
`)
  repo.write('glob.json', '["src/globbed.js"]')
  repo.write('src/main.js', "import './a.js'\n")
  repo.write('src/a.js', '')
  for (const f of ['dead', 'globbed', 'mystery']) repo.write(`src/${f}.js`, '')
  repo.commit('init')
  return repo
}

function dataFor(repo, statuses = {}) {
  const item = (target) => ({
    id: `file:${target}`,
    kind: 'file',
    target,
    status: statuses[target] ?? 'dead',
    evidence: [{ rule: 'no-ref', detail: '没人用' }],
    refs: [],
    history: null,
    verify: null
  })
  return {
    version: SCHEMA_VERSION,
    generatedAt: '2026-11-09T00:00:00.000Z',
    tool: { ...TOOL },
    project: { name: 'demo', root: repo.root, rev: repo.run(['rev-parse', 'HEAD']), entries: ['src/main.js'] },
    items: ['src/dead.js', 'src/globbed.js', 'src/mystery.js', ...Object.keys(statuses).filter((f) => !['src/dead.js', 'src/globbed.js', 'src/mystery.js'].includes(f))].sort().map(item)
  }
}

test('verifyReport + 打包器证据：构建加载过的候选不删、判 unknown，不用为它多跑几轮；打包器看不到的照常靠实删发现', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  const config = resolveConfig({ verify: { build: 'node build.mjs', timeoutSeconds: 60, bundler: 'vite' } })
  const logs = []
  const commands = []
  const run = (cmd, opts) => {
    commands.push(cmd)
    return runCommand(cmd, opts)
  }
  const { data, summary } = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m), run, cacheDir: cache })
  const by = Object.fromEntries(data.items.map((i) => [i.target, i]))

  assert.equal(by['src/globbed.js'].status, 'unknown')
  assert.equal(by['src/globbed.js'].evidence.at(-1).rule, 'bundler-included')
  assert.match(by['src/globbed.js'].evidence.at(-1).detail, /构建（vite）加载了这个文件，和静态分析的结论（dead）矛盾/)
  assert.equal(by['src/globbed.js'].verify, null) // 没删过
  assert.equal(by['src/dead.js'].verify.passed, true)
  assert.equal(by['src/mystery.js'].status, 'unknown')
  assert.equal(by['src/mystery.js'].evidence.at(-1).rule, 'verify-failed')
  assert.deepEqual(summary.bundled, ['src/globbed.js'])
  assert.deepEqual(validate(data), [])
  assert.ok(logs.some((l) => /记录了 1 次构建，加载了 3 个源码文件/.test(l)), logs.join('\n'))
  assert.equal(readFileSync(join(repo.root, 'vite.config.mjs'), 'utf8'), 'export default { plugins: [] }\n') // 原项目不动

  // 第二次：基线复用缓存，少跑一次构建；打包器证据跟着缓存
  const before = commands.length
  const logs2 = []
  const again = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs2.push(m), run, cacheDir: cache })
  assert.equal(again.summary.baselineCachedAt !== null, true)
  assert.deepEqual(again.summary.bundled, ['src/globbed.js'])
  assert.equal(commands.length - before, before - 1)
  assert.ok(logs2.some((l) => /复用 .*的基线/.test(l)))

  // 不用缓存：照样跑基线
  const fresh = await verifyReport({ data: dataFor(repo), root: repo.root, config, run, cacheDir: cache, useCache: false })
  assert.equal(fresh.summary.baselineCachedAt, null)
})

test('verifyReport + 打包器证据：构建没经过套好的配置时提示，照常验证', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  // 构建命令不读 vite.config.mjs：拿不到模块列表
  const config = resolveConfig({ verify: { build: 'node -e "1"', timeoutSeconds: 60, bundler: 'vite' } })
  const logs = []
  const { summary } = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m), cacheDir: cache })
  assert.deepEqual(summary.bundled, [])
  assert.equal(summary.passed, 3)
  assert.ok(logs.some((l) => /没拿到打包器的模块列表/.test(l)))
})

test('verifyReport：基线构建失败时不写缓存', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  const config = resolveConfig({ verify: { build: 'node -e "process.exit(1)"', timeoutSeconds: 60 } })
  await assert.rejects(verifyReport({ data: dataFor(repo), root: repo.root, config, cacheDir: cache }), /基线构建就失败了/)
  assert.deepEqual(existsSync(cache) ? readdirSync(cache) : [], [])
})

test('vite 适配器：生成的配置开头关掉 eslint 和 TS 检查（构建前会 lint、类型检查的项目）；restore 放回原配置', (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'vite.config.ts'), 'export default {}\n')
  const r = instrumentVite({ dir, outDir: join(dir, 'o') })
  const code = readFileSync(join(dir, 'vite.config.ts'), 'utf8')
  assert.match(code, /^\/\* eslint-disable \*\/\n\/\/ @ts-nocheck\n/)
  r.restore()
  assert.equal(readFileSync(join(dir, 'vite.config.ts'), 'utf8'), 'export default {}\n')
  assert.equal(existsSync(join(dir, `vite.config${ORIGINAL_MARK}.ts`)), false)
})

test('verifyReport + 打包器证据：套了配置后构建失败时撤掉重跑，照常验证；复用缓存时也撤掉', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  // 模仿构建前的 lint：配置文件不是原样就报错
  repo.write('lint.mjs', "import fs from 'node:fs'\nif (fs.readFileSync('vite.config.mjs', 'utf8').includes('code-audit')) { console.error('vite.config.mjs  1:1  error  bad style'); process.exit(1) }\n")
  repo.commit('lint')
  const config = resolveConfig({ verify: { build: 'node lint.mjs && node build.mjs', timeoutSeconds: 60, bundler: 'vite' } })
  const logs = []
  const { data, summary } = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m), cacheDir: cache })
  assert.match(summary.bundlerDropped, /套了打包器配置后构建失败（vite\.config\.mjs 1:1 error bad style）/)
  assert.deepEqual(summary.bundled, [])
  const by = Object.fromEntries(data.items.map((i) => [i.target, i]))
  assert.equal(by['src/dead.js'].verify.passed, true) // 删文件的每一轮也用撤掉后的配置
  assert.equal(by['src/globbed.js'].evidence.at(-1).rule, 'verify-failed') // 没有打包器证据，靠实删发现
  assert.ok(logs.some((l) => /撤掉后构建成功.*这次没有打包器证据/.test(l)))

  const again = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: () => {}, cacheDir: cache })
  assert.ok(again.summary.baselineCachedAt)
  assert.equal(again.data.items.find((i) => i.target === 'src/dead.js').verify.passed, true)
})

test('vite 适配器：项目里本来就有同名的改名文件时换个名字，不覆盖；restore 后两个文件都在', async (t) => {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'vite.config.mjs'), 'export default { base: "/own/" }\n')
  writeFileSync(join(dir, `vite.config${ORIGINAL_MARK}.mjs`), '// 项目自己的文件\n')
  const r = instrumentVite({ dir, outDir: join(dir, 'o') })
  assert.equal(readFileSync(join(dir, `vite.config${ORIGINAL_MARK}.mjs`), 'utf8'), '// 项目自己的文件\n')
  assert.equal(readFileSync(join(dir, `vite.config${ORIGINAL_MARK}-2.mjs`), 'utf8'), 'export default { base: "/own/" }\n')
  const mod = await import(pathToFileURL(join(dir, 'vite.config.mjs')).href)
  assert.equal(mod.default.base, '/own/') // 包装配置读的是改名后的原配置
  r.restore()
  assert.equal(readFileSync(join(dir, 'vite.config.mjs'), 'utf8'), 'export default { base: "/own/" }\n')
  assert.equal(readFileSync(join(dir, `vite.config${ORIGINAL_MARK}.mjs`), 'utf8'), '// 项目自己的文件\n')
  assert.equal(existsSync(join(dir, `vite.config${ORIGINAL_MARK}-2.mjs`)), false)
})

test('verifyReport + 打包器证据：test-only、pending、dormant 也在说当前构建用不到，构建却加载了就判 unknown；external 不动', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  // main.js 静态 import 了 a.js：a.js 被标成 test-only（静态分析误判）
  repo.write('glob.json', '["src/globbed.js", "src/pend.js", "src/note.js", "src/ext.js"]')
  for (const f of ['pend', 'note', 'ext']) repo.write(`src/${f}.js`, '')
  repo.commit('more')
  const statuses = { 'src/a.js': 'test-only', 'src/pend.js': 'pending', 'src/note.js': 'dormant', 'src/ext.js': 'external' }
  const config = resolveConfig({ verify: { build: 'node build.mjs', timeoutSeconds: 60, bundler: 'vite' } })
  const logs = []
  const { data, summary } = await verifyReport({ data: dataFor(repo, statuses), root: repo.root, config, log: (m) => logs.push(m), cacheDir: cache })
  const by = Object.fromEntries(data.items.map((i) => [i.target, i]))
  for (const [f, was] of [['src/a.js', 'test-only'], ['src/pend.js', 'pending'], ['src/note.js', 'dormant']]) {
    assert.equal(by[f].status, 'unknown', f)
    assert.match(by[f].evidence.at(-1).detail, new RegExp(`和静态分析的结论（${was}）矛盾`))
    assert.doesNotMatch(by[f].evidence.at(-1).detail, /不删/) // 本来就不删
  }
  assert.equal(by['src/ext.js'].status, 'external') // external 本来就说构建在用，不矛盾
  assert.match(by['src/globbed.js'].evidence.at(-1).detail, /不删，请人工确认/)
  assert.deepEqual(summary.bundled, ['src/globbed.js'])
  assert.deepEqual(summary.contradicted.sort(), ['src/a.js', 'src/globbed.js', 'src/note.js', 'src/pend.js'])
  assert.ok(logs.some((l) => /其中 4 个静态分析说当前构建用不到.*1 个要删的不删/.test(l)), logs.join('\n'))
  assert.deepEqual(validate(data), [])
})

test('verifyReport + 打包器证据：套不上（配置文件不在这个提交里）只提示，照常验证', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  const config = resolveConfig({ verify: { build: 'node build.mjs', timeoutSeconds: 60, bundler: 'vite', bundlerConfig: 'web/vite.config.ts' } })
  const logs = []
  const { summary } = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m), cacheDir: cache })
  assert.match(summary.bundlerDropped, /没能套上打包器配置：.*不在提交里：web\/vite\.config\.ts/)
  assert.equal(summary.passed, 1) // dead.js；globbed、mystery 靠实删发现
  assert.ok(logs.some((l) => /照常验证，只是没有打包器证据/.test(l)))
})

test('verifyReport：缓存目录写不了只提示，照常验证', async (t) => {
  const repo = bundlerRepo()
  const dir = tempDir(t)
  t.after(() => repo.cleanup())
  const blocked = join(dir, 'file')
  writeFileSync(blocked, '') // 缓存目录的位置是个文件：建不了目录
  const config = resolveConfig({ verify: { build: 'node build.mjs', timeoutSeconds: 60, bundler: 'vite' } })
  const logs = []
  const { summary } = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m), cacheDir: join(blocked, 'baseline') })
  assert.deepEqual(summary.bundled, ['src/globbed.js'])
  assert.ok(logs.some((l) => /基线缓存读写出错，这次不用缓存/.test(l)))
})

test('verifyReport + 打包器证据：项目本身就构建不过时，撤掉重跑后说明不是打包器配置的问题', async (t) => {
  const repo = bundlerRepo()
  const cache = tempDir(t)
  t.after(() => repo.cleanup())
  const config = resolveConfig({ verify: { build: 'node build.mjs && node -e "process.exit(1)"', timeoutSeconds: 60, bundler: 'vite' } })
  const logs = []
  await assert.rejects(verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m), cacheDir: cache }), /基线构建就失败了/)
  assert.ok(logs.some((l) => /撤掉后构建还是失败：不是打包器配置引起的/.test(l)))
  assert.ok(!logs.some((l) => /撤掉后构建成功/.test(l)))
})

test('instrumentAll：monorepo 里套多个配置；有一个套不上就把套上的撤掉', (t) => {
  const dir = tempDir(t)
  for (const app of ['a', 'b']) {
    mkdirSync(join(dir, app))
    writeFileSync(join(dir, app, 'vite.config.mjs'), `export default { base: '/${app}/' }\n`)
  }
  const r = instrumentAll({ type: 'vite', dir, outDir: join(dir, 'o'), configs: ['a/vite.config.mjs', 'b/vite.config.mjs'] })
  assert.deepEqual(r.configs, ['a/vite.config.mjs', 'b/vite.config.mjs'])
  assert.match(readFileSync(join(dir, 'b/vite.config.mjs'), 'utf8'), /code-audit/)
  r.restore()
  assert.equal(readFileSync(join(dir, 'a/vite.config.mjs'), 'utf8'), "export default { base: '/a/' }\n")

  assert.throws(() => instrumentAll({ type: 'vite', dir, outDir: join(dir, 'o'), configs: ['a/vite.config.mjs', 'c/vite.config.mjs'] }), /不在提交里：c\/vite\.config\.mjs/)
  assert.equal(readFileSync(join(dir, 'a/vite.config.mjs'), 'utf8'), "export default { base: '/a/' }\n") // 已经套上的撤掉了
  assert.equal(readdirSync(join(dir, 'a')).length, 1)
})

test('toRepoFile：模块 id 的大小写和磁盘上不一样时（不区分大小写的文件系统），按磁盘上的算', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'fooBar.vue'), '')
  const insensitive = existsSync(join(dir, 'SRC', 'FOOBAR.vue'))
  if (!insensitive) return t.skip('文件系统区分大小写：import 写错大小写本来就加载不到')
  assert.equal(toRepoFile(join(dir, 'Src', 'FooBar.vue?vue&type=script'), workDirsOf(dir)), 'src/fooBar.vue')
})
