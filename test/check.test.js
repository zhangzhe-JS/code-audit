import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { compareApi, changedLines, checkChange, checkMarkdown } from '../src/api/check.js'
import { similarity, pathWords } from '../src/api/similar.js'
import { parseApi, apiImpact, similarApis, searchApis, fileInfo, loadIndex } from '../src/query/index.js'
import { handle, serve, TOOLS } from '../src/mcp/server.js'
import { resolveConfig } from '../src/core/config.js'
import { createRepo } from './helpers/repo.js'

const def = (file, line, fn, state = 'live') => ({ file, line, fn, state })
const ep = (key, status, defs, extra = {}) => ({ key, method: key.split(' ')[0], path: key.split(' ')[1], status, evidence: [{ detail: 'd' }], definitions: defs, callers: [], ...extra })
const result = (name, endpoints, coverage = {}) => {
  const byStatus = {}
  for (const e of endpoints) byStatus[e.status] = (byStatus[e.status] ?? 0) + 1
  return { kind: 'api', version: 1, project: { name, rev: `${name}-rev` }, rules: { version: 1 }, summary: { endpoints: endpoints.length, byStatus }, coverage, endpoints }
}

// ---------- 相似度 ----------

test('similarity：按词算重合；完全一样是 1；只有参数的路径是 0', () => {
  assert.deepEqual(pathWords('/template/v2/enabledWithoutService'), ['template', 'v2', 'enabled', 'without', 'service'])
  assert.equal(similarity('/template/v2/enabled', '/template/v2/enabledWithoutService'), 0.6)
  assert.equal(similarity('/a/b', '/a/b'), 1)
  assert.equal(similarity('/{}', '/x'), 0)
  assert.equal(similarity('/user-list/x_y', '/user/list/x/y'), 1, '短横线、下划线也拆')
})

// ---------- check ----------

test('compareApi：地址改了（要处理）、新增像已有的、不再定义、在用变没人用、重新在用、多处定义、改到了定义、规则认不出的新写法', () => {
  const before = result('p', [
    ep('GET /order/list', 'live', [def('src/api.js', 1, 'listOrders')]),
    ep('GET /order/old', 'live', [def('src/api.js', 5, 'getOrder')]),
    ep('POST /user/save', 'live', [def('src/user.js', 3, 'save')]),
    ep('GET /report', 'live', [def('src/report.js', 1, 'report')]),
    ep('GET /stats', 'dead', [def('src/stats.js', 1, 'stats', 'dead')]),
    ep('GET /dup', 'live', [def('src/a.js', 1, 'dupA')]),
    ep('GET /gone', 'dead', [def('src/gone.js', 1, 'gone', 'dead')])
  ])
  const after = result('p', [
    ep('GET /order/list', 'live', [def('src/api.js', 1, 'listOrders')], { menus: ['订单'] }),
    ep('GET /order/new', 'live', [def('src/api.js', 5, 'getOrder')]),
    ep('POST /user/save', 'dead', [def('src/user.js', 3, 'save', 'dead')]),
    ep('GET /order/listAll', 'live', [def('src/api.js', 9, 'listAll')]),
    ep('GET /report', 'live', [def('src/report.js', 1, 'report')]),
    ep('GET /stats', 'live', [def('src/stats.js', 1, 'stats')]),
    ep('GET /dup', 'live', [def('src/a.js', 1, 'dupA'), def('src/b.js', 1, 'dupB')])
  ], { suspects: [{ from: 'src/new.js', line: 2, shape: 'http.get()', text: '/x' }] })
  const others = [result('q', [ep('GET /order/old', 'live', [def('src/q.js', 1, 'q')]), ep('POST /user/save', 'live', [def('src/q.js', 2, 'q2')])])]
  const r = compareApi({ before, after, others, changed: new Map([['src/api.js', new Set([1])]]) })
  const kinds = r.findings.map((f) => `${f.level}:${f.kind}:${f.key}`)
  assert.deepEqual(kinds, [
    'risk:changed-address:GET /order/new',
    'warn:added-similar:GET /order/listAll',
    'warn:became-unused:POST /user/save',
    'warn:coverage-suspects:src/new.js:2',
    'warn:duplicated:GET /dup',
    'info:removed:GET /gone',
    'info:touched:GET /order/list',
    'info:became-live:GET /stats'
  ].sort((a, b) => ['risk', 'warn', 'info'].indexOf(a.split(':')[0]) - ['risk', 'warn', 'info'].indexOf(b.split(':')[0]) || a.split(':').slice(2).join(':').localeCompare(b.split(':').slice(2).join(':'))))
  const get = (k) => r.findings.find((f) => f.kind === k)
  assert.match(get('changed-address').detail, /别的项目还在用（q）/)
  assert.match(get('became-unused').detail, /别的项目还在用（q）/)
  assert.match(get('touched').detail, /订单/)
  assert.deepEqual([r.summary.risk, r.summary.warn, r.summary.info], [1, 4, 3])
  assert.match(checkMarkdown(r), /### 要处理（1）/)
})

test('compareApi：没给其他项目时写明看不出；SDK 接口不再定义不提示；没有变化时 Markdown 说没有', () => {
  const before = result('p', [ep('GET /x', 'live', [def('a.js', 1, 'x')]), ep('POST /login', 'sdk', [], { sdk: { package: 's' } })])
  const after = result('p', [])
  const r = compareApi({ before, after })
  assert.equal(r.findings.length, 1)
  assert.match(r.findings[0].detail, /没给其他项目的结果/)
  assert.match(checkMarkdown(compareApi({ before: after, after })), /没有接口变化/)
})

test('compareApi：同一次新建的一组接口彼此很像，不互相提示（只和已有的比）', () => {
  const before = result('p', [ep('GET /order/list', 'live', [def('a.js', 1, 'l')])])
  const after = result('p', [ep('GET /order/list', 'live', [def('a.js', 1, 'l')]), ep('GET /sys/org/list', 'live', [def('o.js', 1, 'list')]), ep('GET /sys/org/listAll', 'live', [def('o.js', 2, 'listAll')])])
  const r = compareApi({ before, after })
  assert.deepEqual(r.findings.map((f) => f.kind), ['added', 'added'])
})

test('changedLines、checkChange：两个提交之间改到的行；真仓库里跑出地址变更', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'c', type: 'module' }))
    repo.write('src/main.js', "import { load } from './api.js'\nload()\n")
    repo.write('src/api.js', "export const load = () => request({ url: '/v1/load' })\n")
    const base = repo.commit('base')
    repo.write('src/api.js', "export const load = () => request({ url: '/v2/load' })\n")
    repo.commit('change address')
    assert.deepEqual([...changedLines(repo.root, base, 'HEAD').get('src/api.js')], [1])
    const config = resolveConfig({ entries: ['src/main.js'], api: { version: 1, calls: [{ call: 'request({url})', method: 'GET' }] } })
    const r = checkChange({ root: repo.root, project: 'c', config, base })
    assert.equal(r.summary.risk, 1)
    assert.match(r.findings[0].detail, /从 GET \/v1\/load 改成了 GET \/v2\/load/)
  } finally {
    repo.cleanup()
  }
})

