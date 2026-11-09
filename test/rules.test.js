import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge, NO_REF } from '../src/rules/index.js'

const knipEv = { rule: 'knip-unreachable', detail: '从入口走不到' }
const load = (from, line, scope, expr = 'import(`./v/${x}`)') => ({ from, line, kind: 'import', expr, scope })
const views = { dir: 'src/v', recursive: true, prefix: '', suffix: '', regex: null }

test('judge：落在动态加载范围里的判为 unknown，证据和引用都记下', () => {
  const [r] = judge({ files: [{ file: 'src/v/a.vue', evidence: [knipEv] }], loads: [load('src/router.js', 3, views)] })
  assert.equal(r.status, 'unknown')
  assert.deepEqual(r.evidence[0], knipEv)
  assert.equal(r.evidence[1].rule, 'dynamic-load')
  assert.match(r.evidence[1].detail, /可能被 src\/router\.js:3 动态加载：import\(`\.\/v\/\$\{x\}`\)/)
  assert.deepEqual(r.refs, [{ from: 'src/router.js', line: 3, via: 'dynamic' }])
})

test('judge：被多处加载时每处一条证据、一条引用', () => {
  const [r] = judge({
    files: [{ file: 'src/v/a.vue', evidence: [knipEv] }],
    loads: [load('src/a.js', 1, views), load('src/b.js', 2, { ...views, suffix: '.vue' })]
  })
  assert.equal(r.evidence.length, 3)
  assert.deepEqual(r.refs.map((x) => x.from), ['src/a.js', 'src/b.js'])
})

test('judge：加载方本身也是候选时在证据里注明，状态仍是 unknown', () => {
  const r = judge({
    files: [{ file: 'src/v/a.vue', evidence: [knipEv] }, { file: 'src/loader.js', evidence: [knipEv] }],
    loads: [load('src/loader.js', 5, views)]
  })
  assert.equal(r[0].status, 'unknown')
  assert.match(r[0].evidence[1].detail, /src\/loader\.js 本身也从入口走不到/)
})

test('judge：不在范围里（含整个仓库的范围按结尾排除）、自己加载自己的，都不算命中，判为 dead 并写明原因', () => {
  const wideVue = { dir: '', wide: true, recursive: true, prefix: '', suffix: '.vue', regex: null }
  const r = judge({
    files: [{ file: 'src/other.js', evidence: [knipEv] }, { file: 'src/v/self.js', evidence: [knipEv] }],
    loads: [load('src/a.js', 1, { ...views, dir: 'src/w' }), load('src/b.js', 1, wideVue), load('src/v/self.js', 1, views)]
  })
  for (const x of r) {
    assert.equal(x.status, 'dead')
    assert.deepEqual(x.evidence, [knipEv, NO_REF])
    assert.deepEqual(x.refs, [])
  }
})

test('judge：确定不了目录的动态加载圈到的判 unknown，证据说明怎么缩小的、怎么放过', () => {
  const wide = { dir: '', wide: true, recursive: true, prefix: '', suffix: '', regex: null }
  const [a] = judge({ files: [{ file: 'src/a.js', evidence: [knipEv] }], loads: [load('src/util.js', 7, wide, 'import(p)')] })
  assert.equal(a.status, 'unknown')
  assert.match(a.evidence[1].detail, /src\/util\.js:7 动态加载：import\(p\)；路径的开头就是变量，确定不了目录，整个仓库都可能。人工确认.*reviewedDynamicLoads/)
  const [b] = judge({ files: [{ file: 'src/b.vue', evidence: [knipEv] }], loads: [load('src/util.js', 7, { ...wide, suffix: '.vue' })] })
  assert.match(b.evidence[1].detail, /只能按结尾 \.vue 圈/)
})

