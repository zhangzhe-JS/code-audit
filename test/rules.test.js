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
