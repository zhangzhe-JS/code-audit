/**
 * 解析一个源码文件，找出里面的接口定义（按规则文件的请求写法）
 *
 * 用 oxc-parser 解析（knip 自带的依赖，不另外安装）。单文件组件只解析 <script>，模板里只认规则写明的属性（如上传组件的 action）。
 * 对每个文件输出：
 * - sites     命中请求写法的调用：在哪个顶层函数里、方法、原始地址、归一化后的路径
 * - suspects  像请求、但没有任何写法命中的调用（地址参数长得像接口路径），写进覆盖报告，交给人或模型补规则
 * - bindings  顶层名字：导出成什么名字、引用了同文件的哪些顶层名字（用来判断「本文件内部在用」）
 * - imports / reexports  用来找引用方
 */
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { scriptOnly, SFC_EXTENSIONS } from '../collect/source-text.js'
import { evaluateUrl } from './evaluate.js'
import { normalizePath } from './normalize.js'
import { callShape, flattenCall, matchTemplate } from './template.js'

/** 模块顶层执行的代码（不在任何函数里）：文件被加载就会运行 */
export const MODULE = '<module>'
/** 单文件组件的模板 */
export const TEMPLATE = '<template>'

/** 默认不算疑似请求的调用：路由跳转、路径拼接、国际化等，参数也长得像路径 */
export const DEFAULT_IGNORE_CALLS = Object.freeze([
  'import', 'require', 'require.resolve', 'import.meta.glob', 'defineAsyncComponent',
  '*.push', '*.replace', 'router.*', '*.$router.*', 'useRouter', 'navigateTo',
  'path.*', 'posix.*', 'console.*', 'window.open', 'open', 'location.*', 'window.location.*',
  't', '$t', '*.$t', '*.t', 'i18n.*', '*.includes', '*.startsWith', '*.endsWith', '*.indexOf', '*.split', '*.match', '*.test',
  'commit', 'dispatch', '*.commit', '*.dispatch', // Vuex：参数是 模块/动作 名
  'expect', 'expect.*', 'vi.*', 'jest.*', // 测试断言
  '*.toDataURL', '*.toBlob',
  // JS 内置的转换、编码：String(env.BASE || '/x') 这类的参数也像路径
  'String', 'Number', 'Boolean', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI', 'JSON.*', 'Object.*', 'Array.*'
])

let oxcParser = null
/**
 * 加载 oxc-parser：它是 knip 的依赖，从 knip 的安装目录解析
 * @param {string} knipDir
 */
export function loadParser(knipDir) {
  if (!oxcParser) {
    const require = createRequire(join(knipDir, 'package.json'))
    oxcParser = require('oxc-parser')
  }
  return oxcParser
}

/**
 * @typedef {object} CompiledCall
 * @property {string} call       模板原文
 * @property {import('./template.js').Step[]} steps
 * @property {string|null} method 规则里写死的方法
 * @property {string} defaultMethod 模板和规则都没给出方法时用
 */

/**
 * @param {object} opts
 * @param {object} opts.parser  loadParser 的结果
 * @param {string} opts.path    相对仓库根目录
 * @param {string} opts.content
 * @param {CompiledCall[]} opts.calls
 * @param {{tag: string, attr: string, method: string}[]} opts.attrs
 * @param {string[]} opts.prefixes
 * @param {string[]} opts.ignoreCalls 规则里补充的（会和默认的合并）
 * @param {{name: string, method: string, from?: string}[]} [opts.consts] 写着接口地址的顶层常量
 */
