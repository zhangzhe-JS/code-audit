import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findKnip } from '../src/collect/knip.js'
import { parseTemplate, flattenCall, matchTemplate } from '../src/api/template.js'
import { normalizePath, endpointKey, mayHit } from '../src/api/normalize.js'
import { evaluateUrl } from '../src/api/evaluate.js'
import { extractFile, loadParser, looksLikeApiPath, MODULE, TEMPLATE } from '../src/api/extract.js'
import { validateApiConfig, compileCalls } from '../src/api/rules.js'
import { scanApi, usedBindings } from '../src/api/scan.js'
import { resolveConfig } from '../src/core/config.js'
import { createRepo } from './helpers/repo.js'
import { buildApiReport, toCsv, toMarkdown, validateApiResult } from '../src/api/report.js'
import { findDefined, traceDefinition, summarizeHistory, commitOrder } from '../src/api/history.js'

const parser = loadParser(findKnip().dir)
const firstCall = (code) => {
  const program = parser.parseSync('a.ts', code, { lang: 'ts' }).program
  let found = null
  const visit = (n) => {
    if (found || !n || typeof n.type !== 'string') return
    if (n.type === 'CallExpression') {
      found = n
      return
    }
    for (const k of parser.visitorKeys[n.type] ?? []) {
      const c = n[k]
      if (Array.isArray(c)) c.forEach(visit)
      else if (c && typeof c === 'object') visit(c)
    }
  }
  visit(program)
  return found
}
const noScope = { consts: new Map(), params: new Set() }

/** 测试用：给手写的结果补上和清单一致的汇总，定义没写 state 的按接口状态补上 */
const finalize = (r) => {
  const byStatus = {}
  for (const e of r.endpoints) {
    byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
    for (const d of e.definitions) d.state ??= e.status === 'sdk' ? 'dead' : e.status
  }
  return { ...r, summary: { endpoints: r.endpoints.length, byStatus } }
}

// ---------- 模板 ----------

test('parseTemplate：几种写法都能解析，写错时报出原因', () => {
  assert.equal(parseTemplate('request({url, method})').length, 2)
  assert.equal(parseTemplate('client(_)(url, ...).*()').length, 5)
  assert.throws(() => parseTemplate('request(url, url)'), /恰好有一个 url/)
  assert.throws(() => parseTemplate('request(id)'), /参数只能是/)
  assert.throws(() => parseTemplate('api.get'), /最后必须是一次调用/)
  assert.throws(() => parseTemplate('*.get(url)'), /开头不能是 \*/)
  assert.throws(() => parseTemplate('a.*(url, method)'), /方法只能从一个地方取/)
})

test('matchTemplate：对象参数、成员方法、链式调用；长度或名字不同的不匹配', () => {
  const m1 = matchTemplate(parseTemplate('request({url, method})'), flattenCall(firstCall("request({ url: '/a', method: 'post', data })")))
  assert.equal(m1.url.value, '/a')
  assert.equal(m1.method.value, 'post')
  const m2 = matchTemplate(parseTemplate('http.*(url, ...)'), flattenCall(firstCall("http.delete('/a/' + id, { x: 1 })")))
  assert.equal(m2.method, 'DELETE')
  const chain = firstCall("client('M')('/x', {}).post()")
  assert.ok(matchTemplate(parseTemplate('client(_)(url, ...).*()'), flattenCall(chain)))
  assert.equal(matchTemplate(parseTemplate('http.*(url)'), flattenCall(firstCall("http.use('/a')"))), null, 'use 不是 HTTP 方法')
  assert.equal(matchTemplate(parseTemplate('get(url)'), flattenCall(firstCall("get('/a', 1)"))), null, '没写 ... 时参数个数要一致')
  assert.equal(matchTemplate(parseTemplate('request({url})'), flattenCall(firstCall('request(config)'))), null, '参数不是对象')
})

// ---------- 归一化 ----------

test('normalizePath：查询参数、开头的变量、前缀、首尾 /、路径参数', () => {
  assert.equal(normalizePath('/order/list?page=1'), '/order/list')
  assert.equal(normalizePath('order/detail'), '/order/detail')
  assert.equal(normalizePath('{}/files/scan/{}'), '/files/scan/{}')
  assert.equal(normalizePath('/channel/metas/?code={}'), '/channel/metas')
  assert.equal(normalizePath('/api/document/upload', { prefixes: ['/api'] }), '/document/upload')
  assert.equal(normalizePath('/apis/x', { prefixes: ['/api'] }), '/apis/x', '前缀只按整段匹配')
  assert.equal(normalizePath('/template/{}{}/detail{}'), '/template/{}/detail{}')
  assert.equal(normalizePath('https://Host:8080/a/b?c'), '//host:8080/a/b', '完整网址保留主机，不和自家后端的 /a/b 混在一起')
  assert.equal(normalizePath('https://host/api/x', { prefixes: ['/api'] }), '//host/api/x', '别人家的地址不去前缀')
  assert.equal(normalizePath('{}'), null)
  assert.equal(normalizePath('/{}/{}'), null)
  assert.equal(endpointKey('post', '/a'), 'POST /a')
})

// ---------- 求值 ----------

