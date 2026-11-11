/**
 * code-audit api：接口维度。找出项目里定义的每个接口（方法 + 路径），判断在不在用，写明依据
 *
 * 步骤：
 * 1. 跑一遍文件维度的 scan：得到从入口走不到的文件和它们的状态（pending、unknown 等照搬），
 *    同时让 knip 报出没人用的导出
 * 2. 按规则文件（profile 的 api）解析每个源码文件，找出接口定义：在哪个顶层函数里、方法、路径
 * 3. 定义在不在用：所在文件走得到，并且所在的顶层函数在用——导出被用到（knip），
 *    或者被同文件里在用的代码调用（本文件内部在用）；模块顶层、组件模板里的直接算在用
 * 4. 按「方法 + 路径」汇总：有一处定义在用就算在用；SDK 内置的接口按规则里的 via 判断
 * 5. 覆盖报告：像请求却没有规则命中的调用、算不出地址的定义、解析失败的文件，交给人或模型补规则
 *
 * 只读：分析提交里的代码，导出到系统临时目录
 */
import { readFileSync } from 'node:fs'
import { SFC_EXTENSIONS } from '../collect/source-text.js'
import { join } from 'node:path'
import { DEFAULT_CONFIG } from '../core/config.js'
import { TOOL } from '../core/tool.js'
import { scan as scanFiles } from '../collect/scan.js'
import { findKnip, runKnip } from '../collect/knip.js'
import { createSnapshot } from '../collect/snapshot.js'
import { buildLookup, resolveSpec } from '../collect/path-refs.js'
import { compileCalls } from './rules.js'
import { extractFile, loadParser, MODULE, TEMPLATE } from './extract.js'
import { endpointKey, isExternalPath, mayHit } from './normalize.js'
import { createMenuFinder, vuexModuleResolver } from './menus.js'
import { WHOLE_STORE } from './stores.js'
import { findGlobalComponents, findTagUses } from '../collect/global-components.js'

export const API_SCHEMA_VERSION = 1

/**
 * 接口的状态：顺序就是优先级（越不敢删的越优先），和文件维度的状态一致，多了 sdk
 * - sdk  SDK 内部发的请求，项目代码里没有引用 SDK 的对应功能。SDK 要保持完整，不能删
 */
export const API_STATUSES = ['unknown', 'external', 'pending', 'dormant', 'sdk', 'live', 'test-only', 'dead-only-ref', 'dead']

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.project
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @param {string} [opts.rev]
 * @param {string} [opts.knipDir]
 * @param {typeof runKnip} [opts.run]
 */