export function extractFile({ parser, path, content, calls, attrs = [], prefixes = [], ignoreCalls = [], consts: addressConsts = [] }) {
  const isSfc = SFC_EXTENSIONS.some((e) => path.endsWith(e))
  const code = isSfc ? scriptOnly(content) : content
  const lines = lineStarts(code)
  const lineOf = (pos) => upperBound(lines, pos)
  // importUses：导入的名字（本地名）被哪些顶层名字引用（SDK 的功能有没有被在用的代码引用）
  // dynamicImports：写死路径的 import('...')（异步组件等），菜单归属用来连引用
  // storeUses：用到的 Vuex 命名空间（dispatch('ns/x')、mapActions('ns') 等）；storeModules：这个文件里注册的 Vuex 模块（modules: { ns: 模块 }）
  // storeActionUses：用到的具体 action（ns/action）；storeActions：这个文件里的 Vuex actions 各自引用了哪些导入的名字
  const result = { path, sites: [], suspects: [], bindings: new Map(), imports: [], reexports: [], importUses: new Map(), dynamicImports: [], storeUses: new Set(), storeActionUses: new Set(), storeModules: [], storeActions: [], errors: [] }

  const program = parse(parser, path, code, isSfc ? sfcLang(content) : null, result.errors)
  const ignore = [...DEFAULT_IGNORE_CALLS, ...ignoreCalls].map(globToRegExp)

  if (program) {
    collectTopLevel(program, result)
    collectStoreActions(program, result, parser.visitorKeys)
    const consts = topLevelConsts(program)
    walkProgram({ program, consts, calls, prefixes, ignore, lineOf, result, keys: parser.visitorKeys })
    for (const c of addressConsts) {
      if (c.from && c.from !== path) continue
      const init = consts.get(c.name)
      if (!init) continue
      const url = evaluateUrl(init, { consts, params: new Set() })
      for (const s of sitesFor({ url, methods: [c.method], prefixes })) result.sites.push({ line: lineOf(init.start), owners: [c.name], rule: `const ${c.name}`, ...s })
    }
  }
  if (isSfc && attrs.length > 0) {
    for (const s of templateSites({ content, attrs, prefixes })) result.sites.push(s)
  }
  if (isSfc) {
    // 模板里用到的导入组件：<LoginPanel> / <login-panel>
    const tm = markupOf(content)
    if (tm) {
      for (const imp of result.imports) {
        for (const sp of imp.specifiers) {
          const kebab = sp.local.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
          if (new RegExp(`<(${escapeRe(sp.local)}|${escapeRe(kebab)})[\\s/>]`).test(tm[1])) addUse(result, sp.local, TEMPLATE)
        }
      }
    }
  }
  return result
}

function parse(parser, path, code, sfcLangHint, errors) {
  const langs = sfcLangHint ? [sfcLangHint, 'tsx'] : path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts') ? ['ts'] : path.endsWith('.tsx') ? ['tsx'] : ['js', 'jsx', 'tsx']
  let first = null
  for (const lang of langs) {
    const r = parser.parseSync(path.replace(/\.[^./]+$/, `.${lang}`), code, { lang, sourceType: 'module' })
    if (r.errors.length === 0) return r.program
    first ??= r.errors[0].message
  }
  errors.push(`解析失败：${first}`)
  return null
}

function sfcLang(content) {
  const m = /<script\b[^>]*\blang\s*=\s*["']?(ts|tsx|jsx)\b/i.exec(content)
  return m ? m[1] : 'js'
}

// ---------- 顶层名字、导入导出 ----------

function binding(result, name) {
  let b = result.bindings.get(name)
  if (!b) {
    b = { exported: new Set(), refs: new Set() }
    result.bindings.set(name, b)
  }
  return b
}

function patternNames(p, out = []) {
  if (!p) return out
  if (p.type === 'Identifier') out.push(p.name)
  else if (p.type === 'ObjectPattern') p.properties.forEach((pr) => patternNames(pr.type === 'RestElement' ? pr.argument : pr.value, out))
  else if (p.type === 'ArrayPattern') p.elements.forEach((e) => patternNames(e, out))
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out)
  else if (p.type === 'RestElement') patternNames(p.argument, out)
  else if (p.type === 'TSParameterProperty') patternNames(p.parameter, out)
  return out
}