test('evaluateUrl：模板字符串、拼接、常量、常量对象、三元；整个是参数时记下参数名', () => {
  const consts = new Map()
  const program = parser.parseSync('a.ts', "const BASE = '/api/x'; const API = { list: BASE + '/list', n: { d: `${BASE}/d` } }", { lang: 'ts' }).program
  for (const st of program.body) for (const d of st.declarations) consts.set(d.id.name, d.init)
  const scope = { consts, params: new Set(['id', 'url']) }
  const ev = (code) => evaluateUrl(firstCall(`f(${code})`).arguments[0], scope)
  assert.equal(ev('`/a/${id}/b?x=${id}`').value, '/a/{}/b?x={}')
  assert.equal(ev("BASE + '/' + id").value, '/api/x/{}')
  assert.equal(ev('API.list').value, '/api/x/list')
  assert.equal(ev('API.n.d').value, '/api/x/d')
  assert.deepEqual(ev("id ? '/a?x=1' : '/a'").values, ['/a?x=1', '/a'])
  assert.deepEqual(ev("id ? '/a' : '/b'").values, ['/a', '/b'])
  assert.deepEqual(ev("'/m/' + (id ? 'b' : 'c') + '/list'").values, ['/m/b/list', '/m/c/list'], '三元列出每种可能，不合并成 {}')
  const partial = ev("pick || '/fallback'")
  assert.deepEqual([partial.values, partial.partial], [['/fallback'], true])
  const many = ev("(a ? 'a' : 'b') + (c ? 'c' : 'd') + (e ? 'e' : 'f') + (g ? 'g' : 'h')")
  assert.equal(many.value, null, '超过上限当成算不出')
  assert.deepEqual(ev('url'), { value: null, values: [], partial: false, fromParam: 'url' })
  assert.equal(ev('getUrl()').value, null)
})

test('looksLikeApiPath：接口路径算，本地文件、资源、MIME、句子不算', () => {
  for (const s of ['/a', '/a/b', 'user/password', '/x/{}']) assert.ok(looksLikeApiPath(s), s)
  for (const s of ['./a', '@/views/a', '/a.png', 'image/png', 'hello world', '/', 'abc']) assert.ok(!looksLikeApiPath(s), s)
})

// ---------- 单文件 ----------

const rules = (api) => compileCalls({ version: 1, ...api })

test('extractFile：定义所在的顶层名字、导出、同文件引用；局部常量；封装函数；疑似请求', () => {
  const content = [
    "import request from '@/utils/request'",
    "import { other } from './other'",
    "const BASE = '/m'",
    'function helper(id) {',
    "  const url = BASE + '/h/' + id",
    "  return request({ url, method: 'delete' })",
    '}',
    'export function getA(id) {',
    '  return helper(id)',
    '}',
    "export const getB = () => request({ url: '/m/b' })",
    'export function wrap(url) {',
    "  return request({ url, method: 'post' })",
    '}',
    "export const up = () => postFile('/m/upload')",
    "router.push('/m/page')",
    "const created = request({ url: '/m/init' })",
    'export default { other }'
  ].join('\n')
  const r = extractFile({ parser, path: 'src/api/a.js', content, calls: rules({ calls: [{ call: 'request({url, method})', defaultMethod: 'GET' }] }) })
  const sites = r.sites.map((s) => [s.line, s.owners.join(','), s.method, s.path, s.fromParam])
  assert.deepEqual(sites, [
    [6, 'helper', 'DELETE', '/m/h/{}', null],
    [11, 'getB', 'GET', '/m/b', null],
    [13, 'wrap', 'POST', null, 'url'],
    [17, `created,${MODULE}`, 'GET', '/m/init', null]
  ])
  assert.deepEqual([...r.bindings.get('getA').refs], ['helper'])
  assert.deepEqual([...r.bindings.get('getA').exported], ['getA'])
  assert.equal(r.bindings.get('helper').exported.size, 0)
  assert.deepEqual(r.suspects.map((s) => [s.line, s.shape, s.text]), [[15, 'postFile()', '/m/upload']], 'router.push 默认不算')
  assert.deepEqual([...r.importUses.get('other')], ['default'])
})

test('extractFile：模板里的上传地址（占位的 #、空字符串不算）、地址常量、导入成员和组件标签的引用', () => {
  const content = [
    '<template>',
    '  <div>',
    '    <el-upload action="/api/up" />',
    '    <el-upload action="#" />',
    '    <el-upload :action="`/api/up2/${id}`" />',
    '    <LoginPanel />',
    '  </div>',
    '</template>',
    '<script setup lang="ts">',
    "import { LoginPanel, other } from '@x/login'",
    "export const UPLOAD = '/api/const-up'",
    'function open() { LoginPanel.showModal() }',
    '</script>'
  ].join('\n')
  const r = extractFile({
    parser,
    path: 'src/A.vue',
    content,
    calls: rules({ calls: [{ call: 'request(url)', method: 'GET' }] }),
    attrs: [{ tag: 'el-upload', attr: 'action', method: 'POST' }],
    prefixes: ['/api'],
    consts: [{ name: 'UPLOAD', method: 'POST' }]
  })
  assert.deepEqual(r.sites.map((s) => [s.line, s.owners[0], s.method, s.path]).sort(), [
    [11, 'UPLOAD', 'POST', '/const-up'],
    [3, TEMPLATE, 'POST', '/up'],
    [5, TEMPLATE, 'POST', '/up2/{}']
  ].sort())
  assert.deepEqual([...r.importUses.get('LoginPanel')].sort(), ['open', TEMPLATE].sort())
  assert.deepEqual([...r.importUses.get('LoginPanel.showModal')], ['open'])
  assert.equal(r.importUses.get('other'), undefined)
})

