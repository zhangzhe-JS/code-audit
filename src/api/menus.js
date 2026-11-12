/**
 * 菜单归属：在用的接口是哪些菜单在用
 *
 * 从接口定义出发往上找引用方，经过的文件落在哪些菜单的范围里（profile 的 menus），就是哪些菜单在用。
 * menus 里具体菜单写路由对应的页面入口文件（不写整个目录：放在 A 菜单目录下的共享组件可能是 B 菜单在用）。
 *
 * 往上找的单位是「文件里的顶层名字」，每一步都按名字追，不按文件连：
 * - 同一个文件里：名字 x 被哪些顶层名字引用（函数 a 里调用了 x），a 也算在用
 * - 跨文件：导出的名字被哪些文件 import（顺着 export ... from 连到真正定义的文件），在引用方里看是哪些顶层名字用了导入的本地名，
 *   从那些名字继续。所以汇总导出的文件（@/mixins/index.js）、工具文件里别的函数，不会把接口摊到所有引用它们的页面
 * - 模块顶层执行的代码（<module>）：文件被加载就运行，所有加载它的文件都算（加载方的顶层，继续往上）
 * - 组件：单文件组件的模板、<script setup> 里的名字都算组件本身（default）；组件被 import、写在模板里（全局组件）、
 *   被 import() 异步加载，都从引用方继续
 * - 引用方里看不出是谁在用导入的名字（只 import 没看到用法）：不知道是哪段代码，按整个文件算（偏保守）
 * - Vuex：经过模块里的 action 引用到的，换成派发这个 action 的文件（dispatch('ns/action')、mapActions）；
 *   不在 action 里的退回按命名空间：用到这个命名空间的文件都算
 * - 碰到具体菜单的页面入口：组件本身、模块顶层在用时记下这个菜单、不再往上（再往上只会经过路由走到入口）；
 *   页面文件导出的具名函数被别的文件用，照样往上找那些文件
 * - 碰到 global: true 的菜单（布局、入口、启动配置、状态管理）：记下、不再往上，否则会摊到所有菜单。
 *   一个文件同时落在多个 global 菜单里时取配置里靠前的
 * - 具体菜单和全局菜单都记：既有页面在用、布局（顶部栏）也在用的接口两个都写
 * - 都找不到时返回空：引用链断在动态加载、状态管理的字符串派发等看不到的地方，报告里写明「未归属」，不猜
 */
import { buildLookup, resolveSpec } from '../collect/path-refs.js'
import { globToRegExp } from '../collect/glob-imports.js'
import { SFC_EXTENSIONS } from '../collect/source-text.js'
import { MODULE, TEMPLATE } from './extract.js'

/** 整个文件：看不出是哪段代码在用时 */
const WHOLE = '*'
const DEFAULT = 'default'

/**
 * @param {object} opts
 * @param {object[]} opts.parsed       extractFile 的结果
 * @param {Map<string, object>} opts.unreachable  走不到的文件
 * @param {Record<string, string>} opts.aliases
 * @param {{name: string, files: string[], global?: boolean}[]} opts.menus
 * @param {Map<string, {from: string, locals?: string[]}[]>} opts.callers  findCallers 的结果：「文件#名字」→ 引用它的文件、在引用方里的本地名
 * @param {Map<string, {from: string}[]>} [opts.tagUses]  全局组件文件 → 模板里用到它的文件
 * @returns {(start: (string|[string, string])[] | null, def?: {file: string, fn: string}) => {menus: string[], global: boolean}}
 *   传 def：从定义所在的顶层名字出发；否则从 start 出发（[文件, 顶层名字]，只写文件表示整个文件）
 */
