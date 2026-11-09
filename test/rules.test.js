import { test } from 'node:test'
import assert from 'node:assert/strict'
import { judge, NOT_JUDGED } from '../src/rules/index.js'

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

test('judge：不在范围里、范围确定不了、自己加载自己的，都不算命中', () => {
  const r = judge({
    files: [{ file: 'src/other.js', evidence: [knipEv] }, { file: 'src/v/self.js', evidence: [knipEv] }],
    loads: [load('src/a.js', 1, { ...views, dir: 'src/w' }), load('src/b.js', 1, null), load('src/v/self.js', 1, views)]
  })
  for (const x of r) {
    assert.equal(x.status, NOT_JUDGED.status)
    assert.deepEqual(x.evidence, [knipEv, NOT_JUDGED.evidence])
    assert.deepEqual(x.refs, [])
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