test('usedBindings：导出被用到的、模块顶层、顺着同文件引用传递；组件的 default 文件走得到就算', () => {
  const p = {
    path: 'src/a.js',
    bindings: new Map([
      ['getA', { exported: new Set(['getA']), refs: new Set(['helper']) }],
      ['helper', { exported: new Set(), refs: new Set() }],
      ['getB', { exported: new Set(['getB']), refs: new Set() }],
      ['lonely', { exported: new Set(), refs: new Set() }]
    ])
  }
  const used = usedBindings(p, new Set(['getB']))
  assert.ok(used.has('getA') && used.has('helper') && used.has(MODULE))
  assert.ok(!used.has('getB') && !used.has('lonely'))
  const sfc = usedBindings({ ...p, path: 'src/A.vue' }, new Set(['getB']))
  assert.ok(sfc.has('lonely') && sfc.has('getB'), '组件里的顶层名字模板可以直接用：都算在用')
})

// ---------- 规则校验 ----------

test('validateApiConfig：字段、模板、方法、例子都校验；例子对不上会报出实际结果', () => {
  assert.deepEqual(validateApiConfig({ version: 1, calls: [{ call: 'request({url, method})' }] }), [])
  const errs = validateApiConfig({
    version: 0,
    calls: [{ call: 'get(url)' }, { call: 'a.*(url)', method: 'GET' }, { call: 'x(' }],
    sdk: [{ method: 'post', path: 'login', package: '' }],
    typo: 1
  })
  const text = errs.join('\n')
  for (const s of ['不认识的字段：typo', 'api.version', '要写 method', '不要再写 method', '括号没有闭合', '大写的 HTTP 方法', 'path 必须是归一化后的路径', 'package']) {
    assert.ok(text.includes(s), `应包含：${s}\n${text}`)
  }
  const ex = validateApiConfig({ version: 1, calls: [{ call: 'get(url)', method: 'GET' }], examples: [{ raw: '/a/?x=1', expect: 'GET /a/' }] })
  assert.match(ex.join('\n'), /归一化后是 GET \/a，规则里写的是 GET \/a\//)
  assert.throws(() => resolveConfig({ api: { version: 1, calls: [] } }), /api.calls 必须是非空数组/)
})

// ---------- 整体 ----------

test('scanApi：在用 / 没人用 / 文件走不到 / 本文件内部在用 / SDK；覆盖报告；不改目标仓库', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'demo', type: 'module', dependencies: { '@x/login': '1.0.0' } }))
    repo.write('src/main.js', [
      "import { getA, makeAuth, viaWrap } from './api/a.js'",
      "import { createAuth } from '@x/login'",
      'getA(1)',
      'viaWrap()',
      'makeAuth()',
      'export const auth = createAuth()'
    ].join('\n'))
    repo.write('src/utils/request.js', 'export default function request(config) { return fetch(config.url) }\n')
    repo.write('src/api/a.js', [
      "import request from '../utils/request.js'",
      "import { createToken } from '@x/login'",
      "function helper(id) { return request({ url: `/a/${id}`, method: 'get' }) }",
      'export function getA(id) { return helper(id) }',
      "export function getB() { return request({ url: '/b', method: 'post' }) }",
      "export function dyn(u) { return request({ url: u + suffix() }) }",
      'export function makeAuth() { return 1 }',
      'export const tokenFn = createToken()',
      'const tokenFn2 = createToken()',
      'export function wrap(url) { return request({ url }) }',
      "export function viaWrap() { return wrap('/w') }",
      "export function guess() { return postFile('/c/upload') }"
    ].join('\n'))
    repo.write('src/api/old.js', "import request from '../utils/request.js'\nexport const oldOne = () => request({ url: '/old' })\n")
    repo.commit('init')
    const before = repo.run(['status', '--porcelain'])
    const config = resolveConfig({
      entries: ['src/main.js'],
      api: {
        version: 1,
        calls: [{ call: 'request({url, method})', defaultMethod: 'GET' }, { call: 'wrap(url)', method: 'GET' }],
        sdk: [
          { method: 'POST', path: '/login', package: '@x/login', via: ['createAuth'] },
          { method: 'POST', path: '/token/refresh', package: '@x/login', via: ['createToken'] }
        ]
      }
    })
    const r = scanApi({ root: repo.root, project: 'demo', config })
    const status = Object.fromEntries(r.endpoints.map((e) => [e.key, e.status]))
    assert.deepEqual(status, {
      'GET /a/{}': 'live',
      'POST /b': 'dead',
      'POST /login': 'live',
      'GET /old': 'dead',
      'GET /w': 'live',
      'POST /token/refresh': 'sdk'
    })
    const a = r.endpoints.find((e) => e.key === 'GET /a/{}')
    assert.match(a.evidence[0].detail, /helper 在用/)
    assert.deepEqual(a.callers, [], 'helper 没有被别的文件 import')
    assert.deepEqual(r.endpoints.find((e) => e.key === 'POST /login').sdk.refs.map((x) => x.name), ['createAuth'])
    assert.match(r.endpoints.find((e) => e.key === 'GET /old').evidence[0].detail, /src\/api\/old.js 判为 dead/)
    assert.deepEqual(r.coverage.dynamic.map((d) => d.fn), ['dyn'], 'wrap 自己的实现不列为算不出地址')
    assert.deepEqual(r.coverage.wrappers, [])
    assert.deepEqual(r.coverage.suspects.map((s) => s.text), ['/c/upload'])
    assert.equal(r.rules.version, 1)
    assert.equal(repo.run(['status', '--porcelain']), before)
  } finally {
    repo.cleanup()
  }
})

