/**
 * 接口的唯一标识：请求方法 + 路径模板（和后端路由认定接口的方式一致）
 *
 * 归一化步骤（顺序固定）：
 * 1. 去掉 ? 和 # 后面的内容（查询参数不区分接口）
 * 2. 开头是变量（{}/xxx，如 `${baseUrl}/xxx`）：去掉这个变量，它是服务地址，不是路径的一部分
 * 3. 补上开头的 /
 * 4. 去掉规则里写的前缀（网关前缀如 /api），只按整段匹配，最长的优先
 * 5. 合并连续的 /，去掉结尾的 /
 * 6. 路径参数统一为 {}：整段是变量的写成 {}；一段里既有文字又有变量的（如 detail{}）原样保留
 *
 * 完整网址或省略协议的网址（http://主机/路径、//主机/路径）：保留 //主机，不和自家后端的同名路径混在一起（多半是第三方服务）
 *
 * 整个路径里没有一个文字段时（只有变量）返回 null：算不出是哪个接口
 */

/**
 * @param {string} raw  evaluateUrl 算出的地址（变量部分已经是 {}）
 * @param {{prefixes?: string[]}} [opts]
 * @returns {string | null}
 */
export function normalizePath(raw, { prefixes = [] } = {}) {
  if (typeof raw !== 'string') return null
  let p = raw.trim()
  p = p.replace(/[?#].*$/s, '')
  let host = ''
  const full = /^(?:[a-z][a-z0-9+.-]*:)?\/\/([^/]+)/i.exec(p)
  if (full) {
    // 报告里不应保留 URL userinfo（https://user:pass@host/a）。
    host = full[1].slice(full[1].lastIndexOf('@') + 1).toLowerCase()
    p = p.slice(full[0].length)
  }
  p = p.replace(/^(\{\})+(?=\/)/, '')
  if (!p.startsWith('/')) p = `/${p}`
  p = p.replace(/\/{2,}/g, '/')
  // URL/path 的 . 和 .. 段不区分接口；不允许越过根目录。
  const normalized = []
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') normalized.pop()
    else normalized.push(segment)
  }
  p = `/${normalized.join('/')}`
  for (const prefix of host ? [] : [...prefixes].sort((a, b) => b.length - a.length)) {
    const pre = `/${prefix.replace(/^\/+|\/+$/g, '')}`
    if (pre === '/') continue
    if (p === pre) {
      p = '/'
      break
    }
    if (p.startsWith(`${pre}/`)) {
      p = p.slice(pre.length)
      break
    }
  }
  if (p.length > 1) p = p.replace(/\/+$/, '')
  const segments = p.split('/').slice(1).map((seg) => (/^(\{\})+$/.test(seg) ? '{}' : seg))
  if (!host && !segments.some((seg) => seg !== '{}' && seg !== '')) return null
  return `${host ? `//${host}` : ''}/${segments.join('/')}`
}

/**
 * 接口标识：方法 + 路径
 * @param {string} method
 * @param {string} path
 */
export function endpointKey(method, path) {
  return `${method.toUpperCase()} ${path}`
}

/** 写了完整网址的接口（//主机/路径）：多半是第三方服务，不是自家后端 */
export function isExternalPath(path) {
  return path.startsWith('//')
}

/**
 * 一段里既有文字又有变量的接口（export{}、v{}），实际调用的可能是 b 这个固定路径（exportExcel、v2）。
 * 整段是 {} 的按路径参数算（和后端路由一致：/x/{id} 和 /x/list 是两个接口），不算可能命中
 */
export function mayHit(pattern, path) {
  if (pattern === path) return false
  const a = pattern.split('/')
  const b = path.split('/')
  if (a.length !== b.length || !a.some((seg) => seg.includes('{}') && seg !== '{}')) return false
  return a.every((seg, i) => seg === b[i] || (seg.includes('{}') && seg !== '{}' && new RegExp(`^${seg.split('{}').map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(b[i])))
}