function declNames(decl) {
  if (!decl) return []
  if (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration' || decl.type === 'TSEnumDeclaration') return decl.id ? [decl.id.name] : []
  if (decl.type === 'VariableDeclaration') return decl.declarations.flatMap((d) => patternNames(d.id))
  return []
}

function moduleName(node) {
  return node.type === 'Identifier' ? node.name : node.type === 'Literal' ? String(node.value) : null
}

function collectTopLevel(program, result) {
  for (const node of program.body) {
    if (node.type === 'ImportDeclaration') {
      if (node.importKind === 'type') continue
      result.imports.push({
        source: node.source.value,
        specifiers: node.specifiers.filter((s) => s.importKind !== 'type').map((s) => ({
          imported: s.type === 'ImportDefaultSpecifier' ? 'default' : s.type === 'ImportNamespaceSpecifier' ? '*' : moduleName(s.imported),
          local: s.local.name
        }))
      })
    } else if (node.type === 'ExportNamedDeclaration') {
      if (node.exportKind === 'type') continue
      if (node.source) {
        for (const s of node.specifiers) result.reexports.push({ source: node.source.value, imported: moduleName(s.local), exported: moduleName(s.exported) })
      } else if (node.declaration) {
        for (const n of declNames(node.declaration)) binding(result, n).exported.add(n)
      } else {
        for (const s of node.specifiers) binding(result, moduleName(s.local)).exported.add(moduleName(s.exported))
      }
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.exportKind === 'type') continue
      result.reexports.push({ source: node.source.value, imported: '*', exported: node.exported ? moduleName(node.exported) : '*' })
    } else if (node.type === 'ExportDefaultDeclaration') {
      binding(result, 'default').exported.add('default')
      const d = node.declaration
      if (d.type === 'Identifier') binding(result, 'default').refs.add(d.name)
    } else {
      for (const n of declNames(node)) binding(result, n)
    }
  }
}

/** 顶层 const 的初始值：地址里用到的常量（含导出的） */
function topLevelConsts(program) {
  const consts = new Map()
  for (const node of program.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    if (decl?.type === 'VariableDeclaration' && decl.kind === 'const') {
      for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.init) consts.set(d.id.name, d.init)
    }
  }
  return consts
}

/** 顶层语句属于哪个名字：函数、变量声明属于它声明的名字；export default 属于 default；其余是模块顶层执行的代码 */
function ownersOf(node) {
  if (node.type === 'ExportNamedDeclaration') return node.declaration ? ownersOf(node.declaration) : []
  if (node.type === 'ExportDefaultDeclaration') return ['default']
  if (node.type === 'ImportDeclaration' || node.type === 'ExportAllDeclaration') return []
  const names = declNames(node)
  if (names.length === 0) return [MODULE]
  // const x = request(...) 这类：声明的同时就执行了，也算模块顶层执行的代码
  if (node.type === 'VariableDeclaration' && node.declarations.some((d) => d.init && hasSideEffects(d.init))) return [...names, MODULE]
  return names
}

/** 变量初始值是不是会立刻执行代码（调用、new）：这种在模块加载时就运行 */
function hasSideEffects(init) {
  return init.type === 'CallExpression' || init.type === 'NewExpression' || init.type === 'AwaitExpression'
}

// ---------- 遍历 ----------

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

function addUse(result, local, owner) {
  const set = result.importUses.get(local) ?? new Set()
  set.add(owner)
  result.importUses.set(local, set)
}

