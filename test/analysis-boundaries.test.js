import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRepo } from './helpers/repo.js'
import { resolveConfig } from '../src/core/config.js'
import { scanApi } from '../src/api/scan.js'
import { scanExports } from '../src/exports/scan.js'
import { compareApi } from '../src/api/check.js'

const config = resolveConfig({ entries: ['src/main.js'], api: { version: 1, calls: [{ call: 'request(url)', method: 'GET' }] }, menus: [{ name: 'Page', files: ['src/Page.js'] }] })
function fixture(fn) {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'boundaries', type: 'module', dependencies: { pinia: '2.0.0' } }))
    fn(repo)
  } finally { repo.cleanup() }
}

test('check blocks incomplete parsing on either side, including unchanged errors', () => {
  const good = { project: { name: 'p', rev: 'a' }, endpoints: [], coverage: {} }
  const bad = { ...good, coverage: { parseErrors: [{ from: 'src/api.js', message: 'invalid syntax' }] } }
  for (const [before, after] of [[good, bad], [bad, good], [bad, bad]]) {
    const r = compareApi({ before, after })
    assert.ok(r.findings.some(f => f.kind === 'coverage-parseErrors' && f.level === 'risk'))
  }
})

test('custom methods and shadowed pure names cannot authorize deleting initialization', () => fixture(repo => {
  repo.write('src/main.js', "import './effects.js'\n")
  repo.write('src/effects.js', `const service = { map() { globalThis.registered = true } }
function ref() { globalThis.other = true }
export const a = service.map()
export const b = ref()
export const c = (globalThis.counter = 1)
`)
  repo.commit('effects')
  const r = scanExports({ root: repo.root, project: 'p', config })
  for (const name of ['a', 'b', 'c']) assert.equal(r.items.find(x => x.name === name)?.status, 'internal', name)
}))

test('named dynamic imports retain menu ownership for then, await and destructuring', () => fixture(repo => {
  repo.write('src/main.js', "import { page } from './Page.js'; page()")
  repo.write('src/Page.js', `export async function page() {
  await import('./api.js').then(m => m.one())
  const api = await import('./api.js'); api.two()
  const { three: run } = await import('./api.js'); run()
}`)
  repo.write('src/api.js', "export const one = () => request('/one'); export const two = () => request('/two'); export const three = () => request('/three')")
  repo.commit('dynamic')
  const r = scanApi({ root: repo.root, project: 'p', config })
  for (const e of r.endpoints) {
    assert.equal(e.status, 'live', e.path)
    // Page.js is a module exposing page; use a menu rooted at its caller for this test.
    assert.ok(e.callers.some(c => c.from === 'src/Page.js'), e.path)
  }
  const menus = scanApi({ root: repo.root, project: 'p', config: resolveConfig({ ...config, menus: [{ name: 'Page', files: ['src/main.js'] }] }) })
  for (const e of menus.endpoints) assert.deepEqual(e.menus, ['Page'], e.path)
}))

test('API functions only used by inactive Pinia actions are unused, shared active calls stay live', () => fixture(repo => {
  repo.write('src/main.js', "import { useUser } from './store.js'; useUser().load()")
  repo.write('src/store.js', `import { defineStore } from 'pinia'
import { login, load, shared } from './api.js'
export const useUser = defineStore('u', { actions: {
  login() { login(); shared() }, load() { load(); shared() }
} })`)
  repo.write('src/api.js', "export const login = () => request('/login'); export const load = () => request('/load'); export const shared = () => request('/shared')")
  repo.commit('actions')
  const r = scanApi({ root: repo.root, project: 'p', config })
  assert.deepEqual(Object.fromEntries(r.endpoints.map(e => [e.path, e.status])), { '/load': 'live', '/login': 'dead', '/shared': 'live' })
  repo.write('src/main.js', "import { useUser } from './store.js'; import { login } from './api.js'; useUser().load(); login()")
  repo.commit('direct caller')
  assert.equal(scanApi({ root: repo.root, project: 'p', config }).endpoints.find(e => e.path === '/login').status, 'live')
}))

test('Vuex cross-file actions preserve active, direct and dynamic consumers', () => fixture(repo => {
  repo.write('src/main.js', "import store from './root.js'; store.dispatch('user/load')")
  repo.write('src/root.js', "import { createStore } from 'vuex'; import user from './store.js'; export default createStore({ modules: { user } })")
  repo.write('src/store.js', `import { login, load, shared } from './api.js'
export default { namespaced: true, actions: {
  login() { login(); shared() }, load() { load(); shared() }
} }`)
  repo.write('src/api.js', "export const login = () => request('/login'); export const load = () => request('/load'); export const shared = () => request('/shared')")
  repo.commit('Vuex actions')
  const scan = () => Object.fromEntries(scanApi({ root: repo.root, project: 'p', config }).endpoints.map(e => [e.path, e.status]))
  assert.deepEqual(scan(), { '/load': 'live', '/login': 'dead', '/shared': 'live' })
  repo.write('src/main.js', "import store from './root.js'; import { login } from './api.js'; store.dispatch('user/load'); login()")
  repo.commit('direct consumer')
  assert.equal(scan()['/login'], 'live')
  repo.write('src/main.js', "import store from './root.js'; store.dispatch(window.action)")
  repo.commit('dynamic consumer')
  assert.ok(Object.values(scan()).every(s => s === 'live'))
}))

test('Vuex mixed namespace registration never falsely marks active requests dead', () => fixture(repo => {
  repo.write('src/main.js', "import store from './root.js'; store.dispatch('user/load')")
  repo.write('src/root.js', "import { createStore } from 'vuex'; import parent from './parent.js'; export default createStore({ modules: { parent } })")
  repo.write('src/parent.js', "import user from './store.js'; export default { modules: { user } }")
  repo.write('src/store.js', `import { load } from './api.js'
export default { namespaced: true, actions: { load() { load(); return request('/inline') } } }`)
  repo.write('src/api.js', "export const load = () => request('/load')")
  repo.commit('non-namespaced parent')
  const r = scanApi({ root: repo.root, project: 'p', config })
  assert.ok(r.endpoints.length === 2)
  for (const e of r.endpoints) assert.equal(e.status, 'live', e.path)
}))