// ---------- query ----------

test('parseApi：方法可写可不写；${id}、{id}、查询参数都认；看不出时报错', () => {
  assert.deepEqual(parseApi('get /api/x/${id}?a=1'), { method: 'GET', path: '/api/x/{}' })
  assert.deepEqual(parseApi('/x/{id}/y'), { method: null, path: '/x/{}/y' })
  assert.throws(() => parseApi('{id}'), /看不出是哪个接口/)
})

test('apiImpact / similarApis / searchApis / fileInfo：跨项目查；不写方法查所有方法；文件里的接口和没人用的导出', () => {
  const p = result('p', [ep('GET /order/list', 'live', [def('src/api.js', 1, 'list')], { menus: ['订单'] }), ep('DELETE /order/{}', 'dead', [def('src/api.js', 4, 'del', 'dead')])])
  const q = result('q', [ep('GET /order/list', 'dead', [def('src/o.js', 1, 'l', 'dead')]), ep('GET /order/listAll', 'live', [def('src/o.js', 3, 'la')])])
  const ex = { kind: 'exports', version: 1, project: { name: 'p', rev: 'x' }, summary: { candidates: 1 }, items: [{ file: 'src/api.js', name: 'del', line: 4, status: 'dead', suggestion: '删掉', evidence: [{ detail: 'd' }] }] }
  const index = { apis: [p, q], exports: [ex] }
  const a = apiImpact(index, 'GET /order/list')
  assert.deepEqual(a.liveIn, ['p'])
  assert.equal(a.matches.length, 2)
  assert.match(a.verdict, /在用：p/)
  assert.equal(apiImpact(index, '/order/{id}').matches[0].key, 'DELETE /order/{}', '不写方法查所有方法')
  assert.match(apiImpact(index, 'GET /nope').verdict, /都没有/)
  assert.deepEqual(similarApis(index, 'GET /order/listAll').results.map((x) => x.key), ['GET /order/listAll', 'GET /order/list'])
  assert.equal(searchApis(index, 'ORDER').total, 3)
  assert.throws(() => searchApis(index, '  '), /不能为空/)
  const f = fileInfo(index, 'src/api.js')
  assert.deepEqual([f.apis.length, f.unusedExports[0].name], [2, 'del'])
  assert.equal(fileInfo(index, 'src/api.js', 'q').apis.length, 0)
})