function walkProgram({ program, consts, calls, prefixes, ignore, lineOf, result, keys }) {
  const topNames = new Set(result.bindings.keys())
  const importLocals = new Set(result.imports.flatMap((i) => i.specifiers.map((s) => s.local)))
  for (const node of program.body) {
    const owners = ownersOf(node)
    if (owners.length === 0) continue
    // 引用导入的名字时算在声明的名字上：const x = sdkFn() 只是创建，x 没人用就等于没用
    const useOwners = owners.length > 1 ? owners.filter((o) => o !== MODULE) : owners
    const refs = new Set()
    const consumed = new Set()
    // 作用域链：地址常先赋给局部常量再传进请求（const url = `...`），按真实的作用域查找，内层同名的会遮住外层。
    // 第 0 层是文件顶层的常量；函数、代码块、for、catch 各是一层
    const frames = [{ consts, params: new Set(), opaque: new Set() }]
    const shadowed = (name) => frames.slice(1).some((f) => f.consts.has(name) || f.params.has(name) || f.opaque.has(name))
    const visit = (n, parent, key) => {
      if (!n || typeof n.type !== 'string') return
      if (n.type === 'Identifier') {
        if (isReference(n, parent, key) && !shadowed(n.name)) {
          if (topNames.has(n.name)) refs.add(n.name)
          else if (importLocals.has(n.name)) for (const o of useOwners) addUse(result, n.name, o)
        }
        return
      }
      // 导入对象的成员：Auth.openDialog、Sdk.Auth.openDialog（命名空间导入），最多 3 层；规则里的 via 可以写到成员
      if (n.type === 'MemberExpression') {
        const chain = memberChain(n)
        if (chain && chain.length <= 4 && importLocals.has(chain[0]) && !shadowed(chain[0])) for (const o of useOwners) addUse(result, chain.join('.'), o)
      }
      // 从导入对象解构：const { createAuth } = Sdk
      if (n.type === 'VariableDeclarator' && n.id.type === 'ObjectPattern' && n.init?.type === 'Identifier' && importLocals.has(n.init.name) && !shadowed(n.init.name)) {
        for (const pr of n.id.properties) {
          if (pr.type === 'Property' && !pr.computed && pr.key.type === 'Identifier') for (const o of useOwners) addUse(result, `${n.init.name}.${pr.key.name}`, o)
        }
      }
      collectLinks(n, result)
      const frame = scopeFrame(n, keys)
      if (frame) frames.push(frame)
      if (n.type === 'CallExpression' && !consumed.has(n)) {
        handleCall({ node: n, owners, scope: flattenScope(frames), calls, prefixes, ignore, lineOf, result, consumed })
      }
      for (const k of keys[n.type] ?? Object.keys(n)) {
        const child = n[k]
        if (Array.isArray(child)) child.forEach((c) => visit(c, n, k))
        else if (child && typeof child === 'object') visit(child, n, k)
      }
      if (frame) frames.pop()
    }
    visit(node, null, null)
    for (const o of owners) {
      const b = binding(result, o)
      for (const r of refs) if (r !== o) b.refs.add(r)
    }
  }
}

/**
 * 节点开启的一层作用域：
 * - consts  这一层直接声明的 const 常量（名字 → 初始值），地址可以从这里算出
 * - params  函数参数：地址整个就是参数时，说明是封装函数，地址由调用方传入
 * - opaque  这一层声明的其他名字（let / var、解构、循环变量、catch 参数、函数名、类名）：值看不出，但会遮住外层同名的常量
 * 不开作用域的节点返回 null
 */
function scopeFrame(n, keys) {
  const frame = { consts: new Map(), params: new Set(), opaque: new Set() }
  if (FUNCTIONS.has(n.type)) {
    for (const p of n.params) for (const name of patternNames(p)) frame.params.add(name)
    if (n.type === 'FunctionExpression' && n.id) frame.opaque.add(n.id.name)
    // var 的作用域是整个函数：函数体里（不进嵌套函数）的 var 都算在这一层
    if (n.body?.type === 'BlockStatement') collectVars(n.body, frame.opaque, keys)
    return frame
  }
  if (n.type === 'BlockStatement' || n.type === 'StaticBlock') {
    declare(n.body, frame)
    return frame
  }
  if (n.type === 'SwitchStatement') {
    declare(n.cases.flatMap((c) => c.consequent), frame)
    return frame
  }
  if (n.type === 'ForStatement' || n.type === 'ForInStatement' || n.type === 'ForOfStatement') {
    const decl = n.type === 'ForStatement' ? n.init : n.left
    if (decl?.type === 'VariableDeclaration') for (const d of decl.declarations) for (const name of patternNames(d.id)) frame.opaque.add(name)
    return frame
  }
  if (n.type === 'CatchClause') {
    for (const name of patternNames(n.param)) frame.opaque.add(name)
    return frame
  }
  return null
}

