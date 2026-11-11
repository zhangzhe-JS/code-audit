import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRepo } from './helpers/repo.js'
import { verifyReport } from '../src/verify/index.js'
import { resolveConfig } from '../src/core/config.js'
import { SCHEMA_VERSION, validate } from '../src/core/schema.js'
import { TOOL } from '../src/core/tool.js'

// 基线缓存写到临时目录：不碰用户的 ~/.cache，测试之间也不互相复用（子进程继承这个环境变量）
process.env.CODE_AUDIT_CACHE_DIR = mkdtempSync(join(tmpdir(), 'code-audit-cache-'))

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

/**
 * 一个小项目，构建、测试都是真的 node 脚本：
 * - build.js：从 src/main.js 顺着 import 走，缺文件时报 Could not resolve；还按 assets.json 直接读文件；
 *   src/mystery.js 不在时只报一句看不出是谁的错误
 * - test.js：tests/helper.test.js 用到 src/helper.js；tests/old.test.js 本来就失败
 */
function projectRepo() {
  const repo = createRepo()
  repo.write('package.json', '{"name":"demo"}')
  repo.write('build.js', `
const fs = require('fs'), path = require('path')
const seen = new Set()
function walk(file) {
  if (seen.has(file)) return
  seen.add(file)
  const code = fs.readFileSync(file, 'utf8')
  for (const m of code.matchAll(/import ['"](.+?)['"]/g)) {
    const target = path.join(path.dirname(file), m[1])
    if (!fs.existsSync(target)) { console.error('Could not resolve "' + m[1] + '" from "' + file + '"'); process.exit(1) }
    walk(target)
  }
}
walk('src/main.js')
for (const f of JSON.parse(fs.readFileSync('assets.json', 'utf8'))) fs.readFileSync(path.resolve(f))
if (!fs.existsSync('src/mystery.js')) { console.error('Error: something broke'); process.exit(1) }
console.log('built ok in 12ms')
`)
  repo.write('test.js', `
const fs = require('fs')
let failed = 0
console.log(' FAIL  tests/old.test.js > old > broken'); failed++
if (!fs.existsSync('src/helper.js')) { console.log(' FAIL  tests/helper.test.js > helper > works'); failed++ }
console.log('done')
process.exit(failed ? 1 : 0)
`)
  repo.write('assets.json', '["src/secret.js"]')
  repo.write('tests/helper.test.js', "import { h } from '../src/helper.js'\n")
  repo.write('src/main.js', "import './a.js'\n")
  repo.write('src/a.js', '')
  for (const f of ['dead1', 'dead-child', 'secret', 'helper', 'mystery', 'fine']) repo.write(`src/${f}.js`, f === 'dead1' ? "import './dead-child.js'\n" : '')
  repo.commit('init')
  return repo
}

function dataFor(repo) {
  const item = (target, status, refs = []) => ({
    id: `file:${target}`,
    kind: 'file',
    target,
    status,
    evidence: [{ rule: 'no-ref', detail: '没人用' }],
    refs,
    history: null,
    verify: null
  })
  const items = [
    item('src/dead-child.js', 'dead-only-ref', [{ from: 'src/dead1.js', line: 1, via: 'static' }]),
    item('src/dead1.js', 'dead'),
    item('src/fine.js', 'dead'),
    item('src/helper.js', 'dead'),
    item('src/mystery.js', 'dead'),
    item('src/secret.js', 'dead'),
    item('src/kept.js', 'external')
  ].sort((x, y) => (x.id < y.id ? -1 : 1))
  return {
    version: SCHEMA_VERSION,
    generatedAt: '2026-11-09T00:00:00.000Z',
    tool: { ...TOOL },
    project: { name: 'demo', root: repo.root, rev: repo.run(['rev-parse', 'HEAD']), entries: ['src/main.js'] },
    items
  }
}

const config = resolveConfig({ verify: { build: 'node build.js', test: 'node test.js', timeoutSeconds: 60 } })

