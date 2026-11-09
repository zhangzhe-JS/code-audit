import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  COMPILER_PLUGINS,
  assertOnlyCompilerPlugins,
  buildKnipConfig,
  findKnip,
  parseEnabledPlugins,
  parseUnusedFiles,
  readPluginNames
} from '../src/collect/knip.js'

/** 临时建一个假的 knip 目录 */
function fakeKnip(files) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-fakeknip-'))
  for (const [p, content] of Object.entries(files)) {
    mkdirSync(join(dir, p, '..'), { recursive: true })
    writeFileSync(join(dir, p), content)
  }
  return dir
}

test('buildKnipConfig：别名换成 knip 的 paths，同时匹配别名本身和别名/*', () => {
  const c = buildKnipConfig({ entry: ['src/main.js'], project: ['src/**/*.js'], aliases: { '@': 'src' }, pluginNames: [] })
  assert.deepEqual(c.paths, { '@': ['src'], '@/*': ['src/*'] })
  assert.deepEqual(c.entry, ['src/main.js'])
  assert.deepEqual(c.project, ['src/**/*.js'])
})

test('buildKnipConfig：关掉全部插件，只留解析单文件组件的，并且不读配置文件、不加入口', () => {
  const c = buildKnipConfig({ entry: [], project: [], aliases: {}, pluginNames: ['vite', 'eslint', 'vue', 'svelte'] })
  assert.equal(c.vite, false)
  assert.equal(c.eslint, false)
  assert.deepEqual(c.vue, { config: [], entry: [] })
  assert.deepEqual(c.svelte, { config: [], entry: [] })
  // 没在插件列表里的不写：knip 会拒绝不认识的插件名
  assert.equal('astro' in c, false)
})

test('parseEnabledPlugins：去掉终端颜色，取出插件名', () => {
  const out = "x\n[.] Enabled plugins\n[ \x1b[32m'Vue'\x1b[39m, \x1b[32m'Node.js'\x1b[39m ]\n[.] Finding config file\n['other']"
  assert.deepEqual(parseEnabledPlugins(out), ['Vue', 'Node.js'])
})

test('parseEnabledPlugins：跨多行、空列表', () => {
  assert.deepEqual(parseEnabledPlugins("Enabled plugins\n[\n  'Vue',\n  'Svelte'\n]"), ['Vue', 'Svelte'])
  assert.deepEqual(parseEnabledPlugins('Enabled plugins\n[]'), [])
})

test('parseEnabledPlugins：找不到这一段返回 null', () => {
  assert.equal(parseEnabledPlugins('nothing here'), null)
})

test('assertOnlyCompilerPlugins：只有解析单文件组件的插件时通过', () => {
  assertOnlyCompilerPlugins([])
  assertOnlyCompilerPlugins(Object.values(COMPILER_PLUGINS))
})

test('assertOnlyCompilerPlugins：有名单外的插件、无法核对时报错', () => {
  assert.throws(() => assertOnlyCompilerPlugins(['Vue', 'Vite']), /没能关掉的插件：Vite/)
  assert.throws(() => assertOnlyCompilerPlugins(null), /无法确认 knip 启用了哪些插件/)
})

test('parseUnusedFiles：取出有 files 的项，去重排序', () => {
  const r = parseUnusedFiles({
    issues: [
      { file: 'src/b.js', files: [{ name: 'src/b.js' }] },
      { file: 'src/a.js', files: [{ name: 'src/a.js' }] },
      { file: 'src/c.js', files: [], exports: [{ name: 'x' }] }
    ]
  })
  assert.deepEqual(r, ['src/a.js', 'src/b.js'])
})

test('parseUnusedFiles：格式不认识、路径不是相对路径时报错', () => {
  assert.throws(() => parseUnusedFiles({}), /没有 issues/)
  assert.throws(() => parseUnusedFiles({ issues: [{ file: '/abs/a.js', files: [{}] }] }), /不认识的文件路径/)
})

test('readPluginNames：优先读内部列表（knip 校验配置用的就是它）', () => {
  const dir = fakeKnip({
    'dist/types/PluginNames.js': "export const pluginNames = [\n  'vite',\n  'lint-staged',\n  'vue'\n];\n",
    'schema.json': JSON.stringify({ definitions: { plugins: { properties: { vite: {}, extra: {} } } } })
  })
  try {
    assert.deepEqual(readPluginNames(dir), ['lint-staged', 'vite', 'vue'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readPluginNames：没有内部列表时退回 schema.json；两份都没有时报错', () => {
  const dir = fakeKnip({ 'schema.json': JSON.stringify({ definitions: { plugins: { properties: { vite: {}, astro: {} } } } }) })
  const empty = fakeKnip({ 'package.json': '{}' })
  try {
    assert.deepEqual(readPluginNames(dir), ['astro', 'vite'])
    assert.throws(() => readPluginNames(empty), /读不到 knip 的插件列表/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('findKnip：--knip 指定的目录不是 knip 时报错', () => {
  const notKnip = fakeKnip({ 'package.json': JSON.stringify({ name: 'other', bin: 'x.js' }) })
  const noBin = fakeKnip({ 'package.json': JSON.stringify({ name: 'knip', version: '1.0.0', bin: { knip: 'bin/knip.js' } }) })
  try {
    assert.throws(() => findKnip(notKnip), /不是 knip 的安装目录/)
    assert.throws(() => findKnip(noBin), /找不到 knip 的命令文件/)
    assert.throws(() => findKnip(join(notKnip, 'nope')), /没有 package\.json/)
  } finally {
    rmSync(notKnip, { recursive: true, force: true })
    rmSync(noBin, { recursive: true, force: true })
  }
})

test('findKnip：--knip 指定的目录正确时返回版本和命令文件', () => {
  const dir = fakeKnip({
    'package.json': JSON.stringify({ name: 'knip', version: '9.9.9', bin: { knip: 'bin/knip.js' } }),
    'bin/knip.js': ''
  })
  try {
    const k = findKnip(dir)
    assert.equal(k.version, '9.9.9')
    assert.equal(k.bin, join(dir, 'bin/knip.js'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
