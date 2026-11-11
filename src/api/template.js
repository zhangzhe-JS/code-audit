/**
 * 请求写法的模板：规则文件里用一行模板描述「请求是怎么发出去的」
 *
 * 写法（和代码长得一样，只是参数换成占位）：
 *   request({url, method})        调用 request，第一个参数是对象，取它的 url、method 属性
 *   http.*(url)                   http.get / post / ... ，方法取自 * 处的名字，地址是第一个参数
 *   post(url, _)                  方法写在规则的 method 里
 *   client(_)(url).*()            链式调用：第二次调用的第一个参数是地址，方法取自 .post() 这类
 *   fetch(url, {method})          第二个参数是对象，取它的 method 属性
 *
 * 占位：url 地址；method 方法；_ 任意一个参数；... 后面还可以有任意个参数；{url, method} 对象参数里的属性；
 * * 只能用在成员名上，匹配 HTTP 方法名（get、post、put、delete、patch、head、options，不分大小写）
 */

export const HTTP_METHODS = Object.freeze(['get', 'post', 'put', 'delete', 'patch', 'head', 'options'])

/**
 * @typedef {{type: 'name', name: string} | {type: 'member', name: string} | {type: 'call', params: Param[], rest: boolean}} Step
 * @typedef {{type: 'skip'} | {type: 'url'} | {type: 'method'} | {type: 'object', fields: ('url'|'method')[]}} Param
 */

/**
 * 解析模板，写错时抛出带位置的错误
 * @param {string} text
 * @returns {Step[]}
 */
export function parseTemplate(text) {
  if (typeof text !== 'string' || text.trim() === '') throw new Error('模板不能为空')
  const s = text.replace(/\s+/g, '')
  let i = 0
  const fail = (msg) => {
    throw new Error(`模板「${text}」写错了：${msg}（第 ${i + 1} 个字符附近）`)
  }
  const ident = () => {
    const m = /^(?:[A-Za-z_$][\w$]*|\*)/.exec(s.slice(i))
    if (!m) fail('这里应该是名字')
    i += m[0].length
    return m[0]
  }
  const steps = []
  const head = ident()
  if (head === '*') fail('开头不能是 *')
  steps.push({ type: 'name', name: head })
  while (i < s.length) {
    if (s[i] === '.') {
      i++
      steps.push({ type: 'member', name: ident() })
    } else if (s[i] === '(') {
      i++
      const params = []
      let rest = false
      while (s[i] !== ')') {
        if (i >= s.length) fail('括号没有闭合')
        if (rest) fail('... 只能写在最后')
        if (s.startsWith('...', i)) {
          i += 3
          rest = true
        } else if (s[i] === '{') {
          i++
          const fields = []
          while (s[i] !== '}') {
            const f = ident()
            if (f !== 'url' && f !== 'method') fail(`对象参数里只能写 url、method：${f}`)
            fields.push(f)
            if (s[i] === ',') i++
            else if (s[i] !== '}') fail('对象参数里用逗号分隔')
          }
          i++
          params.push({ type: 'object', fields })
        } else {
          const p = ident()
          if (p === '_') params.push({ type: 'skip' })
          else if (p === 'url' || p === 'method') params.push({ type: p })
          else fail(`参数只能是 url、method、_、...、{url, method}：${p}`)
        }
        if (s[i] === ',') i++
        else if (s[i] !== ')') fail('参数之间用逗号分隔')
      }
      i++
      steps.push({ type: 'call', params, rest })
    } else {
      fail(`不认识的字符：${s[i]}`)
    }
  }
  if (steps[steps.length - 1].type !== 'call') fail('最后必须是一次调用，如 request(url)')
  const urls = countUrl(steps)
  if (urls !== 1) fail(`必须恰好有一个 url 占位，现在有 ${urls} 个`)
  const methods = steps.filter((st) => st.type === 'member' && st.name === '*').length + countMethod(steps)
  if (methods > 1) fail('方法只能从一个地方取（* 或 method 二选一）')
  return steps
}

function countUrl(steps) {
  return steps.filter((st) => st.type === 'call').flatMap((st) => st.params).filter((p) => p.type === 'url' || (p.type === 'object' && p.fields.includes('url'))).length
}

