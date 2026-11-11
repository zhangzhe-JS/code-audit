/**
 * 菜单归属：在用的接口是哪些菜单在用
 *
 * 从接口定义出发往上找引用方，经过的文件落在哪些菜单的范围里（profile 的 menus），就是哪些菜单在用。
 * menus 里具体菜单写路由对应的页面入口文件（不写整个目录：放在 A 菜单目录下的共享组件可能是 B 菜单在用）。
 *
 * 往上找的规则：
 * - 按名字追：一个文件引用了另一个文件里的哪些名字，才算引用它（顺着 export ... from 直接连到真正定义的文件）。
 *   不按文件连：汇总导出的文件（@/mixins/index.js）几乎被每个页面引用，按文件连会摊到所有菜单
 * - 碰到任何菜单的文件就记下、不再往上：具体菜单写的是页面入口，再往上只会经过路由走到入口；
 *   global: true 的菜单（布局、入口、启动配置、状态管理）被所有 api 文件间接引用，从它们往上会摊到所有菜单。
 *   没碰到菜单的文件（组件、工具）继续往上，所以共享组件会找到每个用到它的页面
 * - 具体菜单和全局菜单都记：既有页面在用、布局（顶部栏）也在用的接口两个都写。一个文件同时落在多个 global 菜单里时取配置里靠前的
 * - 都找不到时返回空：引用链断在动态加载、状态管理的字符串派发等看不到的地方，报告里写明「未归属」，不猜
 */
import { buildLookup, resolveSpec } from '../collect/path-refs.js'
import { globToRegExp } from '../collect/glob-imports.js'
import { MODULE, TEMPLATE } from './extract.js'

/**
 * @param {object} opts
 * @param {object[]} opts.parsed       extractFile 的结果
 * @param {Map<string, object>} opts.unreachable  走不到的文件
 * @param {Record<string, string>} opts.aliases
 * @param {{name: string, files: string[], global?: boolean}[]} opts.menus
 * @param {Map<string, {from: string}[]>} opts.callers  findCallers 的结果：「文件#名字」→ 引用它的文件（已顺着重新导出）
 * @param {Map<string, {from: string}[]>} [opts.tagUses]  全局组件文件 → 模板里用到它的文件
 * @returns {(start: string[], def?: {file: string, fn: string}) => {menus: string[], global: boolean}}
 *   从一组文件出发找到的菜单；传了 def 时，起点里的 Vuex 模块按 action 换成派发这个 action 的文件
 */
