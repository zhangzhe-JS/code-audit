import { test } from 'node:test'
import assert from 'node:assert/strict'
import { findKnip } from '../src/collect/knip.js'
import { extractFile, loadParser } from '../src/api/extract.js'
import { compileCalls } from '../src/api/rules.js'
import { scanApi } from '../src/api/scan.js'
import { resolveConfig } from '../src/core/config.js'
import { createRepo } from './helpers/repo.js'

const parser = loadParser(findKnip().dir)
const calls = compileCalls({ version: 1, calls: [{ call: 'request({url})', method: 'GET' }] })
const sorted = (m) => Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort()]).sort())

test('extractFile：请求在 Pinia store 的哪些 action 里——setup 写法顺着内部调用走，store 创建时就执行的不记；选项写法顺着 this.x() 走', () => {
  const setup = [
    "import request from './request'",
    "export const useU = defineStore('u', () => {",
    "  const load = () => request({ url: '/load' })",
    "  const inner = () => request({ url: '/inner' })",
    '  const refresh = () => inner()',
    "  function orphan() { return request({ url: '/orphan' }) }",
    "  const boot = () => request({ url: '/boot' })",
    '  boot()',
    "  const watched = () => request({ url: '/watched' })",
    '  watch(src, watched)',
    "  return { load, refresh, again: refresh, inline: () => request({ url: '/inline' }) }",
    '})'
  ].join('\n')
  const s = extractFile({ parser, path: 'src/u.js', content: setup, calls })
  const acts = Object.fromEntries(s.sites.map((x) => [x.path, x.storeActions ?? null]))
  assert.deepEqual(acts, { '/load': ['load'], '/inner': ['again', 'refresh'], '/orphan': [], '/boot': null, '/watched': null, '/inline': ['inline'] })
  assert.ok(s.sites.filter((x) => x.storeActions).every((x) => x.store === 'useU'))

  const options = [
    "import request from './request'",
    "export const useC = defineStore('c', {",
    '  getters: { total() { return this.calc() } },',
    '  actions: {',
    '    add() { return this.save() },',
    "    save() { return request({ url: '/save' }) },",
    "    clear() { return request({ url: '/clear' }) },",
    "    calc() { return request({ url: '/calc' }) }",
    '  }',
    '})',
    "export const useD = defineStore('d', { actions: { go() { return this[name]() }, x() { return request({ url: '/dyn' }) } } })"
  ].join('\n')
  const o = extractFile({ parser, path: 'src/c.js', content: options, calls })
  const oa = Object.fromEntries(o.sites.map((x) => [x.path, x.storeActions ?? null]))
  assert.deepEqual(oa, { '/save': ['add', 'save'], '/clear': ['clear'], '/calc': null, '/dyn': null }, 'getters 里调用的、this[name] 的看不清')
  assert.ok(o.sites.every((x) => x.vuexAction === undefined), 'Pinia 的 actions 不按 Vuex 认')
})

test('extractFile：Vuex 模块的 action；不带命名空间的派发、算不出的派发', () => {
  const r = extractFile({
    parser,
    path: 'src/m.js',
    content: [
      "import request from './request'",
      "export default { namespaced: true, actions: { fetch() { return request({ url: '/f' }) }, drop({ dispatch }) { dispatch('fetch'); return request({ url: '/d' }) } } }",
      'export const go = (s, t) => s.dispatch(t)',
      "export const helpers = { ...mapActions(['plainA']), ...mapActions('ns', ['b', name]) }"
    ].join('\n'),
    calls
  })
  assert.deepEqual(r.sites.map((x) => [x.path, x.vuexAction]), [['/f', 'fetch'], ['/d', 'drop']])
  assert.deepEqual([...r.storeDispatch.plain].sort(), ['fetch', 'plainA'])
  assert.equal(r.storeDispatch.dynamic, true)
  assert.deepEqual([...r.storeActionUses], ['ns/b'])
})