// ---------- 汇总报告 ----------


test('buildApiReport：跨项目合并；在用 > SDK 保留 > 高风险 > 需审核 > 可删；CSV 带 BOM、转义', () => {
  const commit = { hash: 'a'.repeat(40), date: '2026-01-02', author: 'bob', subject: 'remove "x", y' }
  const ep = (key, status, extra = {}) => ({ key, method: key.split(' ')[0], path: key.split(' ')[1], status, evidence: [{ rule: 'r', detail: 'd' }], definitions: [{ file: 'src/a.js', line: 1, fn: 'f' }], callers: [], ...extra })
  const r1 = { kind: 'api', version: 1, project: { name: 'p1', rev: 'b'.repeat(40) }, rules: { version: 1 }, historyTraced: true, coverage: {}, endpoints: [
    ep('GET /used', 'dead', { history: { type: 'lost', commit, from: 'src/x.vue' } }),
    ep('GET /a', 'dead', { history: { type: 'lost', commit, from: 'src/x.vue' } }),
    ep('GET /weak', 'dead', { history: { type: 'lost', commit, from: 'src/x.vue', weak: true } }),
    ep('GET /never', 'dead', { history: { type: 'never', introduced: commit } }),
    ep('POST /sys/x', 'sdk', { sdk: { package: '@x/sdk' }, definitions: [] }),
    ep('GET /branch', 'pending')
  ] }
  const r2 = { kind: 'api', version: 1, project: { name: 'p2', rev: 'c'.repeat(40) }, rules: { version: 2 }, historyTraced: false, coverage: {}, endpoints: [
    ep('GET /used', 'live', { callers: [{ from: 'src/page.vue' }] }),
    ep('GET /p2only', 'dead')
  ] }
  const report = buildApiReport([finalize(r1), finalize(r2)])
  const v = Object.fromEntries(report.rows.map((r) => [r.key, r.verdict]))
  assert.deepEqual(v, {
    'GET /used': '在用',
    'POST /sys/x': 'C 保留',
    'GET /branch': 'C 高风险',
    'GET /weak': 'B 需审核',
    'GET /p2only': 'B 需审核',
    'GET /a': 'A 可删',
    'GET /never': 'A 可删'
  })
  assert.match(report.rows.find((r) => r.key === 'GET /p2only').reasons.join(), /没有查历史/)
  assert.deepEqual(report.rows.find((r) => r.key === 'GET /used').callers, ['p2:src/page.vue'])
  const withGap = buildApiReport([finalize({ ...r1, coverage: { suspects: [{}] } })])
  assert.equal(withGap.rows.find((r) => r.key === 'GET /a').verdict, 'B 需审核', '覆盖报告有没补的规则时降为需审核')
  const csv = toCsv(report)
  assert.ok(csv.startsWith('﻿结论,方法,路径,p1,p2,'))
  assert.ok(csv.includes('"""x"", y') || csv.includes('remove ""x"", y'))
  assert.match(toMarkdown(report), /\| A 可删 \| 2 \|/)
  assert.throws(() => buildApiReport([finalize(r1), finalize(r1)]), /项目重复/)
})