test('verifyReport：真的删掉再跑，能删的通过；删了会出问题的改成 unknown 并写明原因', async (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const logs = []
  const { data, summary } = await verifyReport({ data: dataFor(repo), root: repo.root, config, log: (m) => logs.push(m) })
  const by = Object.fromEntries(data.items.map((i) => [i.target, i]))

  for (const f of ['src/dead1.js', 'src/dead-child.js', 'src/fine.js']) {
    assert.equal(by[f].verify.passed, true, f)
    assert.equal(by[f].status, f === 'src/dead-child.js' ? 'dead-only-ref' : 'dead')
    assert.deepEqual(by[f].verify.test.newFailures, []) // 基线本来就失败的 old.test.js 不算
  }
  // 构建按文件名读取（报错里有路径）、测试在用（新失败的测试 import 了它）、报错看不出是谁（对半找）
  for (const f of ['src/secret.js', 'src/helper.js', 'src/mystery.js']) {
    assert.equal(by[f].verify.passed, false, f)
    assert.equal(by[f].status, 'unknown', f)
    assert.equal(by[f].evidence.at(-1).rule, 'verify-failed')
  }
  assert.match(by['src/helper.js'].evidence.at(-1).detail, /新增失败的测试 1 个/)
  assert.deepEqual(by['src/helper.js'].verify.test.newFailures, ['tests/helper.test.js > helper > works'])
  assert.match(by['src/secret.js'].evidence.at(-1).detail, /构建失败/)
  assert.equal(by['src/kept.js'].verify, null) // 不是 dead 的不验证
  assert.equal(by['src/kept.js'].status, 'external')
  assert.deepEqual([summary.targets, summary.passed, summary.failed, summary.unverified], [6, 3, 3, 0])
  assert.deepEqual(validate(data), [])
  assert.ok(logs.some((l) => /报错里认出/.test(l)))
})

test('verifyReport：重新验证时旧的结论作废，轮数用完没验证到的 verify 清空，不沿用上次的 passed', async (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const data = dataFor(repo)
  const stale = { rev: data.project.rev, build: { ok: true, newWarnings: ['上一次'] }, test: { newFailures: [] }, passed: true }
  for (const i of data.items) i.verify = structuredClone(stale)
  const { data: out, summary } = await verifyReport({ data, root: repo.root, config, maxRounds: 1 })
  assert.equal(summary.passed, 0)
  for (const i of out.items) {
    const old = i.verify?.build.newWarnings[0] === '上一次'
    if (i.status === 'external') assert.ok(old, '不验证的不动')
    else assert.ok(!old && i.verify?.passed !== true, i.target)
  }
  assert.ok(out.items.some((i) => i.verify === null))
  assert.deepEqual(validate(out), [])
})

test('verifyReport：基线构建就失败时报错；没有要验证的文件时不准备临时目录', async (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const broken = resolveConfig({ verify: { build: 'node -e "process.exit(1)"' } })
  await assert.rejects(verifyReport({ data: dataFor(repo), root: repo.root, config: broken }), /基线构建就失败了/)

  const none = dataFor(repo)
  none.items = none.items.filter((i) => i.status === 'external')
  const r = await verifyReport({ data: none, root: repo.root, config })
  assert.equal(r.summary.targets, 0)
})

test('verify 命令：--in --out 写出结果；输出不能在仓库里；--in 不能和 --rev、--keep 一起用', (t) => {
  const repo = projectRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-vf-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(join(dir, 'p.js'), "export default { verify: { build: 'node build.js', test: 'node test.js' } }\n")
  writeFileSync(join(dir, 'data.json'), JSON.stringify(dataFor(repo)))
  const args = ['verify', '--root', repo.root, '--profile', join(dir, 'p.js'), '--in', join(dir, 'data.json')]

  const inside = cli(...args, '--out', join(repo.root, 'out.json'))
  assert.equal(inside.status, 1)
  assert.match(inside.stderr, /输出位置在被分析的仓库里/)
  assert.match(cli(...args, '--rev', 'HEAD').stderr, /不能再传 --rev/)
  assert.match(cli(...args, '--keep').stderr, /--keep 只用于试跑基线/)

  const ok = cli(...args, '--out', join(dir, 'verified.json'))
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /删掉后和基线一致：3 个/)
  assert.match(ok.stderr, /删了会出问题（状态改为 unknown）：3 个/)
  const out = JSON.parse(readFileSync(join(dir, 'verified.json'), 'utf8'))
  assert.equal(out.items.find((i) => i.target === 'src/fine.js').verify.passed, true)
  assert.equal(existsSync(join(repo.root, 'out.json')), false)
})