/** 一组语句里直接声明的名字（不进嵌套的代码块；块里的 const / let 只在块里有效） */
function declare(statements, frame) {
  for (const st of statements) {
    if (st.type === 'VariableDeclaration') {
      for (const d of st.declarations) {
        if (st.kind === 'const' && d.id.type === 'Identifier' && d.init) frame.consts.set(d.id.name, d.init)
        else for (const name of patternNames(d.id)) frame.opaque.add(name)
      }
    } else if ((st.type === 'FunctionDeclaration' || st.type === 'ClassDeclaration') && st.id) {
      frame.opaque.add(st.id.name)
    }
  }
}

function collectVars(root, out, keys) {
  const visit = (n) => {
    if (!n || typeof n.type !== 'string' || FUNCTIONS.has(n.type)) return
    if (n.type === 'VariableDeclaration' && n.kind === 'var') for (const d of n.declarations) for (const name of patternNames(d.id)) out.add(name)
    for (const k of keys[n.type] ?? []) {
      const c = n[k]
      if (Array.isArray(c)) c.forEach(visit)
      else if (c && typeof c === 'object') visit(c)
    }
  }
  for (const st of root.body) visit(st)
}

/** 把作用域链压成一层：从外到内，内层的名字覆盖外层的 */
function flattenScope(frames) {
  const consts = new Map()
  const params = new Set()
  const opaque = new Set()
  for (const f of frames) {
    for (const name of [...f.params, ...f.opaque]) {
      consts.delete(name)
      params.delete(name)
      opaque.delete(name)
    }
    for (const name of f.params) params.add(name)
    for (const name of f.opaque) opaque.add(name)
    for (const [name, init] of f.consts) {
      params.delete(name)
      opaque.delete(name)
      consts.set(name, init)
    }
  }
  return { consts, params, opaque }
}

/**
 * Vuex 的 actions（actions: { getX() { ... } }、export const actions = { ... }）各自引用了哪些导入的名字：
 * 菜单归属按 action 连，只连到派发这个 action 的页面；按整个模块连，用到同一模块其他状态的页面都会算进来
 */
function collectStoreActions(program, result, keys) {
  const locals = new Set(result.imports.flatMap((i) => i.specifiers.map((sp) => sp.local)))
  if (locals.size === 0) return
  const objects = []
  const visit = (n) => {
    if (!n || typeof n.type !== 'string') return
    if (n.type === 'Property' && !n.computed && n.key.type === 'Identifier' && n.key.name === 'actions' && n.value.type === 'ObjectExpression') objects.push(n.value)
    if (n.type === 'VariableDeclarator' && n.id.type === 'Identifier' && n.id.name === 'actions' && n.init?.type === 'ObjectExpression') objects.push(n.init)
    for (const k of keys[n.type] ?? []) {
      const c = n[k]
      if (Array.isArray(c)) c.forEach(visit)
      else if (c && typeof c === 'object') visit(c)
    }
  }
  visit(program)
  for (const obj of objects) {
    for (const pr of obj.properties) {
      if (pr.type !== 'Property' || pr.computed) continue
      const name = pr.key.type === 'Identifier' ? pr.key.name : stringValue(pr.key)
      if (!name) continue
      const refs = new Set()
      const walk = (n) => {
        if (!n || typeof n.type !== 'string') return
        if (n.type === 'Identifier' && locals.has(n.name)) refs.add(n.name)
        for (const k of keys[n.type] ?? []) {
          const c = n[k]
          if (Array.isArray(c)) c.forEach(walk)
          else if (c && typeof c === 'object') walk(c)
        }
      }
      walk(pr.value)
      result.storeActions.push({ name, refs: [...refs] })
    }
  }
}