test('scanApi：换一套完全不同的写法（TS、api.* 客户端、Svelte、a-upload、/gateway 前缀），只改规则就能用；没写规则的写法出现在覆盖报告里', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'other-style', type: 'module', dependencies: { vue: '3.0.0', svelte: '4.0.0' } }))
    repo.write('app/main.ts', [
      "import { listOrders, removeOrder } from './services/order'",
      "import Panel from './views/Panel.vue'",
      "import Upload from './views/Upload.svelte'",
      'listOrders(); removeOrder(1); console.log(Panel, Upload)'
    ].join('\n'))
    repo.write('app/services/http.ts', 'export const api = { get: (u: string) => fetch(u), delete: (u: string) => fetch(u) }\nexport const sendJson = (u: string, o: object) => fetch(u, o)\n')
    repo.write('app/services/order.ts', [
      "import { api, sendJson } from './http'",
      "const ORDER = '/gateway/order'",
      'export const listOrders = () => api.get(`${ORDER}/list?page=1`)',
      'export const removeOrder = (id: number) => api.delete(`${ORDER}/${id}`)',
      "export const archive = (id: number) => sendJson(ORDER + '/archive/' + id, { method: 'PUT' })",
      "export const unruled = () => legacyGet('/gateway/legacy/report')",
      "export const viaOther = () => client.get('/gateway/other/list')"
    ].join('\n'))
    repo.write('app/views/Panel.vue', '<template><a-upload action="/gateway/files/upload" /></template>\n<script setup lang="ts">\nconst x = 1\n</script>\n')
    repo.write('app/views/Upload.svelte', "<script lang=\"ts\">\nimport { sendJson } from '../services/http'\nconst save = () => sendJson('/gateway/profile', { method: 'POST' })\n</script>\n<button on:click={save}>save</button>\n")
    repo.commit('init')
    const config = resolveConfig({
      sourceRoots: ['app'],
      entries: ['app/main.ts'],
      api: {
        version: 1,
        calls: [{ call: 'api.*(url)' }, { call: 'sendJson(url, {method})', defaultMethod: 'GET' }],
        attrs: [{ tag: 'a-upload', attr: 'action', method: 'POST' }],
        prefixes: ['/gateway']
      }
    })
    const r = scanApi({ root: repo.root, project: 'other-style', config })
    assert.deepEqual(Object.fromEntries(r.endpoints.map((e) => [e.key, e.status])), {
      'POST /files/upload': 'live',
      'GET /order/list': 'live',
      'DELETE /order/{}': 'live',
      'PUT /order/archive/{}': 'dead',
      'POST /profile': 'live' // Svelte 模板里 on:click={save} 用到：组件的顶层名字都算在用
    })
    assert.deepEqual(r.coverage.suspects.map((s) => [s.shape, s.text]), [
      ['legacyGet()', '/gateway/legacy/report'],
      ['client.get()', '/gateway/other/list'] // 没写规则的 xxx.get 也要报出来，不能默认忽略
    ])
    assert.deepEqual(r.coverage.parseErrors, [])
  } finally {
    repo.cleanup()
  }
})

test('extractFile：局部常量按作用域查找——内层同名的不覆盖外层；let、循环变量、参数会遮住外层常量', () => {
  const content = [
    "const path = '/top'",
    'export function outer(list) {',
    "  const path = '/outer'",
    '  list.forEach(() => {',
    "    const path = '/inner'",
    '    request({ url: path })',
    '  })',
    '  request({ url: path })',
    '  if (list) {',
    "    let path = pick()",
    '    request({ url: path })',
    '  }',
    '  for (const path of list) request({ url: path })',
    '  return (path) => request({ url: path })',
    '}',
    'export const topLevel = () => request({ url: path })'
  ].join('\n')
  const r = extractFile({ parser, path: 'src/a.js', content, calls: rules({ calls: [{ call: 'request({url})', method: 'GET' }] }) })
  assert.deepEqual(r.sites.map((s) => [s.line, s.path, s.fromParam]), [
    [6, '/inner', null],
    [8, '/outer', null],
    [11, null, null],
    [13, null, null],
    [14, null, 'path'],
    [16, '/top', null]
  ])
})

test('findDefined：按整个名字找定义提交，不被 getUser 这类更长的名字提前匹配', () => {
  const repo = createRepo()
  try {
    repo.write('src/api.js', 'export function getUser() {}\n')
    repo.commit('add getUser', { date: '2024-01-01' })
    repo.write('src/api.js', 'export function getUser() {}\nexport function get() {}\n')
    const second = repo.commit('add get', { date: '2024-02-01' })
    assert.equal(findDefined(repo.root, 'HEAD', 'src/api.js', 'get').hash, second)
    assert.equal(findDefined(repo.root, 'HEAD', 'src/api.js', 'getUser').subject, 'add getUser')
    assert.equal(findDefined(repo.root, 'HEAD', 'src/api.js', 'nothing'), null)
  } finally {
    repo.cleanup()
  }
})

test('validateApiResult：手工改坏的结果给出明确的格式错误，不在生成报告时抛运行时异常', () => {
  const ok = finalize({ kind: 'api', version: 1, project: { name: 'p', rev: 'x' }, rules: { version: 1 }, historyTraced: true, coverage: {}, endpoints: [
    { key: 'GET /a', method: 'GET', path: '/a', status: 'dead', evidence: [{ detail: 'd' }], definitions: [{ file: 'a.js', line: 1, fn: 'f' }], callers: [], history: { type: 'never', introduced: { hash: 'h', date: '2024-01-01', author: 'a', subject: 's' } } }
  ] })
  assert.deepEqual(validateApiResult(ok), [])
  assert.deepEqual(validateApiResult(null), ['不是 JSON 对象'])
  const broken = structuredClone(ok)
  broken.version = 0
  broken.coverage.suspects = 'x'
  broken.endpoints.push({ key: 'GET /b', method: 'POST', path: '/b', status: 'gone', evidence: 'x', definitions: [{ file: 'b.js' }], history: { type: 'lost' } })
  const text = validateApiResult(broken).join('\n')
  for (const s of ['version 必须是 1', 'coverage.suspects 必须是数组', 'key 和 method、path 对不上', 'status 不认识', 'evidence 必须是', 'definitions 必须是', 'callers 必须是', 'history（lost）必须有 commit']) {
    assert.ok(text.includes(s), `应包含：${s}\n${text}`)
  }
  assert.throws(() => buildApiReport([ok, { ...broken, project: { name: 'q', rev: 'y' } }], ['a.json', 'b.json']), /输入的结果格式不对，没有生成报告：\nb\.json：/)
  assert.throws(() => buildApiReport([{ endpoints: [{}] }]), /kind 必须是 "api"/)
})