export function createMenuFinder({ parsed, unreachable, aliases, menus, callers, tagUses = new Map() }) {
  const matchers = menus.map((m) => ({ name: m.name, global: Boolean(m.global), res: m.files.map(globToRegExp) }))
  const specificOf = (file) => matchers.filter((m) => !m.global && m.res.some((re) => re.test(file)))
  const globalOf = (file) => matchers.find((m) => m.global && m.res.some((re) => re.test(file))) ?? null

  // 反向引用：文件 → 引用它的文件。按名字连（callers 已经顺着重新导出连到真正定义的文件）
  const importers = new Map()
  const link = (target, from) => {
    if (!target || target === from) return
    const set = importers.get(target) ?? new Set()
    set.add(from)
    importers.set(target, set)
  }
  for (const [key, list] of callers) {
    const file = key.slice(0, key.lastIndexOf('#'))
    for (const c of list) link(file, c.from)
  }
  // 只为副作用引入（import './x'，没有名字）：按文件连
  const lookup = buildLookup(parsed.map((p) => p.path))
  for (const p of parsed) {
    if (unreachable.has(p.path)) continue
    for (const imp of p.imports) {
      if (imp.specifiers.length > 0) continue
      const r = resolveSpec(imp.source, p.path, aliases)
      link(r === null ? null : (lookup.get(r) ?? [])[0], p.path)
    }
  }
  for (const [file, uses] of tagUses) for (const u of uses) if (!unreachable.has(u.from)) link(file, u.from)

  // 写死路径的 import('...')：按文件连
  for (const p of parsed) {
    if (unreachable.has(p.path)) continue
    for (const spec of p.dynamicImports ?? []) {
      const r = resolveSpec(spec, p.path, aliases)
      link(r === null ? null : (lookup.get(r) ?? [])[0], p.path)
    }
  }
  // Vuex：命名空间 → 模块文件（顺着 modules: { ns: 模块 } 的注册一层层找），用到命名空间的文件连到模块文件
  const vuex = vuexModuleResolver({ parsed, aliases, lookup })
  const actionUsers = new Map() // ns/action → 派发它的文件
  for (const p of parsed) {
    if (unreachable.has(p.path)) continue
    for (const ns of p.storeUses ?? []) link(vuex.fileOf(ns), p.path)
    for (const a of p.storeActionUses ?? []) {
      const set = actionUsers.get(a) ?? new Set()
      set.add(p.path)
      actionUsers.set(a, set)
    }
  }
  const byPath = new Map(parsed.map((p) => [p.path, p]))
  /**
   * 起点里的 Vuex 模块：找出哪些 action 用了定义所在的函数，换成派发这些 action 的文件；
   * 找不到（不在 action 里、没有页面直接派发）时保留模块本身，按命名空间连
   */
  const refine = (start, def) => {
    const owner = def.fn.split('、')[0]
    return start.flatMap((f) => {
      const p = byPath.get(f)
      const ns = vuex.nsOf(f)
      if (!p?.storeActions?.length || !ns) return [f]
      // 模块里引入定义所在函数的本地名：来源是定义文件，或者是项目里的其他模块（经汇总文件 export ... from 转出来的）
      const locals = p.imports
        .filter((i) => { const t = resolveTo(i.source, f); return t === def.file || (t !== null && i.specifiers.some((sp) => sp.imported === owner)) })
        .flatMap((i) => i.specifiers.filter((sp) => sp.imported === owner || (sp.imported === '*' && resolveTo(i.source, f) === def.file)).map((sp) => sp.local))
      const actions = p.storeActions.filter((a) => a.refs.some((r) => locals.includes(r)))
      const users = [...new Set(actions.flatMap((a) => [...(actionUsers.get(`${ns}/${a.name}`) ?? [])]))]
      return users.length > 0 ? users : [f]
    })
  }
  const resolveTo = (spec, from) => {
    const r = resolveSpec(spec, from, aliases)
    return r === null ? null : (lookup.get(r) ?? [])[0] ?? null
  }

  return (startFiles, def) => {
    const start = def ? refine(startFiles, def) : startFiles
    const specific = new Set()
    const global = new Set()
    const seen = new Set()
    const queue = [...start]
    while (queue.length > 0) {
      const f = queue.shift()
      if (seen.has(f)) continue
      seen.add(f)
      const sp = specificOf(f)
      if (sp.length > 0) {
        for (const m of sp) specific.add(m.name)
        continue // 页面入口：不再往上
      }
      const g = globalOf(f)
      if (g) {
        global.add(g.name)
        continue // 全局类的文件：不再往上
      }
      for (const up of importers.get(f) ?? []) if (!seen.has(up)) queue.push(up)
    }
    return { menus: order(new Set([...specific, ...global]), matchers), global: specific.size === 0 && global.size > 0 }
  }
}

/**
 * Vuex 的命名空间 → 模块文件：从没有被别的模块注册过的注册表（根 store）开始，按 a/b/c 一层层找；
 * 找不到完整路径时用能找到的最深的那一层
 */
function vuexModuleResolver({ parsed, aliases, lookup }) {
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
  const walk = (file, prefix, depth) => {
    if (depth > 10) return
    for (const [name, target] of registry.get(file) ?? []) {
      const ns = prefix ? `${prefix}/${name}` : name
      if (!nsMap.has(target)) nsMap.set(target, ns)
      walk(target, ns, depth + 1)
    }
  }
  for (const r of roots) walk(r, '', 0)
  return {
    nsOf: (file) => nsMap.get(file) ?? null,
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

/**
 * 一处在用的定义从哪些文件开始往上找：组件模板、模块顶层、组件本身 → 定义所在的文件；
 * 导出的函数 → import 了它的文件，再加上同一个文件里（间接）调用它的函数的引用方
 * （uploadForX() 内部调用 upload()，用 uploadForX 的页面也在用这个接口）；都没有时 → 定义所在的文件
 * @param {{file: string, fn: string}} def
 * @param {Map<string, {from: string}[]>} callers  findCallers 的结果
 * @param {Map<string, {bindings: Map<string, {refs: Set<string>}>}>} [byPath] extractFile 的结果，按文件
 */
export function startFiles(def, callers, byPath = new Map()) {
  const owner = def.fn.split('、')[0]
  if (owner === MODULE || owner === TEMPLATE || owner === 'default') return [def.file]
  // 同文件里引用了它的顶层名字（传递）
  const names = new Set([owner])
  const bindings = byPath.get(def.file)?.bindings ?? new Map()
  for (let changed = true; changed;) {
    changed = false
    for (const [name, b] of bindings) {
      if (!names.has(name) && [...b.refs].some((r) => names.has(r))) {
        names.add(name)
        changed = true
      }
    }
  }
  const internal = [...names].some((n) => n === MODULE || n === TEMPLATE || n === 'default')
  const cs = [...names].flatMap((n) => (callers.get(`${def.file}#${n}`) ?? []).map((c) => c.from))
  const out = [...new Set(cs)]
  if (internal || out.length === 0) out.push(def.file)
  return out
}
