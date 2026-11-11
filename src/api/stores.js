/**
 * store 的 action 粒度：请求写在 Pinia / Vuex store 的某个 action 里时，store 在用不代表这个 action 有人调用
 *
 * - piniaStores：文件里用 defineStore 定义的 store，每个 action（setup 写法里的内部函数）在代码里的范围，
 *   以及调用它会走到哪些对外的 action（a 里调用了 b，b 里的请求在 a 被调用时也会发出）
 * - storeUses：这个文件怎么用 store：useX().a、const s = useX(); s.a()、const { a } = useX()、mapActions(useX, ['a'])、
 *   单文件组件模板里的 s.a。按调用的名字记（只记 use 开头的，Pinia 的惯例），看不清用了哪些的记 '*'
 *
 * 看不清的一律偏保守（当所有 action 都在用）：整个 store 被传走、s[name]、mapStores、this[name]、
 * setup 写法里内部函数被当成值交出去（watch(x, f)）、返回值不是对象字面量等
 */

export const WHOLE_STORE = '*'

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'])

/** 遍历，带父节点和所在字段 */
function walk(node, keys, fn, parent = null, key = null) {
  if (!node || typeof node.type !== 'string') return
  if (fn(node, parent, key) === false) return
  for (const k of keys[node.type] ?? Object.keys(node)) {
    if (k === 'type' || k === 'start' || k === 'end' || k === 'loc' || k === 'range') continue
    const c = node[k]
    if (Array.isArray(c)) c.forEach((x) => walk(x, keys, fn, node, k))
    else if (c && typeof c === 'object') walk(c, keys, fn, node, k)
  }
}

function calleeName(c) {
  if (c.type === 'Identifier') return c.name
  if (c.type === 'MemberExpression' && !c.computed && c.property.type === 'Identifier') return c.property.name
  return null
}

function propName(pr) {
  if (pr.computed) return null
  if (pr.key.type === 'Identifier') return pr.key.name
  if (pr.key.type === 'Literal' && typeof pr.key.value === 'string') return pr.key.value
  return null
}

/**
 * @returns {{binding: string, units: {start: number, end: number, actions: string[]|null}[]}[]}
 *   actions：调用哪些对外的 action 会走到这段代码；null = 看不清（store 创建时就执行、被当成值交出去等），按 store 判断
 */
export function piniaStores(program, keys) {
  const out = []
  for (const node of program.body) {
    const decl = node.type === 'ExportNamedDeclaration' ? node.declaration : node
    const pairs = []
    if (decl?.type === 'VariableDeclaration') for (const d of decl.declarations) if (d.id.type === 'Identifier' && d.init) pairs.push([d.id.name, d.init])
    if (node.type === 'ExportDefaultDeclaration') pairs.push(['default', node.declaration])
    for (const [binding, init] of pairs) {
      const call = init.type === 'TSAsExpression' || init.type === 'TSSatisfiesExpression' ? init.expression : init
      if (call?.type !== 'CallExpression' || calleeName(call.callee) !== 'defineStore') continue
      const setup = call.arguments.find((a) => FUNCTIONS.has(a.type))
      const options = call.arguments.find((a) => a.type === 'ObjectExpression' && a.properties.some((p) => p.type === 'Property' && propName(p) === 'actions'))
      const units = setup ? setupUnits(setup, keys) : options ? optionUnits(options, keys) : null
      if (units) out.push({ binding, units })
    }
  }
  return out
}

/** 选项写法：actions: { a() {}, b() {} }；action 之间靠 this.b() 互相调用 */
function optionUnits(options, keys) {
  const actionsProp = options.properties.find((p) => p.type === 'Property' && propName(p) === 'actions')
  if (actionsProp.value.type !== 'ObjectExpression') return null
  const units = new Map()
  for (const pr of actionsProp.value.properties) {
    if (pr.type !== 'Property') return null // ...spread：看不清有哪些 action
    const name = propName(pr)
    if (name === null) return null
    units.set(name, { start: pr.value.start, end: pr.value.end, refs: new Set() })
  }
  const storeLevel = new Set()
  let opaque = false
  walk(options, keys, (n, parent, key) => {
    if (n.type !== 'ThisExpression') return
    const unit = [...units.entries()].find(([, u]) => n.start >= u.start && n.end <= u.end)
    if (parent?.type === 'MemberExpression' && key === 'object' && !parent.computed && parent.property.type === 'Identifier') {
      const target = parent.property.name
      if (!units.has(target)) return
      if (unit) unit[1].refs.add(target)
      else storeLevel.add(target) // getters、state 里调用：看不清什么时候执行
    } else {
      opaque = true // this[name]、把 this 整个交出去
    }
  })
  if (opaque) return [{ start: actionsProp.value.start, end: actionsProp.value.end, actions: null }]
  return reach(units, new Map([...units.keys()].map((n) => [n, n])), storeLevel)
}