test('extractFile：文件怎么用 store——成员、解构、mapActions、storeToRefs、整个交出去、模板里的写法', () => {
  const content = [
    '<script setup>',
    "import { useUserStore } from './u'",
    'const s = useUserStore()',
    'const { a, ...rest } = useOther()',
    'useThird().go()',
    "const m = { ...mapActions(useFour, ['x', y]), ...mapState(useFive, ['s']) }",
    'storeToRefs(s)',
    'pass(useSix())',
    'const p = useSeven()',
    'keep(p)',
    'mapStores(useEight)',
    '</script>',
    '<template><b @click="s.refresh()">{{ s?.name }}</b></template>'
  ].join('\n')
  const r = extractFile({ parser, path: 'src/P.vue', content, calls })
  assert.deepEqual(sorted(r.piniaUses), {
    useEight: ['*'],
    useFour: ['*', 'x'],
    useOther: ['*', 'a'],
    useSeven: ['*'],
    useSix: ['*'],
    useThird: ['go'],
    useUserStore: ['name', 'refresh']
  })
  assert.equal(r.storeDispatch.dynamic, false, 'mapActions(useX, ...) 是 Pinia 的写法，不算 Vuex 的派发')
  // 模板里单独出现 s：看不清
  const t = extractFile({ parser, path: 'src/Q.vue', content: "<script setup>\nconst s = useUserStore()\n</script>\n<template><Child :store=\"s\" /></template>", calls })
  assert.deepEqual(sorted(t.piniaUses), { useUserStore: ['*'] })
})

test('scanApi：请求写在 store 的 action 里，store 在用、action 没人调用的判没人用；看不清用法的按 store 判', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'demo', type: 'module', dependencies: { pinia: '2.0.0', vuex: '4.0.0' } }))
    repo.write('src/utils/request.js', 'export default function request(config) { return fetch(config.url) }\n')
    const user = [
      "import { defineStore } from 'pinia'",
      "import request from '../utils/request.js'",
      "export const useUserStore = defineStore('user', () => {",
      "  const load = () => request({ url: '/user/load' })",
      "  const login = () => request({ url: '/user/login' })",
      "  const inner = () => request({ url: '/user/inner' })",
      '  const refresh = () => inner()',
      "  const orphan = () => request({ url: '/user/orphan' })",
      "  const boot = () => request({ url: '/user/boot' })",
      '  boot()',
      '  return { load, login, refresh }',
      '})'
    ].join('\n')
    repo.write('src/stores/user.js', user)
    repo.write('src/stores/cart.js', [
      "import { defineStore } from 'pinia'",
      "import request from '../utils/request.js'",
      "export const useCartStore = defineStore('cart', {",
      '  actions: {',
      '    add() { return this.save() },',
      "    save() { return request({ url: '/cart/save' }) },",
      "    clear() { return request({ url: '/cart/clear' }) }",
      '  }',
      '})'
    ].join('\n'))
    repo.write('src/stores/whole.js', [
      "import { defineStore } from 'pinia'",
      "import request from '../utils/request.js'",
      "export const useWholeStore = defineStore('whole', { actions: { x() { return request({ url: '/whole/x' }) } } })"
    ].join('\n'))
    repo.write('src/store/order.js', [
      "import request from '../utils/request.js'",
      "export default { namespaced: true, actions: { fetch() { return request({ url: '/order/fetch' }) }, drop() { return request({ url: '/order/drop' }) }, undo() { return request({ url: '/order/undo' }) } } }"
    ].join('\n'))
    repo.write('src/store/index.js', "import { createStore } from 'vuex'\nimport order from './order.js'\nexport default createStore({ modules: { order, order2: order } })\n")
    const main = [
      "import { mapActions } from 'pinia'",
      "import { useUserStore as useU } from './stores/user.js'",
      "import { useCartStore } from './stores/cart.js'",
      "import { useWholeStore } from './stores/whole.js'",
      "import store from './store/index.js'",
      'const s = useU()',
      's.load()',
      's.refresh()',
      'helper(useWholeStore())',
      "store.dispatch('order/fetch')",
      "store.dispatch('order2/undo')", // 同一个模块的第二个命名空间
      "export default { methods: { ...mapActions(useCartStore, ['add']) } }"
    ]
    repo.write('src/main.js', main.join('\n'))
    repo.commit('init')
    const config = resolveConfig({ entries: ['src/main.js'], api: { version: 1, calls: [{ call: 'request({url})', method: 'GET' }] } })
    const status = (r) => Object.fromEntries(r.endpoints.map((e) => [e.path, e.status]))
    const r = scanApi({ root: repo.root, project: 'demo', config })
    assert.deepEqual(status(r), {
      '/cart/clear': 'dead',
      '/cart/save': 'live', // add 调用 this.save()
      '/order/drop': 'dead',
      '/order/fetch': 'live',
      '/order/undo': 'live',
      '/user/boot': 'live', // store 创建时就执行
      '/user/inner': 'live', // refresh 调用它
      '/user/load': 'live',
      '/user/login': 'dead',
      '/user/orphan': 'dead',
      '/whole/x': 'live' // 整个 store 被交出去：看不清
    })
    const reason = (p) => r.endpoints.find((e) => e.path === p).definitions[0].reason
    assert.match(reason('/user/login'), /store useUserStore 在用，但走到这里的 action（login）没有地方调用/)
    assert.match(reason('/user/login'), /useU/, '引用方里的别名也找过')
    assert.match(reason('/user/orphan'), /不在任何对外交出的 action 里/)
    assert.match(reason('/order/drop'), /Vuex 模块 order、order2 在用，但 action drop 没有地方派发/)

    // 项目里有算不出类型的派发：Vuex 的都不判；store 在自己文件里被别的代码用到：Pinia 的不判
    repo.write('src/main.js', [...main, 'export const go = (t) => store.dispatch(t)'].join('\n'))
    repo.write('src/stores/user.js', `${user}\nexport const peek = () => useUserStore().$id\n`)
    repo.commit('dynamic')
    const r2 = scanApi({ root: repo.root, project: 'demo', config })
    assert.equal(status(r2)['/order/drop'], 'live')
    assert.equal(status(r2)['/user/login'], 'live')
    assert.equal(status(r2)['/cart/clear'], 'dead')
  } finally {
    repo.cleanup()
  }
})