const STORE_HELPERS = new Set(['mapActions', 'mapState', 'mapGetters', 'mapMutations', 'createNamespacedHelpers'])

/** 字符串字面量（含没有变量的模板字符串）的值 */
function stringValue(n) {
  if (!n) return null
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked
  return null
}

/**
 * 菜单归属要用的引用关系（不影响接口判定）：
 * - 写死路径的 import('...')：异步组件、懒加载的页面
 * - Vuex：dispatch / commit('ns/动作')、mapActions / mapState / mapGetters / mapMutations / createNamespacedHelpers('ns')、getters['ns/x']
 *   页面通过字符串派发用到 store 模块，没有 import，不认就连不上
 * - Vuex 的模块注册：modules: { ns: 模块 }（值是 import 进来的名字）
 */
function collectLinks(n, result) {
  if (n.type === 'ImportExpression') {
    const v = stringValue(n.source)
    if (v) result.dynamicImports.push(v)
  } else if (n.type === 'CallExpression') {
    const callee = n.callee.type === 'MemberExpression' && !n.callee.computed ? n.callee.property.name : n.callee.type === 'Identifier' ? n.callee.name : null
    const first = stringValue(n.arguments[0])
    if (first !== null && (callee === 'dispatch' || callee === 'commit') && first.includes('/')) {
      result.storeUses.add(first.slice(0, first.lastIndexOf('/')))
      if (callee === 'dispatch') result.storeActionUses.add(first)
    }
    if (first !== null && STORE_HELPERS.has(callee)) {
      const ns = first.replace(/\/+$/, '')
      result.storeUses.add(ns)
      // mapActions('ns', ['a', 'b']) / mapActions('ns', { x: 'a' })：具体用到哪些 action
      const second = n.arguments[1]
      if (callee === 'mapActions' && second) {
        const names = second.type === 'ArrayExpression' ? second.elements.map(stringValue) : second.type === 'ObjectExpression' ? second.properties.map((pr) => (pr.type === 'Property' ? stringValue(pr.value) : null)) : []
        for (const a of names) if (a) result.storeActionUses.add(`${ns}/${a}`)
      }
    }
  } else if (n.type === 'MemberExpression' && n.computed && n.object.type === 'MemberExpression' && !n.object.computed && n.object.property.name === 'getters') {
    const v = stringValue(n.property)
    if (v && v.includes('/')) result.storeUses.add(v.slice(0, v.lastIndexOf('/')))
  } else if (n.type === 'Property' && !n.computed && n.key.type === 'Identifier' && n.key.name === 'modules' && n.value.type === 'ObjectExpression') {
    for (const pr of n.value.properties) {
      if (pr.type !== 'Property' || pr.computed) continue
      const name = pr.key.type === 'Identifier' ? pr.key.name : stringValue(pr.key)
      if (name && pr.value.type === 'Identifier') result.storeModules.push({ name, local: pr.value.name })
    }
  }
}

/** a.b.c → ['a', 'b', 'c']；有计算属性或开头不是名字时返回 null */
function memberChain(n) {
  const out = []
  let cur = n
  while (cur.type === 'MemberExpression') {
    if (cur.computed || cur.property.type !== 'Identifier') return null
    out.unshift(cur.property.name)
    cur = cur.object
  }
  if (cur.type !== 'Identifier') return null
  out.unshift(cur.name)
  return out
}