function countMethod(steps) {
  return steps.filter((st) => st.type === 'call').flatMap((st) => st.params).filter((p) => p.type === 'method' || (p.type === 'object' && p.fields.includes('method'))).length
}

/** 模板有没有指明方法从哪里取（* 或 method 占位） */
export function templateHasMethod(steps) {
  return steps.some((st) => st.type === 'member' && st.name === '*') || countMethod(steps) > 0
}

/**
 * 把一次调用（最外层的 CallExpression）展开成和模板一样的步骤
 * a.b.post(x)        → name a, member b, member post, call[x]
 * client(m)(u).post() → name client, call[m], call[u], member post, call[]
 * 认不出的写法（计算属性、开头不是名字或 this）返回 null
 * @param {object} node CallExpression
 * @returns {{type: string, name?: string, args?: object[]}[] | null}
 */
export function flattenCall(node) {
  const out = []
  let cur = node
  for (;;) {
    if (cur.type === 'ChainExpression' || cur.type === 'TSNonNullExpression' || cur.type === 'ParenthesizedExpression') {
      cur = cur.expression
    } else if (cur.type === 'CallExpression') {
      out.push({ type: 'call', args: cur.arguments })
      cur = cur.callee
    } else if (cur.type === 'MemberExpression') {
      if (cur.computed || cur.property.type !== 'Identifier') return null
      out.push({ type: 'member', name: cur.property.name })
      cur = cur.object
    } else if (cur.type === 'Identifier') {
      out.push({ type: 'name', name: cur.name })
      break
    } else if (cur.type === 'ThisExpression') {
      out.push({ type: 'name', name: 'this' })
      break
    } else {
      return null
    }
  }
  return out.reverse()
}

/** 调用写成文字，用于覆盖报告：client()().post() */
export function callShape(flat) {
  return flat.map((st) => (st.type === 'name' ? st.name : st.type === 'member' ? `.${st.name}` : '()')).join('')
}

/**
 * 用模板匹配展开后的调用
 * @param {Step[]} steps
 * @param {ReturnType<typeof flattenCall>} flat
 * @returns {{url: object, method: string | object | null} | null} url 是地址那个参数的语法节点；
 *   method 是 * 处的方法名（字符串）或方法参数的语法节点，没有写法时为 null
 */
export function matchTemplate(steps, flat) {
  if (!flat || flat.length !== steps.length) return null
  let url = null
  let method = null
  for (let k = 0; k < steps.length; k++) {
    const st = steps[k]
    const f = flat[k]
    if (st.type !== f.type) return null
    if (st.type === 'name') {
      if (st.name !== f.name) return null
    } else if (st.type === 'member') {
      if (st.name === '*') {
        if (!HTTP_METHODS.includes(f.name.toLowerCase())) return null
        method = f.name.toUpperCase()
      } else if (st.name !== f.name) {
        return null
      }
    } else {
      const args = f.args
      if (args.some((a) => a.type === 'SpreadElement')) return null
      const need = st.params.length
      const optional = (p) => p.type === 'skip' || p.type === 'method' || (p.type === 'object' && !p.fields.includes('url'))
      if (args.length < need && !st.params.slice(args.length).every(optional)) return null
      if (!st.rest && args.length > need) return null
      for (let p = 0; p < need; p++) {
        const param = st.params[p]
        const arg = args[p]
        if (param.type === 'url') {
          if (!arg) return null
          url = arg
        } else if (param.type === 'method') {
          if (arg) method = arg
        } else if (param.type === 'object') {
          if (!arg) {
            if (param.fields.includes('url')) return null
            continue
          }
          if (arg.type !== 'ObjectExpression') {
            if (param.fields.includes('url')) return null
            continue
          }
          for (const field of param.fields) {
            const prop = arg.properties.find((pr) => pr.type === 'Property' && !pr.computed && propName(pr.key) === field)
            if (field === 'url') {
              if (!prop) return null
              url = prop.shorthand ? prop.key : prop.value
            } else if (prop) {
              method = prop.shorthand ? prop.key : prop.value
            }
          }
        }
      }
    }
  }
  return url ? { url, method } : null
}

function propName(key) {
  if (key.type === 'Identifier') return key.name
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value
  return null
}