export function createMenuFinder({ parsed, unreachable, aliases, menus, callers, tagUses = new Map() }) {
  const matchers = menus.map((m) => ({ name: m.name, global: Boolean(m.global), res: m.files.map(globToRegExp) }))
  const specificOf = (file) => matchers.filter((m) => !m.global && m.res.some((re) => re.test(file)))
  const globalOf = (file) => matchers.find((m) => m.global && m.res.some((re) => re.test(file))) ?? null
  const byPath = new Map(parsed.map((p) => [p.path, p]))
  const lookup = buildLookup(parsed.map((p) => p.path))
  const resolveTo = (spec, from) => {
    const r = resolveSpec(spec, from, aliases)
    return r === null ? null : (lookup.get(r) ?? [])[0] ?? null
  }
  const reachable = parsed.filter((p) => !unreachable.has(p.path))
  const addTo = (map, key, value) => {
    if (!key || key === value) return
    const set = map.get(key) ?? new Set()
    set.add(value)
    map.set(key, set)
  }

  // 加载它的文件（模块顶层的代码用）：任何 import、只为副作用的 import、import()
  const loaders = new Map()
  for (const [key, list] of callers) for (const c of list) addTo(loaders, key.slice(0, key.lastIndexOf('#')), c.from)
  const dynamicLoaders = new Map() // import('...')：整个模块被加载，接到默认导出上
  for (const p of reachable) {
    for (const imp of p.imports) if (imp.specifiers.length === 0) addTo(loaders, resolveTo(imp.source, p.path), p.path)
    for (const spec of p.dynamicImports ?? []) {
      const t = resolveTo(spec, p.path)
      addTo(loaders, t, p.path)
      addTo(dynamicLoaders, t, p.path)
    }
  }
  const tagUsers = new Map()
  for (const [file, uses] of tagUses) for (const u of uses) if (!unreachable.has(u.from)) addTo(tagUsers, file, u.from)

  // Vuex：命名空间 → 模块文件；用到命名空间的文件、派发具体 action 的文件
  const vuex = vuexModuleResolver({ parsed, aliases, lookup })
  const nsUsers = new Map() // 模块文件 → 用到它命名空间的文件
  const actionUsers = new Map() // ns/action → 派发它的文件
  for (const p of reachable) {
    for (const ns of p.storeUses ?? []) addTo(nsUsers, vuex.fileOf(ns), p.path)
    for (const a of p.storeActionUses ?? []) addTo(actionUsers, a, p.path)
  }

  const isSfc = (f) => SFC_EXTENSIONS.some((e) => f.endsWith(e))
  // <script setup>：没有 export default，顶层名字模板里都能直接用，算组件本身
  const isSetupSfc = (f) => isSfc(f) && ![...(byPath.get(f)?.bindings.values() ?? [])].some((b) => b.exported.has(DEFAULT))
  const internal = (n) => n === MODULE || n === TEMPLATE || n === DEFAULT || n === WHOLE

  /** 引用方 from 里，用了导入名 local（命名空间写 ns.*）的顶层名字；看不出时返回整个文件 */
  const usersOf = (from, local, defFile, defName) => {
    const p = byPath.get(from)
    if (!p) return [WHOLE]
    const uses = p.importUses ?? new Map()
    let owners = []
    const base = local.endsWith('.*') ? local.slice(0, -2) : local
    if (local.endsWith('.*')) {
      const ns = local.slice(0, -2)
      const names = new Set([defName, ...(byPath.get(defFile)?.bindings.get(defName)?.exported ?? [])])
      for (const [k, set] of uses) if ([...names].some((n) => k === `${ns}.${n}` || k.startsWith(`${ns}.${n}.`))) owners.push(...set)
      owners.push(...(p.importWhole?.get(ns) ?? [])) // 整个命名空间对象被用到（传参、svc[key]）：看不出用哪个成员，都算
    } else {
      owners = [...(uses.get(local) ?? [])]
    }
    // import 进来又原样导出（export { x }）：本地名本身就是导出的顶层名字
    if (p.bindings.get(local)?.exported.size > 0) owners.push(local)
    // 用在声明时就执行的代码里（const data = load()）：文件被加载就会运行
    if (owners.some((o) => p.loadTime?.has(o))) owners.push(MODULE)
    if (owners.length > 0) return [...new Set(owners)]
    // 一处用法都没看到：不知道是哪段代码，按整个文件；命名空间用了别的成员：这个名字没人用
    return uses.has(base) ? [] : [WHOLE]
  }

  /** 进入 Vuex 模块：经过哪个 action 用到的，换成派发这个 action 的文件；没有就返回 null（照常往上） */
  const viaActions = (file, local) => {
    const p = byPath.get(file)
    const ns = vuex.nsOf(file)
    if (!p?.storeActions?.length || !ns) return null
    const name = local.endsWith('.*') ? local.slice(0, -2) : local
    const users = new Set()
    for (const a of p.storeActions) if (a.refs.includes(name)) for (const u of actionUsers.get(`${ns}/${a.name}`) ?? []) users.add(u)
    return users.size > 0 ? [...users] : null
  }

  return (start, def) => {
    const queue = def ? def.fn.split('、').map((n) => [def.file, n]) : (start ?? []).map((s) => (Array.isArray(s) ? s : [s, WHOLE]))
    const specific = new Set()
    const global = new Set()
    const seen = new Set()
    const push = (f, n) => {
      if (!seen.has(`${f}#${n}`)) queue.push([f, n])
    }
    while (queue.length > 0) {
      const [f, n] = queue.shift()
      const key = `${f}#${n}`
      if (seen.has(key)) continue
      seen.add(key)
      const g = globalOf(f)
      if (g && specificOf(f).length === 0) {
        global.add(g.name)
        continue // 全局类的文件：不再往上
      }
      const sp = specificOf(f)
      const p = byPath.get(f)
      // 组件里的名字都归到组件本身；整个文件 → 所有顶层名字
      if (n === WHOLE) {
        if (isSfc(f)) push(f, DEFAULT)
        else {
          push(f, MODULE)
          for (const b of p?.bindings.keys() ?? []) push(f, b)
        }
        continue
      }
      if ((n === MODULE || n === TEMPLATE) && isSfc(f)) {
        push(f, DEFAULT)
        continue
      }
      if (!internal(n) && isSetupSfc(f)) push(f, DEFAULT)
      if (sp.length > 0 && internal(n)) {
        for (const m of sp) specific.add(m.name)
        continue // 页面入口：组件本身、顶层代码在用，再往上只会经过路由
      }
      // 同一个文件里引用了它的顶层名字
      if (!internal(n) || n === DEFAULT) for (const [b, info] of p?.bindings ?? []) if (b !== n && info.refs.has(n)) push(f, b)
      // 往上：模块顶层 → 加载它的文件；其他名字 → import 它的文件里用到它的名字
      if (n === MODULE) {
        for (const up of loaders.get(f) ?? []) push(up, MODULE)
        continue
      }
      for (const c of callers.get(key) ?? []) {
        for (const local of c.locals ?? [WHOLE]) {
          const actions = local === WHOLE ? null : viaActions(c.from, local)
          if (actions) {
            for (const u of actions) push(u, WHOLE)
            continue
          }
          for (const o of local === WHOLE ? [WHOLE] : usersOf(c.from, local, f, n)) push(c.from, o)
        }
      }
      if (n === DEFAULT) {
        // import('./x')：多数是拿默认导出（路由、异步组件），按引用方的顶层算；用具名导出的（.then(m => m.foo())）看不出
        for (const up of dynamicLoaders.get(f) ?? []) push(up, MODULE)
        for (const up of tagUsers.get(f) ?? []) push(up, TEMPLATE)
        for (const up of nsUsers.get(f) ?? []) push(up, WHOLE)
      }
    }
    return { menus: order(new Set([...specific, ...global]), matchers), global: specific.size === 0 && global.size > 0 }
  }
}