test('mayHit：一段里既有文字又有变量的可能命中固定路径；整段 {} 按路径参数算，不命中', () => {
  assert.ok(mayHit('/report/export{}', '/report/exportExcel'))
  assert.ok(mayHit('/v{}/user', '/v2/user'))
  assert.ok(!mayHit('/template/{}', '/template/list'), '和后端路由一致：/template/{id} 和 /template/list 是两个接口')
  assert.ok(!mayHit('/report/export{}', '/report/import'))
  assert.ok(!mayHit('/a/b{}', '/a/b{}'))
  assert.ok(!mayHit('/v{}/{}', '/v2/list'), '混着时整段 {} 那段仍按路径参数算')
  assert.ok(mayHit('/v{}/{}', '/v2/{}'))
})

test('extractFile：三元的地址、方法都展开成多处定义；方法是变量时记为算不出；部分算不出的另记一条', () => {
  const content = [
    "export const a = (x) => request({ url: '/m/' + (x ? 'b' : 'c'), method: 'get' })",
    "export const b = (edit) => request({ url: '/m/save', method: edit ? 'put' : 'post' })",
    "export const c = (m) => request({ url: '/m/any', method: m })",
    "export const d = (u) => request({ url: u || '/m/default' })"
  ].join('\n')
  const r = extractFile({ parser, path: 'src/a.js', content, calls: rules({ calls: [{ call: 'request({url, method})', defaultMethod: 'GET' }] }) })
  assert.deepEqual(r.sites.map((s) => [s.owners[0], s.method, s.path, Boolean(s.partial)]), [
    ['a', 'GET', '/m/b', false],
    ['a', 'GET', '/m/c', false],
    ['b', 'PUT', '/m/save', false],
    ['b', 'POST', '/m/save', false],
    ['c', null, '/m/any', false],
    ['d', 'GET', '/m/default', false],
    ['d', 'GET', null, true]
  ])
})

test('extractFile：Svelte 的 attr={...}；属性值里有 > 时不截断标签', () => {
  const svelte = extractFile({ parser, path: 'src/U.svelte', content: '<script>\nconst x = 1\n</script>\n<Upload action={"/api/up"} />\n', calls: rules({ calls: [{ call: 'request(url)', method: 'GET' }] }), attrs: [{ tag: 'Upload', attr: 'action', method: 'POST' }], prefixes: ['/api'] })
  assert.deepEqual(svelte.sites.map((s) => [s.line, s.path]), [[4, '/up']])
  const vue = extractFile({ parser, path: 'src/V.vue', content: '<template>\n  <el-upload :on-change="f => g(f)" action="/api/up2" />\n</template>\n', calls: rules({ calls: [{ call: 'request(url)', method: 'GET' }] }), attrs: [{ tag: 'el-upload', attr: 'action', method: 'POST' }], prefixes: ['/api'] })
  assert.deepEqual(vue.sites.map((s) => s.path), ['/up2'])
})

test('scanApi：方法算不出的在用调用、拼了变量的在用路径，会让同路径没人用的接口改判 unknown；完整网址单独成一个接口', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'g', type: 'module' }))
    repo.write('src/main.js', "import { save, exportAs, cdn } from './api.js'\nsave('x'); exportAs('Excel'); cdn()\n")
    repo.write('src/api.js', [
      "export const save = (m) => request({ url: '/order/save', method: m })",
      "export const oldSave = () => request({ url: '/order/save', method: 'put' })",
      "export const exportAs = (t) => request({ url: '/report/export' + t })",
      "export const oldExport = () => request({ url: '/report/exportExcel' })",
      "export const cdn = () => request({ url: 'https://cdn.example.com/order/list' })",
      "export const oldCdn = () => request({ url: 'https://cdn.example.com/old' })",
      "export const oldList = () => request({ url: '/order/list' })"
    ].join('\n'))
    repo.commit('i')
    const r = scanApi({ root: repo.root, project: 'g', config: resolveConfig({ entries: ['src/main.js'], api: { version: 1, calls: [{ call: 'request({url, method})', defaultMethod: 'GET' }] } }) })
    assert.deepEqual(Object.fromEntries(r.endpoints.map((e) => [e.key, e.status])), {
      'GET //cdn.example.com/order/list': 'live',
      'GET //cdn.example.com/old': 'external',
      'GET /order/list': 'dead',
      'PUT /order/save': 'unknown',
      'GET /report/export{}': 'live',
      'GET /report/exportExcel': 'unknown'
    })
    assert.deepEqual(r.coverage.unknownMethod.map((u) => [u.fn, u.path]), [['save', '/order/save']])
    assert.match(r.endpoints.find((e) => e.key === 'GET /report/exportExcel').evidence[0].detail, /拼了变量/)
  } finally {
    repo.cleanup()
  }
})