export function scanApi({ root, project, config = DEFAULT_CONFIG, rev = 'HEAD', knipDir, run = runKnip }) {
  if (!config.api) throw new Error('profile 里没有 api 规则：先写清楚请求是怎么发出去的（api.calls），见 profiles/example.js')
  const calls = compileCalls(config.api)

  // 1. 文件维度：测试入口不算（测试里调用的接口不是业务在用）
  let lastRun = null
  const capture = (args) => {
    lastRun = run({ ...args, exports: true })
    return lastRun
  }
  const files = scanFiles({ root, project, config: { ...config, testEntries: [] }, rev, knipDir, run: capture })
  const commit = files.candidates.rev
  // 走不到的文件：以 knip 的结果为准（scanIgnore 匹配的文件不列为候选，但同样走不到）；有候选状态的用候选的
  const candidateOf = new Map(files.candidates.files.map((f) => [f.file, f]))
  const unreachable = new Map(lastRun.unusedFiles.map((f) => [f, candidateOf.get(f) ?? { file: f, status: 'dead', evidence: [{ detail: '从入口走不到（scanIgnore 匹配，没有列为文件候选）' }] }]))
  const unusedExports = lastRun.unusedExports ?? new Map()

  // 2. 解析源码
  const knip = findKnip(knipDir)
  const parser = loadParser(knip.dir)
  const snap = createSnapshot(root, commit)
  let parsed
  let tagUses = new Map()
  try {
    // 测试文件不分析：测试里的地址不是业务在用的接口
    const tests = new Set(snap.list(config.testEntries.map((p) => `:(glob)${p}`)))
    const sources = snap.list(config.sourceRoots).filter((f) => config.extensions.some((e) => f.endsWith(e)) && !f.endsWith('.d.ts') && !tests.has(f))
    // 全局组件的声明文件（components.d.ts 等）：只在模板里写标签的组件靠它连上引用方，菜单归属要用
    const declarations = config.menus.length > 0 ? snap.list(config.sourceRoots).filter((f) => f.endsWith('.d.ts')) : []
    snap.extract([...sources, ...declarations])
    const contents = sources.map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') }))
    if (declarations.length > 0) {
      const globals = findGlobalComponents({ files: declarations.map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') })), sourceSet: new Set(sources), aliases: config.aliases })
      tagUses = findTagUses({ files: contents, components: globals.components })
    }
    parsed = contents.map(({ path, content }) => extractFile({
      parser,
      path,
      content,
      calls,
      attrs: config.api.attrs ?? [],
      prefixes: config.api.prefixes ?? [],
      ignoreCalls: config.api.ignoreCalls ?? [],
      consts: config.api.consts ?? []
    }))
  } finally {
    snap.cleanup()
  }
  // 3. 每个走得到的文件里，哪些顶层名字在用
  const usedNames = new Map()
  for (const p of parsed) {
    if (unreachable.has(p.path)) continue
    usedNames.set(p.path, usedBindings(p, unusedExports.get(p.path) ?? new Set()))
  }

  // 引用方：谁 import 了定义所在的函数（只用于展示，不影响状态）
  const callers = findCallers({ parsed, unreachable, aliases: config.aliases })
  // 走不到的文件里的引用方：没人用的定义「仍被没人用的文件引用」，history 要查的是这些文件什么时候失去入口
  const deadCallers = findCallers({ parsed, unreachable, aliases: config.aliases, onlyUnreachable: true })
  // 请求写在 store 的 action 里：store 在用、这个 action 没人调用的，定义判没人用
  const actionState = createActionChecker({ parsed, unreachable, callers, aliases: config.aliases })

  // 4. 定义 → 接口
  const wrapperNames = new Set(calls.map((c) => c.steps[0].name))
  const coverage = { suspects: [], dynamic: [], wrappers: [], unknownMethod: [], parseErrors: [], unusedManual: [], unusedReviewed: [] }
  const manual = config.api.manual ?? []
  const reviewed = config.api.reviewedDynamic ?? []
  const usedManual = new Set()
  const usedReviewed = new Set()
  const endpoints = new Map()
  const addDef = (key, method, path, def) => {
    let ep = endpoints.get(key)
    if (!ep) {
      ep = { key, method, path, definitions: [] }
      endpoints.set(key, ep)
    }
    ep.definitions.push(def)
  }

  for (const p of parsed) {
    for (const e of p.errors) coverage.parseErrors.push({ from: p.path, message: e })
    const fileState = unreachable.get(p.path)
    for (const s of p.suspects) {
      if (fileState && ['dead', 'dead-only-ref'].includes(fileState.status)) continue // 没人用的文件里的不用补规则
      if (s.owners.some((o) => wrapperNames.has(o))) continue // 规则里的封装函数自己的实现
      coverage.suspects.push({ from: p.path, line: s.line, fn: fnName(s.owners), shape: s.shape, text: s.text })
    }
    for (const s of p.sites) {
      const fn = fnName(s.owners)
      let state = defState(p.path, s.owners, fileState, usedNames.get(p.path))
      if (state.status === 'live' && !fileState) state = actionState(p, s) ?? state
      let method = s.method
      let path = s.path
      let rule = s.rule
      let note = null
      if (path === null) {
        const m = manual.findIndex((x) => x.from === p.path && s.owners.includes(x.fn))
        if (m !== -1) {
          usedManual.add(m)
          method = manual[m].method
          path = manual[m].path
          rule = 'manual'
          note = manual[m].reason
        } else if (s.fromParam && s.owners.some((o) => wrapperNames.has(o))) {
          continue // 封装函数自己的实现：地址由调用方传入，调用方那里已经按规则认出来了
        } else {
          const r = reviewed.findIndex((x) => x.from === p.path && s.owners.includes(x.fn))
          if (r !== -1) {
            usedReviewed.add(r)
            continue
          }
          if (fileState && ['dead', 'dead-only-ref'].includes(fileState.status)) continue
          if (s.fromParam) coverage.wrappers.push({ from: p.path, line: s.line, fn, param: s.fromParam, rule: s.rule })
          else coverage.dynamic.push({ from: p.path, line: s.line, fn, rule: s.rule, raw: s.raw, ...(s.partial ? { partial: true } : {}) })
          continue
        }
      }
      if (method === null) {
        // 写了方法但算不出：不知道是哪个接口。记进覆盖报告；同一路径的接口在下面判为 unknown
        if (!(fileState && ['dead', 'dead-only-ref'].includes(fileState.status))) coverage.unknownMethod.push({ from: p.path, line: s.line, fn, rule, path, live: state.status === 'live' })
        continue
      }
      const dc = state.status === 'live' ? [] : (deadCallers.get(`${p.path}#${s.owners[0]}`) ?? []).map((c) => c.from).filter((f) => f !== p.path)
      addDef(endpointKey(method, path), method, path, { file: p.path, line: s.line, fn, rule, raw: s.raw, state: state.status, reason: state.reason, ...(note ? { note } : {}), ...(dc.length > 0 ? { deadCallers: dc } : {}) })
    }
  }
  manual.forEach((m, i) => usedManual.has(i) || coverage.unusedManual.push(m))
  reviewed.forEach((r, i) => usedReviewed.has(i) || coverage.unusedReviewed.push(r))

  // SDK 内置的接口
  const sdkRefs = findSdkRefs({ parsed, usedNames, sdk: config.api.sdk ?? [] })
  for (const s of config.api.sdk ?? []) {
    const key = endpointKey(s.method, s.path)
    if (!endpoints.has(key)) endpoints.set(key, { key, method: s.method, path: s.path, definitions: [] })
    const ep = endpoints.get(key)
    const refs = (sdkRefs.get(`${key}#${s.package}`) ?? [])
    if (!ep.sdk) ep.sdk = { package: s.package, ...(s.note ? { note: s.note } : {}), refs }
    else {
      // 同一个接口由多个 SDK 包发出（如登录页组件和登录逻辑都会调用）：合并
      if (!ep.sdk.package.split('、').includes(s.package)) ep.sdk.package += `、${s.package}`
      for (const r of refs) if (!ep.sdk.refs.some((x) => x.from === r.from && x.name === r.name)) ep.sdk.refs.push(r)
    }
  }

  // 5. 状态
  let list = [...endpoints.values()].map((ep) => finishEndpoint(ep, callers))
  list = list.map((ep) => guardDeadEndpoint(ep, list, coverage))
  // 菜单归属：配置了 menus 才算；在用的接口从在用的定义（SDK 接口从引用 SDK 功能的文件）往上找
  if (config.menus.length > 0) {
    const findMenus = createMenuFinder({ parsed, unreachable, aliases: config.aliases, menus: config.menus, callers, tagUses })
    list = list.map((ep) => {
      if (ep.status !== 'live') return ep
      const names = new Set()
      for (const d of ep.definitions.filter((x) => x.state === 'live')) for (const m of findMenus(null, d).menus) names.add(m)
      // SDK：从引用 SDK 功能的文件里用到它的顶层名字出发
      if (ep.sdk?.refs?.length) for (const m of findMenus(ep.sdk.refs.flatMap((r) => (r.by?.length ? r.by.map((o) => [r.from, o]) : [r.from]))).menus) names.add(m)
      const ordered = config.menus.map((m) => m.name).filter((n) => names.has(n))
      return { ...ep, menus: ordered }
    })
  }
  list = list.sort((a, b) => (a.path === b.path ? a.method.localeCompare(b.method) : a.path.localeCompare(b.path)))
  const byStatus = {}
  for (const ep of list) byStatus[ep.status] = (byStatus[ep.status] ?? 0) + 1

  return {
    version: API_SCHEMA_VERSION,
    kind: 'api',
    generatedAt: new Date().toISOString(),
    tool: { ...TOOL },
    project: { name: project, root, rev: commit, entries: [...config.entries] },
    rules: { version: config.api.version },
    summary: { endpoints: list.length, byStatus, files: parsed.length },
    endpoints: list,
    coverage
  }
}

function fnName(owners) {
  return owners.join('、')
}

/** 文件里在用的顶层名字：导出被用到的、模块顶层执行的、模板，再顺着同文件里的引用传递；单文件组件的顶层名字都算在用 */
export function usedBindings(p, unused) {
  const used = new Set([MODULE, TEMPLATE])
  const sfc = SFC_EXTENSIONS.some((e) => p.path.endsWith(e))
  for (const [name, b] of p.bindings) {
    // 单文件组件：模板可以直接用脚本里的顶层名字（Vue 的 <script setup>、Svelte），模板里的用法这里看不到，
    // 文件走得到就都算在用（偏保守，不会误判成没人用）；组件本身（default）同理
    if (sfc) used.add(name)
    else if (b.exported.size > 0 && [...b.exported].some((e) => !unused.has(e))) used.add(name)
  }
  const queue = [...used]
  while (queue.length > 0) {
    const name = queue.pop()
    for (const r of p.bindings.get(name)?.refs ?? []) {
      if (!used.has(r)) {
        used.add(r)
        queue.push(r)
      }
    }
  }
  return used
}

/**
 * store 的 action 有没有人调用（请求写在 action 里时）。看不清的返回 null（按 store 判断，不改）
 * - Pinia：所有走得到的文件里，按名字（导出名、各引用方里的本地名，都要是 use 开头）汇总 useX() 的用法；
 *   有看不清的用法（整个 store 被传走等）、store 在自己文件里被别的代码用到，都不判
 * - Vuex：模块要能从注册关系算出命名空间；项目里有算不出类型的派发（dispatch(变量)、mapActions(变量)）时都不判；
 *   不带命名空间的同名派发（dispatch('a')）也算调用了
 */
export function createActionChecker({ parsed, unreachable, callers, aliases }) {
  const live = parsed.filter((p) => !unreachable.has(p.path))
  const usesByName = new Map()
  const dispatch = { plain: new Set(), ns: new Set(), dynamic: false, where: null }
  for (const p of live) {
    for (const [n, set] of p.piniaUses ?? []) usesByName.set(n, new Set([...(usesByName.get(n) ?? []), ...set]))
    for (const a of p.storeDispatch?.plain ?? []) dispatch.plain.add(a)
    for (const a of p.storeActionUses ?? []) dispatch.ns.add(a)
    if (p.storeDispatch?.dynamic && !dispatch.dynamic) {
      dispatch.dynamic = true
      dispatch.where = p.path
    }
  }
  const vuex = vuexModuleResolver({ parsed, aliases, lookup: buildLookup(parsed.map((p) => p.path)) })
  const isUse = (n) => /^use[A-Z0-9_$]/.test(n)
  return (p, site) => {
    if (site.storeActions && site.store) {
      const b = site.store
      if ([...p.bindings].some(([n, x]) => n !== b && x.refs.has(b))) return null
      const names = new Set([...(p.bindings.get(b)?.exported ?? [])].filter((e) => e !== 'default'))
      if (b !== 'default') names.add(b)
      for (const c of callers.get(`${p.path}#${b}`) ?? []) for (const l of c.locals) names.add(l)
      if (names.size === 0 || [...names].some((n) => !isUse(n))) return null
      const used = new Set([...names].flatMap((n) => [...(usesByName.get(n) ?? [])]))
      if (used.has(WHOLE_STORE) || site.storeActions.some((a) => used.has(a))) return null
      const what = site.storeActions.length > 0 ? `走到这里的 action（${site.storeActions.join('、')}）没有地方调用` : '这段代码不在任何对外交出的 action 里，也没有被它们调用'
      return { status: 'dead', reason: `store ${b} 在用，但${what}（找过 ${[...names].join('、')}() 的成员调用、解构、mapActions、模板里的写法）` }
    }
    if (site.vuexAction) {
      const all = vuex.nsAll(p.path)
      if (all.length === 0 || dispatch.dynamic) return null
      const ns = all.join('、')
      const a = site.vuexAction
      if (dispatch.plain.has(a) || all.some((n) => dispatch.ns.has(`${n}/${a}`))) return null
      return { status: 'dead', reason: `Vuex 模块 ${ns} 在用，但 action ${a} 没有地方派发（找过 dispatch('${all[0]}/${a}')、mapActions('${all[0]}', [...])、不带命名空间的 dispatch('${a}')）` }
    }
    return null
  }
}

function defState(file, owners, fileState, used) {
  if (fileState) {
    const reason = fileState.evidence?.map((e) => e.detail).filter(Boolean).slice(-1)[0] ?? '所在文件从入口走不到'
    return { status: fileState.status, reason: `所在文件 ${file} 判为 ${fileState.status}：${reason}` }
  }
  if (owners.some((o) => used.has(o))) {
    const o = owners.find((x) => used.has(x))
    return { status: 'live', reason: o === MODULE ? '在模块顶层执行' : o === TEMPLATE ? '写在组件模板里' : `${o} 在用` }
  }
  return { status: 'dead', reason: `${owners.join('、')} 没人用：文件走得到，但没有被引用的导出（knip），本文件里也没有在用的代码调用它` }
}

/**
 * 判为没人用的接口，可能其实被别处调用着（看不准的不判死）：
 * - 有在用的接口路径里拼了变量（/api/{}/list），可能调用的就是这个固定路径（/api/user/list）
 * - 同一路径有方法算不出的在用调用
 * 都改判 unknown，证据写明是哪一处
 */
function guardDeadEndpoint(ep, all, coverage) {
  if (!['dead', 'dead-only-ref', 'test-only'].includes(ep.status)) return ep
  const hits = all.filter((o) => o.status === 'live' && o.method === ep.method && mayHit(o.path, ep.path))
  const methodless = coverage.unknownMethod.filter((u) => u.live && (u.path === ep.path || (u.path && mayHit(u.path, ep.path))))
  if (hits.length === 0 && methodless.length === 0) return ep
  const evidence = [...ep.evidence]
  for (const h of hits) evidence.unshift({ rule: 'maybe-dynamic-hit', detail: `在用的 ${h.key} 路径里拼了变量，可能调用的就是 ${ep.path}（${h.definitions.filter((d) => d.state === 'live').map((d) => `${d.file}:${d.line}`).join('、')}）` })
  for (const u of methodless) evidence.unshift({ rule: 'maybe-unknown-method', detail: `${u.from}:${u.line} ${u.fn} 调用 ${u.path} 时方法算不出，可能就是这个接口` })
  return { ...ep, status: 'unknown', evidence }
}

function finishEndpoint(ep, callers) {
  const evidence = []
  let status
  const live = ep.definitions.filter((d) => d.state === 'live')
  if (live.length > 0) {
    status = 'live'
    evidence.push({ rule: 'def-live', detail: `${live.length} 处定义在用：${live.map((d) => `${d.file}:${d.line}（${d.reason}）`).join('；')}` })
  } else if (ep.sdk && ep.sdk.refs.length > 0) {
    status = 'live'
    evidence.push({ rule: 'sdk-used', detail: `SDK ${ep.sdk.package} 的功能被引用：${ep.sdk.refs.map((r) => `${r.from}（${r.name}）`).join('；')}` })
  } else if (ep.sdk) {
    status = 'sdk'
    evidence.push({ rule: 'sdk-kept', detail: `SDK ${ep.sdk.package} 内部发的请求${ep.sdk.note ? `（${ep.sdk.note}）` : ''}。项目没有引用对应功能，但 SDK 要保持完整，保留` })
  } else {
    status = ep.definitions.map((d) => d.state).sort((a, b) => API_STATUSES.indexOf(a) - API_STATUSES.indexOf(b))[0]
    for (const d of ep.definitions) evidence.push({ rule: `def-${d.state}`, detail: `${d.file}:${d.line} ${d.fn}：${d.reason}` })
  }
  // 完整网址：多半是第三方服务。不在用也不能当成自家后端「可以删」的接口：状态改为 external（图外），报告里归为高风险
  if (isExternalPath(ep.path)) {
    evidence.unshift({ rule: 'external-host', detail: '写的是完整网址（//主机/路径），多半是第三方服务，不是自家后端的接口，不在后端删除范围' })
    if (status !== 'live') status = 'external'
  }
  if (ep.sdk && ep.definitions.length > 0 && status === 'live' && live.length === 0) {
    // 项目里也有定义但没人用：照样列出
    for (const d of ep.definitions) evidence.push({ rule: `def-${d.state}`, detail: `${d.file}:${d.line} ${d.fn}：${d.reason}` })
  }
  const cs = []
  for (const d of ep.definitions) {
    for (const c of callers.get(`${d.file}#${d.fn.split('、')[0]}`) ?? []) {
      if (!cs.some((x) => x.from === c.from)) cs.push(c)
    }
  }
  return { key: ep.key, method: ep.method, path: ep.path, status, evidence, definitions: ep.definitions, callers: cs.sort((a, b) => a.from.localeCompare(b.from)), ...(ep.sdk ? { sdk: ep.sdk } : {}) }
}

/**
 * 引用方：走得到的文件里，谁 import 了「文件#顶层名字」。顺着重新导出（export ... from）找，最多 5 层
 * @returns {Map<string, {from: string, name: string}[]>}
 */
export function findCallers({ parsed, unreachable, aliases, onlyUnreachable = false }) {
  const lookup = buildLookup(parsed.map((p) => p.path))
  const byFile = new Map(parsed.map((p) => [p.path, p]))
  const resolveModule = (spec, from) => {
    const r = resolveSpec(spec, from, aliases)
    if (r === null) return null
    return (lookup.get(r) ?? [])[0] ?? null
  }
  /** 模块 file 导出的 name 实际定义在哪：[文件, 本地名] */
  const origin = (file, name, depth = 0) => {
    const p = byFile.get(file)
    if (!p || depth > 5) return []
    for (const [local, b] of p.bindings) if (b.exported.has(name)) return [[file, local]]
    // 单文件组件的默认导入就是组件本身（<script setup> 没有写 export default）
    if (name === 'default' && SFC_EXTENSIONS.some((e) => file.endsWith(e))) return [[file, 'default']]
    const out = []
    for (const re of p.reexports) {
      const target = resolveModule(re.source, file)
      if (!target) continue
      if (re.exported === name && re.imported !== '*') out.push(...origin(target, re.imported, depth + 1))
      else if (re.exported === name && re.imported === '*') out.push(...allExports(target, depth + 1))
      else if (re.exported === '*' && re.imported === '*' && name !== 'default') out.push(...origin(target, name, depth + 1))
    }
    return out
  }
  const allExports = (file, depth = 0) => {
    const p = byFile.get(file)
    if (!p || depth > 5) return []
    const out = []
    for (const [local, b] of p.bindings) if (b.exported.size > 0) out.push([file, local])
    for (const re of p.reexports) {
      const target = resolveModule(re.source, file)
      if (!target) continue
      if (re.imported === '*') out.push(...allExports(target, depth + 1))
      else out.push(...origin(target, re.imported, depth + 1))
    }
    return out
  }
  const result = new Map()
  for (const p of parsed) {
    if (unreachable.has(p.path) !== onlyUnreachable) continue
    for (const imp of p.imports) {
      const target = resolveModule(imp.source, p.path)
      if (!target) continue
      for (const s of imp.specifiers) {
        const defs = s.imported === '*' ? allExports(target) : origin(target, s.imported)
        for (const [file, local] of defs) {
          const key = `${file}#${local}`
          const list = result.get(key) ?? []
          // locals：在引用方里叫什么（命名空间导入写成 ns.*），菜单归属按它找引用方里哪些代码在用
          const localName = s.imported === '*' ? `${s.local}.*` : s.local
          const hit = list.find((c) => c.from === p.path)
          if (hit) {
            if (!hit.locals.includes(localName)) hit.locals.push(localName)
          } else list.push({ from: p.path, name: s.imported === '*' ? `* as ${s.local}` : s.imported, locals: [localName] })
          result.set(key, list)
        }
      }
    }
  }
  return result
}

/**
 * SDK 的功能有没有被在用的代码引用：走得到的文件 import 了 via 里的名字，并且引用它的顶层名字在用
 * （只 import 不用、或者创建出来的对象没人用，都不算）
 */
function findSdkRefs({ parsed, usedNames, sdk }) {
  const out = new Map()
  for (const s of sdk) {
    const key = endpointKey(s.method, s.path)
    const refs = []
    for (const p of parsed) {
      const used = usedNames.get(p.path)
      if (!used) continue
      for (const imp of p.imports) {
        if (imp.source !== s.package && !imp.source.startsWith(`${s.package}/`)) continue
        for (const sp of imp.specifiers) {
          for (const via of s.via ?? []) {
            const [name, member] = via.split('.')
            let key = null
            if (name === sp.imported) key = member ? `${sp.local}.${member}` : sp.local // import { createAuth }
            else if (sp.imported === '*' || sp.imported === 'default') key = `${sp.local}.${via}` // import * as Sdk / import Sdk：Sdk.createAuth
            if (key === null) continue
            const owners = [...(p.importUses.get(key) ?? [])].filter((o) => used.has(o))
            if (owners.length > 0 && !refs.some((r) => r.from === p.path && r.name === via)) refs.push({ from: p.path, name: via, by: owners })
          }
        }
      }
    }
    out.set(`${key}#${s.package}`, refs)
  }
  return out
}

