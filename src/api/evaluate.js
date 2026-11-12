/**
 * 算出请求地址：字符串、模板字符串、+ 拼接、作用域里的常量（含常量对象的属性）、三元 / ||
 *
 * 算不出的部分写成 {}（路径参数、变量）。三元、|| 两边都算得出时不合并成 {}，而是列出每一种可能
 * （'/a/' + (x ? 'b' : 'c') → /a/b、/a/c）：合并成 /a/{} 会变成另一个接口，把真正调用的 /a/b 判成没人用
 */

/**
 * @typedef {object} Scope
 * @property {Map<string, object>} consts  作用域里 const 的初始值（语法节点）
 * @property {Set<string>} params          当前所在函数的参数名
 * @property {Set<string>} [opaque]        内层声明的其他名字（let、循环变量等）：值看不出，会遮住外层同名的常量
 */

/** 最多列出几种可能，超过就当成算不出（避免组合爆炸） */
export const MAX_VARIANTS = 8

/**
 * @param {object} node 语法节点
 * @param {Scope} scope
 * @returns {{value: string | null, values: string[], partial: boolean, fromParam: string | null}}
 *   values：所有可能的地址（去重）；value 是第一个，都算不出时为 null
 *   partial：有一部分可能算不出（如 url || '/x' 里的 url）
 *   fromParam：地址整个就是所在函数的某个参数（封装函数，地址由调用方传进来）
 */
export function evaluateUrl(node, scope) {
  const unwrapped = unwrap(node)
  if (unwrapped.type === 'Identifier' && scope.params.has(unwrapped.name)) {
    return { value: null, values: [], partial: false, fromParam: unwrapped.name }
  }
  const all = evalNode(unwrapped, scope, new Set())
  const known = [...new Set(all.filter((v) => /[^{}]/.test(v)))]
  return { value: known[0] ?? null, values: known, partial: known.length < all.length && known.length > 0, fromParam: null }
}

function unwrap(node) {
  let n = node
  while (n && (n.type === 'TSAsExpression' || n.type === 'TSNonNullExpression' || n.type === 'ParenthesizedExpression' || n.type === 'TSSatisfiesExpression' || n.type === 'TSTypeAssertion' || n.type === 'ChainExpression')) {
    n = n.expression
  }
  return n
}

const PARAM = '{}'

/** 两组可能拼接：组合；超过上限时整体当成参数 */
function concat(a, b) {
  const out = []
  for (const x of a) for (const y of b) out.push(x + y)
  const uniq = [...new Set(out)]
  return uniq.length > MAX_VARIANTS ? [PARAM] : uniq
}

/** @returns {string[]} 所有可能的取值 */
function evalNode(raw, scope, seen) {
  const node = unwrap(raw)
  if (!node) return [PARAM]
  switch (node.type) {
    case 'Literal':
      return [typeof node.value === 'string' ? node.value : node.value === null ? PARAM : String(node.value)]
    case 'TemplateLiteral': {
      let acc = ['']
      node.quasis.forEach((q, i) => {
        acc = concat(acc, [q.value.cooked ?? q.value.raw])
        if (i < node.expressions.length) acc = concat(acc, evalNode(node.expressions[i], scope, seen))
      })
      return acc
    }
    case 'BinaryExpression':
      if (node.operator !== '+') return [PARAM]
      return concat(evalNode(node.left, scope, seen), evalNode(node.right, scope, seen))
    case 'Identifier': {
      if (scope.params.has(node.name) || scope.opaque?.has(node.name)) return [PARAM]
      const init = scope.consts.get(node.name)
      if (!init || seen.has(node.name)) return [PARAM]
      seen.add(node.name)
      const v = evalStatic(init, scope, seen)
      seen.delete(node.name)
      return v ?? [PARAM]
    }
    case 'MemberExpression':
      return memberValue(node, scope, seen) ?? [PARAM]
    case 'ConditionalExpression':
    case 'LogicalExpression': {
      // a ? '/x' : '/y'、a || '/x'：两边的可能都列出（|| 左边算不出时就是一个 {}，由调用方记为部分算不出）
      if (node.type === 'LogicalExpression' && node.operator === '&&') return [PARAM]
      const a = evalNode(node.type === 'ConditionalExpression' ? node.consequent : node.left, scope, seen)
      const b = evalNode(node.type === 'ConditionalExpression' ? node.alternate : node.right, scope, seen)
      const uniq = [...new Set([...a, ...b])]
      return uniq.length > MAX_VARIANTS ? [PARAM] : uniq
    }
    default:
      return [PARAM]
  }
}