test('judge：人工确认过的动态加载不圈文件；范围里判为 dead / dead-only-ref 的写明确认的理由', () => {
  const wide = { dir: '', wide: true, recursive: true, prefix: '', suffix: '', regex: null }
  const reviewedLoads = [{ ...load('src/cdn.js', 3, wide, 'import(url)'), reason: '加载的是 CDN 脚本' }]
  const importers = new Map([['src/b.js', [{ from: 'src/a.js', line: 1 }]]])
  const r = judge({
    files: [{ file: 'src/a.js', evidence: [knipEv] }, { file: 'src/b.js', evidence: [knipEv] }],
    reviewedLoads,
    importers
  })
  assert.deepEqual(r.map((x) => x.status), ['dead', 'dead-only-ref'])
  for (const x of r) {
    assert.equal(x.evidence.at(-1).rule, 'reviewed-dynamic-load')
    assert.match(x.evidence.at(-1).detail, /在 src\/cdn\.js:3 的 import\(url\) 的范围里，已人工确认不加载本地源码：加载的是 CDN 脚本/)
  }
})

test('judge：不改动传入的证据', () => {
  const evidence = [knipEv]
  judge({ files: [{ file: 'src/x.js', evidence }], loads: [] })
  assert.deepEqual(evidence, [knipEv])
})

test('judge：命中多条规则时取优先级最高的状态，证据和引用都保留', () => {
  const ref = (from) => ({ from, line: 1, via: 'static' })
  const deadRule = () => ({ status: 'dead', evidence: [{ rule: 'r-dead', detail: 'd' }], refs: [ref('a.js')] })
  const dormantRule = () => ({ status: 'dormant', evidence: [{ rule: 'r-dormant', detail: 'd' }], refs: [ref('b.js')] })
  const [r] = judge({ files: [{ file: 'x.js', evidence: [knipEv] }], loads: [], rules: [deadRule, dormantRule] })
  assert.equal(r.status, 'dormant')
  assert.deepEqual(r.evidence.map((e) => e.rule), ['knip-unreachable', 'r-dead', 'r-dormant'])
  assert.deepEqual(r.refs.map((x) => x.from), ['a.js', 'b.js'])
})

test('judge：knip 不分析的文件里写着路径的判为 external；同时在动态加载范围里时 unknown 优先', () => {
  const externalRefs = new Map([
    ['src/v/a.vue', [{ from: 'vite.config.js', line: 4, text: "path.resolve('src/v/a.vue')" }]],
    ['src/stub.js', [{ from: 'vite.config.js', line: 9, text: "'src/stub.js'" }]]
  ])
  const [a, stub] = judge({
    files: [{ file: 'src/v/a.vue', evidence: [knipEv] }, { file: 'src/stub.js', evidence: [knipEv] }],
    loads: [load('src/router.js', 3, views)],
    externalRefs
  })
  assert.equal(stub.status, 'external')
  assert.match(stub.evidence[1].detail, /vite\.config\.js:9 写着它的路径：'src\/stub\.js'/)
  assert.deepEqual(stub.refs, [{ from: 'vite.config.js', line: 9, via: 'config' }])
  assert.equal(a.status, 'unknown')
  assert.deepEqual(a.evidence.map((e) => e.rule), ['knip-unreachable', 'dynamic-load', 'external-ref'])
  assert.deepEqual(a.refs.map((r) => r.via), ['dynamic', 'config'])
})

test('judge：在用的代码里有注释掉的引用判为 dormant；同时在构建配置里写着时 external 优先', () => {
  const commentRefs = new Map([
    ['src/a.js', [{ from: 'src/main.js', line: 84, text: "// import a from '@/a.js'" }]],
    ['src/b.js', [{ from: 'src/main.js', line: 85, text: "// import b from '@/b.js'" }]]
  ])
  const externalRefs = new Map([['src/b.js', [{ from: 'vite.config.js', line: 1, text: "'src/b.js'" }]]])
  const [a, b] = judge({
    files: [{ file: 'src/a.js', evidence: [knipEv] }, { file: 'src/b.js', evidence: [knipEv] }],
    loads: [],
    externalRefs,
    commentRefs
  })
  assert.equal(a.status, 'dormant')
  assert.match(a.evidence[1].detail, /src\/main\.js:84 有注释掉的引用：\/\/ import a from '@\/a\.js'/)
  assert.deepEqual(a.refs, [{ from: 'src/main.js', line: 84, via: 'comment' }])
  assert.equal(b.status, 'external')
  assert.deepEqual(b.evidence.map((e) => e.rule), ['knip-unreachable', 'external-ref', 'commented-ref'])
})

