import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/core/config.js'
import { scanExports } from '../src/exports/scan.js'
import { traceExportsHistory, validateExportsResult, exportsCsv, exportsMarkdown } from '../src/exports/report.js'
import { createRepo } from './helpers/repo.js'
import { applyBundlerExports, addBundlerEvidence } from '../src/exports/bundler.js'

/** 一个写法和常见 Vue 项目都不一样的 TS 项目：源码目录 app，入口 app/index.ts */
function setup(repo) {
  repo.write('package.json', JSON.stringify({ name: 'x', type: 'module' }))
  repo.write('vite.config.ts', "import { buildBanner } from './app/lib/build'\nexport default { banner: buildBanner() }\n")
  repo.write('app/index.ts', [
    "import { used, Color, Api } from './lib/kit'",
    "import { onlyThis } from './lib/barrel'",
    "import { start } from './lib/chain'",
    "// import { revived } from './lib/kit'",
    "// import { buildBanner } from './lib/build'",
    "import { loadPlugin } from './lib/loader'",
    "import { other } from './lib/build'",
    "import { setup } from './plugins/p1'",
    'console.log(used(), Color.Red, new Api(), onlyThis, start(), loadPlugin, other, setup)',
    'autoHelper()'
  ].join('\n'))
  repo.write('app/lib/kit.ts', [
    'export const used = () => helper()',
    'export function helper() { return 1 }', // internal：used 调用它
    'export enum Color { Red, Blue }',
    'export enum Unused { A }', // dead
    'export class Api {}',
    'export class OldApi {}', // dead
    'export const revived = 1', // dormant：入口里注释掉的引用
    'export const testedOnly = () => 2', // test-only
    'export const branchUse = () => 3', // pending
    'export type T = string' // 类型：不算
  ].join('\n'))
  repo.write('app/lib/barrel.ts', "export { used as onlyThis, helper as reHelper } from './kit'\n") // reHelper：没人用的转出
  repo.write('app/lib/chain.ts', [
    'export const start = () => a()',
    'export const a = () => 1', // internal
    'export const dropped = () => b()', // dead
    'export const b = () => 2' // dead-only-ref：只有 dropped 引用
  ].join('\n'))
  repo.write('app/lib/build.ts', 'export const buildBanner = () => "x"\nexport const other = 1\n') // buildBanner：external，vite 配置里 import
  repo.write('app/lib/loader.ts', "export const loadPlugin = (name: string) => import('../plugins/' + name)\n")
  repo.write('app/plugins/p1.ts', 'export const setup = () => 1\nexport const teardown = () => 0\n') // teardown：unknown，可能被动态加载后按名字取
  repo.write('app/lib/auto.ts', 'export const autoHelper = () => 1\nexport const autoUnused = () => 2\n')
  repo.write('app/auto-imports.d.ts', "export {}\ndeclare global {\n  const autoHelper: typeof import('./lib/auto')['autoHelper']\n  const autoUnused: typeof import('./lib/auto')['autoUnused']\n}\n")
  repo.write('tests/kit.test.ts', "import { testedOnly } from '../app/lib/kit'\ntestedOnly()\n")
}

test('scanExports：各种状态都判对，类型导出不算，自动导入用到的不算候选', () => {
  const repo = createRepo()
  try {
    setup(repo)
    repo.commit('init', { date: '2024-01-01' })
    // 没合并的分支：入口里引用 branchUse
    repo.run(['checkout', '-q', '-b', 'feature'])
    repo.write('app/index.ts', "import { branchUse } from './lib/kit'\nbranchUse()\n")
    repo.write('tests/branch.test.ts', "import { OldApi } from '../app/lib/kit'\nnew OldApi()\n") // 分支上的测试文件：不算 pending
    repo.write('app/lib/chain.ts', "export const start = () => a()\nexport const a = () => 1\nexport const dropped = () => b()\nexport const b = () => 2\nexport const late = () => dropped()\n") // 分支在同文件里新加了对 dropped 的调用
    repo.commit('feature uses branchUse', { date: '2024-02-01' })
    repo.run(['checkout', '-q', 'main'])
    const config = resolveConfig({ sourceRoots: ['app'], entries: ['app/index.ts'], testEntries: ['tests/**/*.test.ts'] })
    const r = scanExports({ root: repo.root, project: 'x', config })
    const status = Object.fromEntries(r.items.map((c) => [`${c.file}#${c.name}`, c.status]))
    assert.deepEqual(status, {
      'app/lib/auto.ts#autoUnused': 'dead',
      'app/lib/barrel.ts#reHelper': 'dead',
      'app/lib/build.ts#buildBanner': 'external',
      'app/lib/chain.ts#a': 'internal',
      'app/lib/chain.ts#b': 'dead-only-ref',
      'app/lib/chain.ts#dropped': 'pending',
      'app/lib/kit.ts#OldApi': 'dead',
      'app/lib/kit.ts#Unused': 'dead',
      'app/lib/kit.ts#branchUse': 'pending',
      'app/lib/kit.ts#helper': 'internal',
      'app/lib/kit.ts#revived': 'dormant',
      'app/lib/kit.ts#testedOnly': 'test-only',
      'app/plugins/p1.ts#teardown': 'unknown'
    })
    const get = (k) => r.items.find((c) => `${c.file}#${c.name}` === k)
    assert.match(get('app/lib/kit.ts#helper').evidence[0].detail, /used 调用它/)
    assert.match(get('app/lib/chain.ts#b').evidence[0].detail, /dropped/)
    assert.equal(get('app/lib/barrel.ts#reHelper').reexport.imported, 'helper')
    assert.match(get('app/lib/auto.ts#autoUnused').evidence.map((e) => e.detail).join(), /自动导入的声明文件里登记了它/)
    assert.equal(get('app/lib/kit.ts#Unused').line, 4)
    assert.equal(get('app/lib/build.ts#buildBanner').evidence.filter((e) => /注释掉的引用|import 了它/.test(e.detail)).length, 2, '图外在用、注释停用都记下，状态取优先级高的 external')
    assert.deepEqual(validateExportsResult(r), [])
  } finally {
    repo.cleanup()
  }
})