/**
 * Vuex 的命名空间 → 模块文件：从没有被别的模块注册过的注册表（根 store）开始，按 a/b/c 一层层找；
 * 找不到完整路径时用能找到的最深的那一层
 */
export function vuexModuleResolver({ parsed, aliases, lookup }) {
  const registry = new Map() // 文件 → 名字 → 模块文件
  for (const p of parsed) {
    if (!p.storeModules?.length) continue
    const map = new Map()
    for (const m of p.storeModules) {
      const imp = p.imports.find((i) => i.specifiers.some((sp) => sp.local === m.local))
      if (!imp) continue
      const r = resolveSpec(imp.source, p.path, aliases)
      const target = r === null ? null : (lookup.get(r) ?? [])[0]
      if (target) map.set(m.name, target)
    }
    if (map.size > 0) registry.set(p.path, map)
  }
  const registered = new Set([...registry.values()].flatMap((m) => [...m.values()]))
  const roots = [...registry.keys()].filter((f) => !registered.has(f))
  // 模块文件 → 命名空间（从根往下走一遍）
  const nsMap = new Map()
  const allNs = new Map() // 同一个模块可能注册在好几个命名空间下
  const uncertain = new Set()
  const byPath = new Map(parsed.map(p => [p.path, p]))
  const walk = (file, prefix, depth, trusted = true) => {
    if (depth > 10) return
    for (const [name, target] of registry.get(file) ?? []) {
      const certain = trusted && byPath.get(target)?.vuexNamespaced === true
      if (!certain) uncertain.add(target)
      const ns = prefix ? `${prefix}/${name}` : name
      if (!nsMap.has(target)) nsMap.set(target, ns)
      if (!allNs.has(target)) allNs.set(target, new Set())
      allNs.get(target).add(ns)
      walk(target, ns, depth + 1, certain)
    }
  }
  for (const r of roots) walk(r, '', 0)
  return {
    nsOf: (file) => nsMap.get(file) ?? null,
    nsAll: (file) => [...(allNs.get(file) ?? [])],
    // Registration paths are not Vuex namespaces when a parent omits namespaced.
    // Keep such modules live until their effective namespaces can be proven.
    trustedNamespaces: (file) => !uncertain.has(file) && allNs.has(file),
    fileOf: (ns) => {
      const parts = ns.split('/').filter(Boolean)
      for (const root of roots) {
        let cur = root
        let found = null
        for (const part of parts) {
          const next = registry.get(cur)?.get(part)
          if (!next) break
          found = next
          cur = next
        }
        if (found) return found
      }
      return null
    }
  }
}

/** 按配置里的顺序排 */
function order(names, matchers) {
  return matchers.map((m) => m.name).filter((n) => names.has(n))
}