/** setup 写法：函数体里的内部函数，return { a, b: c, d: () => {} } 交出去的是对外的 action */
function setupUnits(fn, keys) {
  const units = new Map()
  const exposed = new Map() // 对外的名字 → 内部名字
  let ret = null
  if (fn.body.type === 'BlockStatement') {
    for (const st of fn.body.body) {
      if (st.type === 'FunctionDeclaration' && st.id) units.set(st.id.name, { start: st.start, end: st.end, refs: new Set() })
      if (st.type === 'VariableDeclaration') {
        for (const d of st.declarations) if (d.id.type === 'Identifier' && d.init && FUNCTIONS.has(d.init.type)) units.set(d.id.name, { start: d.init.start, end: d.init.end, refs: new Set() })
      }
      if (st.type === 'ReturnStatement') ret = st.argument
    }
  } else {
    ret = fn.body
  }
  while (ret && (ret.type === 'ParenthesizedExpression' || ret.type === 'TSAsExpression')) ret = ret.expression
  if (ret?.type !== 'ObjectExpression') return null
  for (const pr of ret.properties) {
    if (pr.type !== 'Property') return null
    const name = propName(pr)
    if (name === null) return null
    if (pr.value.type === 'Identifier') {
      if (units.has(pr.value.name)) exposed.set(name, pr.value.name)
    } else if (FUNCTIONS.has(pr.value.type)) {
      const inner = `<return>.${name}`
      units.set(inner, { start: pr.value.start, end: pr.value.end, refs: new Set() })
      exposed.set(name, inner)
    }
  }
  // 内部函数的名字在哪里被提到：在另一个内部函数里 → 那个函数会调用它；在 return 以外的地方（setup 执行时、watch(x, f)）→ 看不清
  const storeLevel = new Set()
  walk(fn.body, keys, (n, parent, key) => {
    if (n.type !== 'Identifier' || !units.has(n.name)) return
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return
    if ((parent?.type === 'Property' && key === 'key' && !parent.computed) || (parent?.type === 'VariableDeclarator' && key === 'id') || (parent?.type === 'FunctionDeclaration' && key === 'id')) return
    if (parent?.type === 'Property' && key === 'value' && ret.properties.includes(parent)) return // return 里交出去的
    const unit = [...units.entries()].find(([, u]) => n.start >= u.start && n.end <= u.end)
    if (unit) {
      if (unit[0] !== n.name) unit[1].refs.add(n.name)
    } else {
      storeLevel.add(n.name)
    }
  })
  const exposedOf = new Map()
  for (const [outer, inner] of exposed) exposedOf.set(inner, [...(exposedOf.get(inner) ?? []), outer])
  return reach(units, exposedOf, storeLevel)
}

/**
 * 每段代码会被哪些对外的 action 走到：从对外的 action 出发顺着调用关系走；
 * 看不清的（storeLevel）以及被它们调用的，actions 记 null
 * @param {Map<string, {start: number, end: number, refs: Set<string>}>} units
 * @param {Map<string, string|string[]>} exposedOf 内部名字 → 对外名字
 */
function reach(units, exposedOf, storeLevel) {
  const actions = new Map([...units.keys()].map((n) => [n, new Set()]))
  const opaque = new Set()
  const spread = (from, mark) => {
    const seen = new Set()
    const queue = [from]
    while (queue.length > 0) {
      const cur = queue.pop()
      if (seen.has(cur) || !units.has(cur)) continue
      seen.add(cur)
      mark(cur)
      for (const r of units.get(cur).refs) queue.push(r)
    }
  }
  for (const [inner, outer] of exposedOf) for (const o of [outer].flat()) spread(inner, (n) => actions.get(n).add(o))
  for (const n of storeLevel) spread(n, (x) => opaque.add(x))
  return [...units.entries()].map(([n, u]) => ({ start: u.start, end: u.end, actions: opaque.has(n) ? null : [...actions.get(n)].sort() }))
}