test('traceExportsHistory：失去外部引用的提交；从没被引用的记定义提交；报告和校验', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'h', type: 'module' }))
    repo.write('src/main.js', "import { keep, gone } from './lib.js'\nkeep(); gone()\n")
    repo.write('src/lib.js', 'export const keep = () => 1\nexport const gone = () => 2\nexport const never = () => 3\n')
    repo.commit('init', { date: '2024-01-01' })
    repo.write('src/main.js', "import { keep } from './lib.js'\nkeep()\n")
    const stop = repo.commit('stop using gone', { date: '2024-02-01' })
    const config = resolveConfig({ entries: ['src/main.js'] })
    const r = scanExports({ root: repo.root, project: 'h', config })
    traceExportsHistory({ root: repo.root, result: r, config })
    const get = (n) => r.items.find((c) => c.name === n)
    assert.equal(get('gone').history.commit.hash, stop)
    assert.equal(get('never').history.type, 'never')
    assert.deepEqual(validateExportsResult(r), [])
    assert.ok(exportsCsv(r).startsWith('﻿状态,建议,文件,行,导出名'))
    assert.match(exportsMarkdown(r), /\| 没人用（dead） \| 2 \|/)
    const broken = structuredClone(r)
    broken.items[0].evidence = []
    broken.summary.candidates = 9
    const errs = validateExportsResult(broken).join('\n')
    assert.match(errs, /evidence 必须是非空/)
    assert.match(errs, /summary.candidates/)
    assert.match(exportsMarkdown({ ...r, summary: { ...r.summary, testEntries: false } }), /没写 testEntries/)
  } finally {
    repo.cleanup()
  }
})


test('applyBundlerExports：构建保留了的 dead / test-only 改判 unknown；摇掉了的只记佐证；internal 不比较；没加载的文件记佐证', () => {
  const item = (file, name, status) => ({ file, name, status, evidence: [{ rule: 'x', detail: 'x' }] })
  const result = { summary: { byStatus: {} }, items: [
    item('src/a.js', 'kept', 'dead'),
    item('src/a.js', 'shaken', 'dead'),
    item('src/a.js', 'inner', 'internal'),
    item('src/a.js', 'tested', 'test-only'),
    item('src/gone.js', 'x', 'dead')
  ] }
  const r = applyBundlerExports(result, {
    modules: new Set(['src/a.js']),
    exports: new Map([['src/a.js', { rendered: new Set(['kept', 'inner', 'tested']), removed: new Set(['shaken']) }]])
  })
  const s = Object.fromEntries(result.items.map((c) => [`${c.file}#${c.name}`, c.status]))
  assert.deepEqual(s, { 'src/a.js#kept': 'unknown', 'src/a.js#shaken': 'dead', 'src/a.js#inner': 'internal', 'src/a.js#tested': 'unknown', 'src/gone.js#x': 'dead' })
  assert.equal(r.raised, 2)
  assert.match(result.items[1].evidence.at(-1).detail, /摇掉了/)
  assert.match(result.items[4].evidence.at(-1).detail, /没有加载这个文件/)
  assert.deepEqual(result.summary.byStatus, { unknown: 2, dead: 2, internal: 1 })
})

test('addBundlerEvidence：profile 没写 verify.build / bundler 时说清楚要写什么', async () => {
  await assert.rejects(addBundlerEvidence({ root: '/x', result: { project: { rev: 'x' } }, config: resolveConfig({}) }), /verify 里写上 build/)
})