test('scanApi：自动导入的本地函数（含改了名的）按名字用到就在用；Pinia 的 action 也认登记的全局名', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'demo', type: 'module', dependencies: { pinia: '2.0.0' } }))
    repo.write('src/utils/request.js', 'export default function request(config) { return fetch(config.url) }\n')
    repo.write('src/api/auto.js', [
      "import request from '../utils/request.js'",
      "export const loadA = () => request({ url: '/auto/a' })",
      "export const loadB = () => request({ url: '/auto/b' })",
      "export const loadC = () => request({ url: '/auto/c' })"
    ].join('\n'))
    repo.write('src/stores/u.js', [
      "import { defineStore } from 'pinia'",
      "import request from '../utils/request.js'",
      "export const useUserStore = defineStore('u', () => {",
      "  const login = () => request({ url: '/u/login' })",
      "  const logout = () => request({ url: '/u/logout' })",
      '  return { login, logout }',
      '})'
    ].join('\n'))
    repo.write('src/auto-imports.d.ts', [
      'export {}',
      'declare global {',
      "  const loadA: typeof import('./api/auto.js')['loadA']",
      "  const fetchB: typeof import('./api/auto.js')['loadB']",
      "  const loadC: typeof import('./api/auto.js')['loadC']",
      "  const useU: typeof import('./stores/u.js')['useUserStore']",
      '}'
    ].join('\n'))
    repo.write('src/main.js', "import './api/auto.js'\nimport './stores/u.js'\nloadA()\nfetchB()\nuseU().login()\n")
    repo.commit('init')
    const config = resolveConfig({ entries: ['src/main.js'], api: { version: 1, calls: [{ call: 'request({url})', method: 'GET' }] } })
    const r = scanApi({ root: repo.root, project: 'demo', config })
    assert.deepEqual(Object.fromEntries(r.endpoints.map((e) => [e.path, e.status])), {
      '/auto/a': 'live',
      '/auto/b': 'live', // 改了名的
      '/auto/c': 'dead', // 登记了没人用
      '/u/login': 'live',
      '/u/logout': 'dead'
    })
  } finally {
    repo.cleanup()
  }
})