test('loadIndex：坏结果文件报错，写明是哪个文件', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-q-'))
  try {
    writeFileSync(join(dir, 'bad.json'), JSON.stringify({ kind: 'api', endpoints: [] }))
    assert.throws(() => loadIndex([join(dir, 'bad.json')]), /bad\.json 不是有效的 code-audit 结果/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------- MCP ----------

test('MCP handle：initialize、tools/list、tools/call（成功、参数不对、没有这个工具）、通知、不支持的方法', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-mcp-'))
  try {
    writeFileSync(join(dir, 'p.json'), JSON.stringify(result('p', [ep('GET /x', 'live', [def('a.js', 1, 'x')])])))
    const ctx = { dir, check: async (args) => ({ ran: args.base }) }
    const init = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }, ctx)
    assert.equal(init.result.protocolVersion, '2025-06-18')
    assert.deepEqual(init.result.capabilities, { tools: {} })
    assert.equal((await handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, ctx)).result.tools.length, TOOLS.length)
    const ok = await handle({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'api_impact', arguments: { api: 'GET /x' } } }, ctx)
    assert.deepEqual(JSON.parse(ok.result.content[0].text).liveIn, ['p'])
    const missing = await handle({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'file_info', arguments: {} } }, ctx)
    assert.equal(missing.result.isError, true)
    assert.match(missing.result.content[0].text, /缺少参数 file/)
    const unknown = await handle({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'nope' } }, ctx)
    assert.match(unknown.result.content[0].text, /没有这个工具/)
    const call = (args, c = ctx) => handle({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'check_change', arguments: args } }, c)
    const noProjects = await call({ project: 'p', base: 'main' })
    assert.match(noProjects.result.content[0].text, /启动服务时用 --check/, '没登记项目时不能检查')
    const withP = { ...ctx, projects: new Map([['p', { root: '/r', profile: '/p.js' }]]) }
    assert.deepEqual(JSON.parse((await call({ project: 'p', base: 'main' }, withP)).result.content[0].text), { ran: 'main' })
    assert.match((await call({ project: 'other', base: 'main' }, withP)).result.content[0].text, /没有登记这个项目：other（可用的：p）/)
    assert.match((await call({ project: 'p', base: '--output=/tmp/x' }, withP)).result.content[0].text, /提交写法不对/, '不能把参数伪装成提交')
    assert.match((await call({ project: 'p', profile: '/evil.js', base: 'main' }, withP)).result.content[0].text, /ran/, '多传的 profile 被忽略，只用登记的')
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx), null)
    assert.equal((await handle({ jsonrpc: '2.0', id: 7, method: 'nope' }, ctx)).error.code, -32601)
    assert.equal(await handle({ jsonrpc: '2.0', method: 'notifications/unknown' }, ctx), null, '通知（没有 id）不回复，不认识的也一样')
    assert.equal((await handle({ id: 8, method: 'x' }, ctx)).error.code, -32600)
    // 结果目录空：说清楚先生成结果
    const empty = mkdtempSync(join(tmpdir(), 'ca-mcp-empty-'))
    const r = await handle({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'search_apis', arguments: { text: 'x' } } }, { dir: empty })
    assert.match(r.result.content[0].text, /结果目录里没有 \.json/)
    rmSync(empty, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('MCP serve：按行读写；一条消息分几次到达也能拼起来；不合法的 JSON 回 -32700', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ca-mcp-s-'))
  try {
    mkdirSync(join(dir, 'r'))
    writeFileSync(join(dir, 'r', 'p.json'), JSON.stringify(result('p', [])))
    const input = new PassThrough()
    const output = new PassThrough()
    let text = ''
    output.on('data', (d) => (text += d))
    serve({ dir: join(dir, 'r'), input, output })
    input.write('{"jsonrpc":"2.0","id":1,"me')
    input.write('thod":"ping"}\nnot json\n')
    await new Promise((r) => setTimeout(r, 50))
    const lines = text.trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.find((m) => m.id === 1), { jsonrpc: '2.0', id: 1, result: {} })
    assert.equal(lines.find((m) => m.id === null).error.code, -32700)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