// ---------- test-only、dead-only-ref、顺着引用传递 ----------

const testEv = { rule: 'knip-test-only', detail: '只有测试用到' }

test('judge：knip 说只有测试用到的判为 test-only，列出直接引用它的测试', () => {
  const testRefs = new Map([['src/a.js', [{ from: 'tests/a.test.js', line: 2 }]]])
  const [a, b] = judge({ files: [{ file: 'src/a.js', evidence: [testEv] }, { file: 'src/b.js', evidence: [testEv] }], testRefs })
  assert.equal(a.status, 'test-only')
  assert.deepEqual(a.evidence.map((e) => e.detail), ['只有测试用到', '被测试 tests/a.test.js:2 引用'])
  assert.deepEqual(a.refs, [{ from: 'tests/a.test.js', line: 2, via: 'static' }])
  assert.equal(b.status, 'test-only') // 间接用到：只有 knip 的结论
  assert.deepEqual(b.refs, [])
})

test('judge：只被没人用的候选引用的判为 dead-only-ref；互相引用的一组也是', () => {
  const importers = new Map([
    ['src/child.js', [{ from: 'src/parent.js', line: 1 }]],
    ['src/p.js', [{ from: 'src/q.js', line: 3 }]],
    ['src/q.js', [{ from: 'src/p.js', line: 4 }]]
  ])
  const files = ['src/parent.js', 'src/child.js', 'src/p.js', 'src/q.js'].map((file) => ({ file, evidence: [knipEv] }))
  const r = Object.fromEntries(judge({ files, importers }).map((x) => [x.file, x]))
  assert.equal(r['src/parent.js'].status, 'dead')
  assert.equal(r['src/child.js'].status, 'dead-only-ref')
  assert.match(r['src/child.js'].evidence[1].detail, /只被同样从入口走不到的文件引用：src\/parent\.js:1/)
  assert.deepEqual(r['src/child.js'].refs, [{ from: 'src/parent.js', line: 1, via: 'static' }])
  assert.equal(r['src/p.js'].status, 'dead-only-ref')
  assert.equal(r['src/q.js'].status, 'dead-only-ref')
})

test('judge：引用方要保留时，被引用的跟着保留，证据写明跟着谁', () => {
  const externalRefs = new Map([['src/stub.js', [{ from: 'vite.config.js', line: 1, text: "'src/stub.js'" }]]])
  const commentRefs = new Map([['src/helper.js', [{ from: 'src/main.js', line: 9, text: "// import './helper.js'" }]]])
  const importers = new Map([
    ['src/helper.js', [{ from: 'src/stub.js', line: 2 }]],
    ['src/deep.js', [{ from: 'src/helper.js', line: 5 }]]
  ])
  const files = ['src/stub.js', 'src/helper.js', 'src/deep.js'].map((file) => ({ file, evidence: [knipEv] }))
  const r = Object.fromEntries(judge({ files, externalRefs, commentRefs, importers }).map((x) => [x.file, x]))

  // helper 自己是 dormant，引用方 stub 是 external：取更不敢删的 external
  assert.equal(r['src/helper.js'].status, 'external')
  assert.deepEqual(r['src/helper.js'].evidence.map((e) => e.rule), ['knip-unreachable', 'commented-ref', 'inherited'])
  assert.match(r['src/helper.js'].evidence[2].detail, /被 src\/stub\.js:2 引用，而 src\/stub\.js 是 external/)
  assert.equal(r['src/deep.js'].status, 'external')
  assert.match(r['src/deep.js'].evidence.at(-1).detail, /被 src\/helper\.js:5 引用/)
  // 自己命中的状态就是最不敢删的：不写「跟着谁」
  assert.equal(r['src/stub.js'].evidence.some((e) => e.rule === 'inherited'), false)
})