test('traceDefinition：同一个文件里删掉的调用算失去引用；只改了调用（还在）不算；看到上限还没找到的不判从没被调用', () => {
  const repo = createRepo()
  try {
    const config = resolveConfig({ entries: ['src/main.js'] })
    repo.write('src/api.js', 'export function fn() {}\nexport function user() { return fn() }\n')
    repo.commit('add', { date: '2024-01-01' })
    repo.write('src/api.js', 'export function fn() {}\nexport function user() { return fn(1) }\n')
    repo.commit('change args', { date: '2024-02-01' })
    repo.write('src/api.js', 'export function fn() {}\nexport function user() { return 1 }\n')
    const removed = repo.commit('stop calling fn', { date: '2024-03-01' })
    const h = traceDefinition({ root: repo.root, rev: 'HEAD', file: 'src/api.js', fn: 'fn', config })
    assert.equal(h.lostRef.commit.hash, removed, '改参数那次不算，删掉调用那次才算')
    const capped = traceDefinition({ root: repo.root, rev: 'HEAD', file: 'src/api.js', fn: 'fn', config, maxCommits: 0 })
    assert.deepEqual([capped.lostRef, capped.introduced, Boolean(capped.unresolved)], [null, null, true])
  } finally {
    repo.cleanup()
  }
})

test('buildApiReport：报告里任何一个项目还有没补的规则，其他项目定义的接口也不能判可删', () => {
  const commit = { hash: 'a'.repeat(40), date: '2026-01-02', author: 'bob', subject: 's' }
  const base = (name, endpoints, coverage = {}) => finalize({ kind: 'api', version: 1, project: { name, rev: 'b'.repeat(40) }, rules: { version: 1 }, historyTraced: true, coverage, endpoints: structuredClone(endpoints) })
  const ep = { key: 'GET /a', method: 'GET', path: '/a', status: 'dead', evidence: [{ detail: 'd' }], definitions: [{ file: 'a.js', line: 1, fn: 'f' }], callers: [], history: { type: 'lost', commit, from: 'x.vue' } }
  assert.equal(buildApiReport([base('p1', [ep]), base('p2', [])]).rows[0].verdict, 'A 可删')
  const r = buildApiReport([base('p1', [ep]), base('p2', [], { dynamic: [{}] })])
  assert.equal(r.rows[0].verdict, 'B 需审核')
  assert.match(r.rows[0].reasons.join(), /p2：覆盖报告还有 1 处没补的规则/)
})

test('summarizeHistory：每个定义都确认从没被调用才算 never；有没查到的（上限、调用方还被死代码引用）不算', () => {
  const c = (date) => ({ hash: date, date, author: 'a', subject: 's' })
  assert.equal(summarizeHistory([{ state: 'dead', history: { lostRef: null, introduced: c('2024-02-01') } }, { state: 'dead', history: { lostRef: null, introduced: c('2024-01-01') } }]).introduced.date, '2024-01-01')
  assert.equal(summarizeHistory([{ state: 'dead', history: { lostRef: null, introduced: null, unresolved: '仍被没人用的文件引用' } }]), null)
  assert.equal(summarizeHistory([{ state: 'dead', history: { lostRef: null, introduced: c('2024-01-01') } }, { state: 'dead' }]), null, '有定义没查历史')
  assert.equal(summarizeHistory([{ state: 'dead', history: { lostRef: { commit: c('2024-03-01'), from: 'x' } } }, { state: 'dead', history: { lostRef: null, introduced: null, unresolved: 'x' } }]).type, 'lost')
})

test('traceDefinition：别的文件只是改了调用（之后还引用着）不算失去引用，也不判从没被调用', () => {
  const repo = createRepo()
  try {
    const config = resolveConfig({ entries: ['src/main.js'] })
    repo.write('src/api.js', 'export function fn() {}\n')
    repo.write('src/old.js', "import { fn } from './api.js'\nexport const x = () => fn()\n")
    repo.commit('add', { date: '2024-01-01' })
    repo.write('src/old.js', "import { fn } from './api.js'\nexport const x = () => fn(1)\n")
    repo.commit('change args', { date: '2024-02-01' })
    const h = traceDefinition({ root: repo.root, rev: 'HEAD', file: 'src/api.js', fn: 'fn', config })
    assert.equal(h.lostRef, null)
    assert.equal(h.introduced, null)
    assert.match(h.unresolved, /src\/old\.js 改过对它的调用/)
  } finally {
    repo.cleanup()
  }
})

test('buildApiReport：完整网址的接口不管结果里写什么状态，都不进 A / B', () => {
  const commit = { hash: 'a'.repeat(40), date: '2026-01-02', author: 'b', subject: 's' }
  const ep = { key: 'GET //cdn.x.com/a', method: 'GET', path: '//cdn.x.com/a', status: 'dead', evidence: [{ detail: 'd' }], definitions: [{ file: 'a.js', line: 1, fn: 'f', state: 'dead' }], callers: [], history: { type: 'lost', commit, from: 'x.vue' } }
  const r = buildApiReport([{ kind: 'api', version: 1, project: { name: 'p', rev: 'x' }, rules: { version: 1 }, historyTraced: true, summary: { endpoints: 1, byStatus: { dead: 1 } }, coverage: {}, endpoints: [ep] }])
  assert.equal(r.rows[0].verdict, 'C 高风险')
  assert.match(r.rows[0].reasons.join(), /第三方服务/)
})