/**
 * 这个文件怎么用 store（按调用的名字）：名字 → 用到的成员；看不清的含 '*'
 * @param {object} program
 * @param {object} keys
 * @param {(n: object, parent: object, key: string) => boolean} isReference
 * @param {string|null} markup 单文件组件的模板
 * @returns {Map<string, Set<string>>}
 */
export function storeUses(program, keys, isReference, markup = null) {
  const uses = new Map()
  const tracked = new Map() // 变量名 → store 的名字
  const add = (name, member) => {
    const set = uses.get(name) ?? new Set()
    set.add(member)
    uses.set(name, set)
  }
  const isStore = (name) => typeof name === 'string' && /^use[A-Z0-9_$]/.test(name)
  // 第一遍：useX() 的结果怎么用；useX 本身被当成值用
  walk(program, keys, (n, parent, key) => {
    if (n.type === 'CallExpression') {
      const name = calleeName(n.callee)
      if (!isStore(name)) return
      if (parent?.type === 'VariableDeclarator' && key === 'init' && parent.id.type === 'Identifier') tracked.set(parent.id.name, [...(tracked.get(parent.id.name) ?? []), name])
      else if (parent?.type === 'VariableDeclarator' && key === 'init' && parent.id.type === 'ObjectPattern') {
        for (const pr of parent.id.properties) {
          const m = pr.type === 'Property' ? propName(pr) : null
          add(name, m ?? WHOLE_STORE)
        }
      } else if (parent?.type === 'MemberExpression' && key === 'object' && !parent.computed && parent.property.type === 'Identifier') add(name, parent.property.name)
      else add(name, WHOLE_STORE)
      return
    }
    if (n.type === 'Identifier' && isStore(n.name) && isReference(n, parent, key) && !(parent?.type === 'CallExpression' && key === 'callee')) {
      // mapActions(useX, ['a']) / mapActions(useX, { k: 'a' })；mapState、mapGetters 不涉及 action；其他（mapStores、传参）看不清
      const helper = parent?.type === 'CallExpression' && key === 'arguments' && parent.arguments[0] === n ? calleeName(parent.callee) : null
      if (helper === 'mapState' || helper === 'mapGetters' || helper === 'mapWritableState') return
      if (helper === 'mapActions') {
        const second = parent.arguments[1]
        const names = second?.type === 'ArrayExpression' ? second.elements.map(literal) : second?.type === 'ObjectExpression' ? second.properties.map((pr) => (pr.type === 'Property' ? literal(pr.value) : null)) : [null]
        for (const a of names) add(n.name, a ?? WHOLE_STORE)
        return
      }
      add(n.name, WHOLE_STORE)
    }
  })
  if (tracked.size === 0) return uses
  // 第二遍：const s = useX() 之后 s 怎么用（按名字，不分作用域：同名的都算，偏多）
  walk(program, keys, (n, parent, key) => {
    if (n.type !== 'Identifier' || !tracked.has(n.name) || !isReference(n, parent, key)) return
    if (parent?.type === 'VariableDeclarator' && key === 'id') return
    const stores = tracked.get(n.name)
    let member = WHOLE_STORE
    if (parent?.type === 'MemberExpression' && key === 'object' && !parent.computed && parent.property.type === 'Identifier') member = parent.property.name
    else if (parent?.type === 'CallExpression' && key === 'arguments' && calleeName(parent.callee) === 'storeToRefs') return // 只取 state、getters
    for (const s of stores) add(s, member)
  })
  // 模板里：s.a 记成员，单独出现的 s 看不清
  if (markup) {
    for (const [v, stores] of tracked) {
      const re = new RegExp(`(^|[^\\w$.])${v.replace(/\$/g, '\\$')}\\b(\\s*\\??\\.\\s*([A-Za-z_$][\\w$]*))?`, 'g')
      for (const m of markup.matchAll(re)) for (const s of stores) add(s, m[3] ?? WHOLE_STORE)
    }
  }
  return uses
}

function literal(n) {
  if (!n) return null
  if (n.type === 'Literal' && typeof n.value === 'string') return n.value
  if (n.type === 'TemplateLiteral' && n.expressions.length === 0) return n.quasis[0].value.cooked
  return null
}