/** 常量的值：只认字符串类的写法，其余（函数调用、数字运算）当成参数 */
function evalStatic(init, scope, seen) {
  const n = unwrap(init)
  if (['Literal', 'TemplateLiteral', 'BinaryExpression', 'Identifier', 'MemberExpression', 'ConditionalExpression', 'LogicalExpression'].includes(n.type)) {
    if (n.type === 'Literal' && typeof n.value !== 'string') return null
    return evalNode(n, scope, seen)
  }
  return null
}

/** API.LIST、URLS.user.detail：常量对象里写死的属性 */
function memberValue(node, scope, seen) {
  // Resolve finite computed keys and nested constant tables without executing code.
  const objects = (raw, visited = new Set()) => {
    const n = unwrap(raw)
    if (!n) return []
    if (n.type === 'ObjectExpression') return [n]
    if (n.type === 'Identifier') {
      if (scope.params.has(n.name) || scope.opaque?.has(n.name) || visited.has(n.name)) return []
      return objects(scope.consts.get(n.name), new Set([...visited, n.name]))
    }
    if (n.type !== 'MemberExpression') return []
    return select(n, visited).flatMap(v => objects(v, visited))
  }
  const select = (n, visited) => {
    const keys = n.computed ? evalNode(n.property, scope, seen) : [n.property.name]
    const out = []
    for (const obj of objects(n.object, visited)) {
      // A spread/computed property/getter may override any earlier property.
      if (obj.properties.some(p => p.type !== 'Property' || p.computed || p.kind !== 'init' || p.method)) continue
      const props = new Map(obj.properties.map(p => [String(p.key.name ?? p.key.value), p.value]))
      for (const key of keys) {
        if (key === PARAM) out.push(...props.values(), null)
        else out.push(props.get(key) ?? null)
      }
    }
    return out
  }
  const root = (() => { let n = node; while (n?.type === 'MemberExpression') n = unwrap(n.object); return n })()
  const marker = root?.type === 'Identifier' ? `member:${root.name}` : null
  if (marker && seen.has(marker)) return null
  if (marker) seen.add(marker)
  try {
    const values = select(node, new Set()).flatMap(v => v ? evalStatic(v, scope, seen) ?? [PARAM] : [PARAM])
    const unique = [...new Set(values)]
    return unique.length > MAX_VARIANTS ? [PARAM] : unique.length ? unique : null
  } finally { if (marker) seen.delete(marker) }
}

/* Historical direct-member implementation retained below only until replacement. */
function legacyMemberValue(node, scope, seen) {
  const path = []
  let cur = unwrap(node)
  while (cur.type === 'MemberExpression') {
    if (cur.computed) {
      if (cur.property.type !== 'Literal' || typeof cur.property.value !== 'string') return null
      path.unshift(cur.property.value)
    } else {
      path.unshift(cur.property.name)
    }
    cur = unwrap(cur.object)
  }
  if (cur.type !== 'Identifier' || scope.params.has(cur.name) || scope.opaque?.has(cur.name)) return null
  let obj = scope.consts.get(cur.name)
  for (const key of path) {
    obj = obj && unwrap(obj)
    if (!obj || obj.type !== 'ObjectExpression') return null
    const prop = obj.properties.find((p) => p.type === 'Property' && !p.computed && ((p.key.type === 'Identifier' && p.key.name === key) || (p.key.type === 'Literal' && p.key.value === key)))
    if (!prop) return null
    obj = prop.value
  }
  if (!obj) return null
  return evalStatic(obj, scope, seen)
}