test('commitOrder / summarizeHistory：同一天的多个提交按主线上的先后比较，不按日期', () => {
  const repo = createRepo()
  try {
    repo.write('a.txt', '1')
    const first = repo.commit('first', { date: '2024-05-01' })
    repo.write('a.txt', '2')
    const second = repo.commit('second', { date: '2024-05-01' })
    const newer = commitOrder(repo.root, 'HEAD')
    const c1 = { hash: first, date: '2024-05-01', author: 'a', subject: 'first' }
    const c2 = { hash: second, date: '2024-05-01', author: 'a', subject: 'second' }
    assert.ok(newer(c2, c1) < 0, 'second 更新')
    const lost = summarizeHistory([{ state: 'dead', history: { lostRef: { commit: c1, from: 'x' } } }, { state: 'dead', history: { lostRef: { commit: c2, from: 'y' } } }], newer)
    assert.equal(lost.commit.subject, 'second', '取最近一次失去引用')
    const never = summarizeHistory([{ state: 'dead', history: { lostRef: null, introduced: c2 } }, { state: 'dead', history: { lostRef: null, introduced: c1 } }], newer)
    assert.equal(never.introduced.subject, 'first', '取最早的定义')
  } finally {
    repo.cleanup()
  }
})

test('findDefined：注释、调用里先出现的名字不算定义；只认新增的声明行', () => {
  const repo = createRepo()
  try {
    repo.write('src/api.js', '// function fn() {} was removed\n/* const fn = 1 */\n')
    repo.commit('comment', { date: '2024-01-01' })
    repo.write('src/api.js', '// function fn() {} was removed\n/* const fn = 1 */\nexport const x = () => fn()\n')
    repo.commit('call', { date: '2024-02-01' })
    repo.write('src/api.js', '// function fn() {} was removed\n/* const fn = 1 */\nexport const x = () => fn()\nexport function fn() {}\n')
    const defined = repo.commit('define', { date: '2024-03-01' })
    assert.equal(findDefined(repo.root, 'HEAD', 'src/api.js', 'fn').hash, defined)
    repo.write('src/b.js', '// only a comment about gone()\n')
    repo.commit('comment only')
    assert.equal(findDefined(repo.root, 'HEAD', 'src/b.js', 'gone'), null, '只有注释：没查到，不凑数')
  } finally {
    repo.cleanup()
  }
})

test('validateApiResult：结论之间对不上的损坏结果也拒绝（空证据、没人用却没定义、在用却没依据、查过历史却没历史字段、汇总对不上）', () => {
  const good = () => ({ kind: 'api', version: 1, project: { name: 'p', rev: 'x' }, rules: { version: 1 }, historyTraced: true, summary: { endpoints: 1, byStatus: { dead: 1 } }, coverage: {}, endpoints: [
    { key: 'GET /a', method: 'GET', path: '/a', status: 'dead', evidence: [{ detail: 'd' }], definitions: [{ file: 'a.js', line: 1, fn: 'f', state: 'dead' }], callers: [], history: null }
  ] })
  assert.deepEqual(validateApiResult(good()), [])
  const cases = [
    [(r) => { r.endpoints[0].evidence = [] }, 'evidence 不能为空'],
    [(r) => { r.endpoints[0].definitions = [] }, '却没有任何定义位置'],
    [(r) => { r.endpoints[0].definitions[0].state = 'live' }, '定义里却有在用的'],
    [(r) => { r.endpoints[0].status = 'live'; r.summary.byStatus = { live: 1 } }, '判为在用，却没有在用的定义'],
    [(r) => { delete r.endpoints[0].history }, '却没有 history 字段'],
    [(r) => { r.historyTraced = false; r.endpoints[0].history = { type: 'never', introduced: { hash: 'h', date: 'd', author: 'a', subject: 's' } } }, '没有标明查过历史'],
    [(r) => { r.summary.endpoints = 2 }, 'summary.endpoints'],
    [(r) => { r.summary.byStatus = { live: 1 } }, 'summary.byStatus']
  ]
  for (const [mutate, msg] of cases) {
    const r = good()
    mutate(r)
    assert.match(validateApiResult(r).join('\n'), new RegExp(msg), msg)
  }
})

test('scanApi：SDK 的 via 认得命名空间导入、默认导入和解构', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 's', type: 'module' }))
    repo.write('src/main.js', [
      "import * as Sdk from '@x/sdk'",
      "import Ui from '@x/ui'",
      "import * as Other from '@x/other'",
      'Sdk.createAuth()',
      'Ui.Panel.open()',
      'const { refresh } = Other',
      'refresh()'
    ].join('\n'))
    repo.commit('i')
    const r = scanApi({ root: repo.root, project: 's', config: resolveConfig({ entries: ['src/main.js'], api: { version: 1, calls: [{ call: 'request(url)', method: 'GET' }], sdk: [
      { method: 'POST', path: '/login', package: '@x/sdk', via: ['createAuth'] },
      { method: 'POST', path: '/pwd', package: '@x/ui', via: ['Panel.open'] },
      { method: 'POST', path: '/token', package: '@x/other', via: ['refresh'] },
      { method: 'POST', path: '/unused', package: '@x/sdk', via: ['other'] }
    ] } }) })
    assert.deepEqual(Object.fromEntries(r.endpoints.map((e) => [e.key, e.status])), { 'POST /login': 'live', 'POST /pwd': 'live', 'POST /token': 'live', 'POST /unused': 'sdk' })
  } finally {
    repo.cleanup()
  }
})