function isReference(n, parent, key) {
  if (!parent) return true
  if ((parent.type === 'MemberExpression') && key === 'property' && !parent.computed) return false
  if ((parent.type === 'Property' || parent.type === 'MethodDefinition' || parent.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return false
  if ((parent.type === 'FunctionDeclaration' || parent.type === 'ClassDeclaration' || parent.type === 'FunctionExpression') && key === 'id') return false
  if (parent.type === 'VariableDeclarator' && key === 'id') return false
  if (parent.type === 'ImportSpecifier' || parent.type === 'ImportDefaultSpecifier' || parent.type === 'ImportNamespaceSpecifier' || parent.type === 'ExportSpecifier') return false
  if (parent.type === 'LabeledStatement' || parent.type === 'BreakStatement' || parent.type === 'ContinueStatement') return false
  if (parent.type.startsWith('TS') && parent.type !== 'TSAsExpression' && parent.type !== 'TSNonNullExpression' && parent.type !== 'TSSatisfiesExpression') return false
  return true
}

function handleCall({ node, owners, scope, calls, prefixes, ignore, lineOf, result, consumed }) {
  const flat = flattenCall(node)
  if (flat) {
    for (const rule of calls) {
      const m = matchTemplate(rule.steps, flat)
      if (!m) continue
      markChain(node, consumed)
      const url = evaluateUrl(m.url, scope)
      const methods = resolveMethod(m.method, rule, scope) // null = 写了方法但算不出
      for (const s of sitesFor({ url, methods, prefixes })) result.sites.push({ line: lineOf(node.start), owners: [...owners], rule: rule.call, ...s })
      return
    }
  }
  // 没有命中：参数长得像接口路径的，记为疑似请求
  const shape = flat ? callShape(flat) : null
  if (shape && ignore.some((re) => re.test(shape.replace(/\(\)/g, '')))) return
  for (const arg of node.arguments) {
    const candidates = arg.type === 'ObjectExpression'
      ? arg.properties.filter((p) => p.type === 'Property' && !p.computed && ((p.key.type === 'Identifier' && /^(url|action|path|api)$/i.test(p.key.name)))).map((p) => p.value)
      : [arg]
    for (const c of candidates) {
      const v = evaluateUrl(c, { consts: scope.consts, params: new Set(), opaque: new Set([...scope.params, ...scope.opaque]) }).value
      if (v && looksLikeApiPath(v)) {
        result.suspects.push({ line: lineOf(node.start), owners: [...owners], shape: shape ?? '(认不出的调用)', text: v })
        return
      }
    }
  }
}

function markChain(node, consumed) {
  let cur = node
  while (cur) {
    if (cur.type === 'CallExpression') {
      consumed.add(cur)
      cur = cur.callee
    } else if (cur.type === 'MemberExpression' || cur.type === 'ChainExpression' || cur.type === 'TSNonNullExpression') {
      cur = cur.object ?? cur.expression
    } else {
      break
    }
  }
}

/**
 * 方法：* 处的名字、method 占位算出的值（三元的两边都列出）、规则里写的。
 * 写了 method 却算不出（变量）时返回 null：不能悄悄当成默认方法，否则会记成另一个接口
 * @returns {string[] | null}
 */
function resolveMethod(found, rule, scope) {
  if (typeof found === 'string') return [found]
  if (found && typeof found === 'object') {
    const v = evaluateUrl(found, scope)
    if (v.partial || v.values.length === 0 || !v.values.every((x) => /^[a-z]+$/i.test(x))) return null
    return [...new Set(v.values.map((x) => x.toUpperCase()))]
  }
  return [rule.method ?? rule.defaultMethod]
}

/**
 * 一次调用记成几处定义：每种可能的地址 × 每种可能的方法（归一化后去重）。
 * 地址整个算不出（或有一部分可能算不出）时多记一条 path 为 null 的，交给覆盖报告；方法算不出时 method 为 null
 */
function sitesFor({ url, methods, prefixes }) {
  const out = []
  const seen = new Set()
  for (const raw of url.values) {
    const path = normalizePath(raw, { prefixes })
    if (path === null) continue
    for (const method of methods ?? [null]) {
      const k = `${method} ${path}`
      if (seen.has(k)) continue
      seen.add(k)
      out.push({ method, raw, path, fromParam: null })
    }
  }
  if (out.length === 0 || url.partial) out.push({ method: methods?.[0] ?? null, raw: url.value, path: null, fromParam: url.fromParam, ...(url.partial ? { partial: true } : {}) })
  return out
}

/** 长得像接口路径：/xxx/yyy 或 xxx/yyy；不是本地文件、资源、网址片段 */
export function looksLikeApiPath(v) {
  const s = v.trim()
  if (/\s/.test(s) || s.length < 2) return false
  if (/^(\.{1,2}\/|@\/|~\/|#|data:|blob:|mailto:)/.test(s)) return false
  if (/^(image|application|text|audio|video|multipart|font|model)\/[\w.+-]+$/i.test(s)) return false // MIME 类型
  if (/\.(vue|js|mjs|ts|tsx|jsx|css|scss|less|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|html?|md)(\?|$)/i.test(s)) return false
  const path = s.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/[?#].*$/, '')
  return /^\/?[A-Za-z_][\w.-]*(\/[\w{}.:-]*)*$/.test(path) && (path.startsWith('/') ? path.length > 1 : path.includes('/'))
}

// ---------- 模板里的属性（上传组件的 action 等） ----------

/**
 * 单文件组件的模板部分：Vue 写在 <template> 里；Svelte、Astro 的模板就是 <script>、<style> 以外的部分。
 * 返回 [模板文字] 和它在原文里的起点，形状和正则匹配结果一样（tm[1]、tm.index、tm[0]）
 */
function markupOf(content) {
  const vue = /<template\b[^>]*>([\s\S]*)<\/template>/i.exec(content)
  if (vue) return vue
  const rest = content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => m.replace(/[^\n]/g, ' ')).replace(/^---\r?\n[\s\S]*?\r?\n---/, (m) => m.replace(/[^\n]/g, ' '))
  const m = [rest, rest]
  m.index = 0
  return m
}

function templateSites({ content, attrs, prefixes }) {
  const out = []
  const tm = markupOf(content)
  const base = tm.index + tm[0].indexOf(tm[1])
  const template = tm[1]
  const starts = lineStarts(content)
  for (const { tag, attr, method } of attrs) {
    // 属性值里可能有 >（:on-change="f => g"）：引号里的整段跳过
    const open = new RegExp(`<${escapeRe(tag)}\\b((?:[^>"'{]|"[^"]*"|'[^']*'|\\{[^}]*\\})*)>`, 'g')
    for (const m of template.matchAll(open)) {
      // Vue：attr="..." / :attr="..." / v-bind:attr="..."；Svelte：attr={...}
      const attrRe = new RegExp(`(^|\\s)(:|v-bind:)?${escapeRe(attr)}\\s*=\\s*(?:(["'])([\\s\\S]*?)\\3|\\{([^}]*)\\})`)
      const a = attrRe.exec(m[1])
      if (!a) continue
      const bound = Boolean(a[2]) || a[5] !== undefined
      const value = (a[4] ?? a[5]).trim()
      if (!bound && (value === '' || value === '#')) continue // 占位：组件不自动上传，真正的请求在代码里
      let raw = null
      if (!bound) raw = value
      else if (/^(["'`])[^"'`$]*\1$/.test(value)) raw = value.slice(1, -1)
      else if (/^`[^`]*`$/.test(value)) raw = value.slice(1, -1).replace(/\$\{[^}]*\}/g, '{}')
      const path = raw === null ? null : normalizePath(raw, { prefixes })
      out.push({ line: upperBound(starts, base + m.index), owners: [TEMPLATE], rule: `<${tag} ${attr}>`, method, raw, path, fromParam: null })
    }
  }
  return out
}

// ---------- 工具 ----------

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return starts
}

/** 位置所在的行号（从 1 开始） */
function upperBound(starts, pos) {
  let lo = 0
  let hi = starts.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (starts[mid] <= pos) lo = mid + 1
    else hi = mid
  }
  return lo
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 调用的写法匹配：a.b、*.push（* 匹配任意一段或多段） */
export function globToRegExp(pattern) {
  return new RegExp(`^${pattern.split('*').map(escapeRe).join('[\\w$.]*')}$`)
}
