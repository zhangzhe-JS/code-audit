/**
 * 接口维度的规则（profile 里的 api 项）：请求是怎么发出去的、路径怎么归一化、哪些是 SDK 内置的接口
 *
 * 规则是声明式的配置，可以由人写，也可以由模型读项目后生成、人审核（见 README「接口维度」）。
 * 规则里的 examples 是规则自带的测试：每次扫描前先跑一遍，对不上直接报错，不产出结果
 *
 * api: {
 *   version: 1,                                  规则的版本号，改了规则就加 1，写进扫描结果
 *   calls: [{ call: 'request({url, method})', defaultMethod: 'GET' }, { call: 'upload(url)', method: 'POST' }],
 *   attrs: [{ tag: 'el-upload', attr: 'action', method: 'POST' }],   模板里写地址的属性
 *   consts: [{ name: 'UPLOAD_ACTION', method: 'POST', from: 'src/x/constants.js' }],
 *                                                 写着接口地址的顶层常量（交给上传组件、拼链接用）：常量被引用就算在用
 *   prefixes: ['/api'],                           去掉的前缀（网关前缀等）
 *   ignoreCalls: ['downloadFile'],                不算疑似请求的调用（覆盖报告里不再列出）
 *   manual: [{ from: 'src/api/x.js', fn: 'upload', method: 'POST', path: '/common/upload', reason: '...' }],
 *                                                 工具算不出地址的定义，人工指明是哪个接口
 *   reviewedDynamic: [{ from: 'src/utils/http.js', fn: 'download', reason: '通用下载，地址由后端返回' }],
 *                                                 确认不是固定接口的动态地址（覆盖报告里不再列出）
 *   sdk: [{ method: 'POST', path: '/login', package: '@x/login', via: ['createAuth'], note: '登录' }],
 *                                                 SDK 内部发的请求：项目代码里看不到，via 里的名字被引用就算在用，没被引用也保留
 *   examples: [{ raw: 'order/list?page=1', method: 'POST', expect: 'POST /order/list' }]
 * }
 */
import { parseTemplate, templateHasMethod, HTTP_METHODS } from './template.js'
import { endpointKey, normalizePath } from './normalize.js'

export const API_KEYS = Object.freeze(['version', 'calls', 'attrs', 'consts', 'prefixes', 'ignoreCalls', 'manual', 'reviewedDynamic', 'sdk', 'examples'])
const METHODS = HTTP_METHODS.map((m) => m.toUpperCase())

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const isStr = (v) => typeof v === 'string' && v.trim() !== ''
const isPath = (v) => isStr(v) && v.startsWith('/') && !/\s/.test(v)

/**
 * 校验 api 规则，返回错误列表（空数组 = 通过）
 * @param {unknown} api
 * @returns {string[]}
 */
export function validateApiConfig(api) {
  const errors = []
  if (!isObj(api)) return ['api 必须是对象，见 profiles/example.js 的写法']
  for (const k of Object.keys(api)) if (!API_KEYS.includes(k)) errors.push(`api 里不认识的字段：${k}（可用的字段：${API_KEYS.join('、')}）`)
  if (!Number.isInteger(api.version) || api.version < 1) errors.push('api.version 必须是正整数：改了规则就加 1，扫描结果里会记下用的是哪一版')
  const list = (key, check) => {
    const v = api[key]
    if (v === undefined) return
    if (!Array.isArray(v)) return errors.push(`api.${key} 必须是数组`)
    v.forEach((item, i) => check(item, `api.${key}[${i}]`))
  }
  const fields = (item, at, allowed) => {
    if (!isObj(item)) {
      errors.push(`${at} 必须是对象`)
      return false
    }
    for (const k of Object.keys(item)) if (!allowed.includes(k)) errors.push(`${at} 不认识的字段：${k}（可用的字段：${allowed.join('、')}）`)
    return true
  }
  const method = (v, at, required) => {
    if (v === undefined && !required) return
    if (!METHODS.includes(v)) errors.push(`${at} 必须是大写的 HTTP 方法（${METHODS.join('、')}）：${v}`)
  }

  if (!Array.isArray(api.calls) || api.calls.length === 0) errors.push('api.calls 必须是非空数组：至少写一种请求写法，如 { call: "request({url, method})" }')
  list('calls', (c, at) => {
    if (!fields(c, at, ['call', 'method', 'defaultMethod', 'note'])) return
    let steps = null
    try {
      steps = parseTemplate(c.call)
    } catch (e) {
      errors.push(`${at}.call ${e.message}`)
    }
    method(c.method, `${at}.method`)
    method(c.defaultMethod, `${at}.defaultMethod`)
    if (steps && templateHasMethod(steps) && c.method) errors.push(`${at}：模板里已经写了方法从哪里取（* 或 method），不要再写 method；取不到时用的写 defaultMethod`)
    if (steps && !templateHasMethod(steps) && !c.method && !c.defaultMethod) errors.push(`${at}：模板里看不出方法，要写 method（如 "POST"）`)
  })
  list('attrs', (a, at) => {
    if (!fields(a, at, ['tag', 'attr', 'method'])) return
    if (!isStr(a.tag) || !/^[\w-]+$/.test(a.tag)) errors.push(`${at}.tag 必须是标签名，如 "el-upload"`)
    if (!isStr(a.attr) || !/^[\w-]+$/.test(a.attr)) errors.push(`${at}.attr 必须是属性名，如 "action"`)
    method(a.method, `${at}.method`, true)
  })
  list('consts', (c, at) => {
    if (!fields(c, at, ['name', 'method', 'from'])) return
    if (!isStr(c.name) || !/^[A-Za-z_$][\w$]*$/.test(c.name)) errors.push(`${at}.name 必须是常量名`)
    method(c.method, `${at}.method`, true)
    if (c.from !== undefined && !isStr(c.from)) errors.push(`${at}.from 必须是文件路径（不写就匹配所有文件里同名的顶层常量）`)
  })
  for (const key of ['prefixes', 'ignoreCalls']) {
    list(key, (v, at) => {
      if (!isStr(v) || /\s/.test(v)) errors.push(`${at} 必须是不含空格的字符串`)
      if (key === 'prefixes' && isStr(v) && !v.startsWith('/')) errors.push(`${at} 必须以 / 开头，如 "/api"`)
    })
  }
  list('manual', (m, at) => {
    if (!fields(m, at, ['from', 'fn', 'method', 'path', 'reason'])) return
    if (!isStr(m.from)) errors.push(`${at}.from 必须是文件路径`)
    if (!isStr(m.fn)) errors.push(`${at}.fn 必须是定义所在的顶层函数名（照抄扫描输出）`)
    method(m.method, `${at}.method`, true)
    if (!isPath(m.path)) errors.push(`${at}.path 必须是归一化后的路径，如 "/common/upload"`)
    if (!isStr(m.reason)) errors.push(`${at}.reason 必须写依据：会写进结果`)
  })
  list('reviewedDynamic', (r, at) => {
    if (!fields(r, at, ['from', 'fn', 'reason'])) return
    if (!isStr(r.from)) errors.push(`${at}.from 必须是文件路径`)
    if (!isStr(r.fn)) errors.push(`${at}.fn 必须是所在的顶层函数名（照抄扫描输出）`)
    if (!isStr(r.reason)) errors.push(`${at}.reason 必须写确认的理由`)
  })
  list('sdk', (s, at) => {
    if (!fields(s, at, ['method', 'path', 'package', 'via', 'note'])) return
    method(s.method, `${at}.method`, true)
    if (!isPath(s.path)) errors.push(`${at}.path 必须是归一化后的路径，如 "/login"`)
    if (!isStr(s.package)) errors.push(`${at}.package 必须是 SDK 的包名`)
    if (s.via !== undefined && (!Array.isArray(s.via) || !s.via.every((v) => isStr(v) && /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)?$/.test(v)))) errors.push(`${at}.via 必须是 SDK 导出的名字（或「名字.成员」，如 Auth.openDialog）组成的数组`)
    if (s.note !== undefined && !isStr(s.note)) errors.push(`${at}.note 必须是字符串`)
  })
  list('examples', (e, at) => {
    if (!fields(e, at, ['raw', 'method', 'expect'])) return
    if (typeof e.raw !== 'string') errors.push(`${at}.raw 必须是代码里的原始地址`)
    method(e.method ?? 'GET', `${at}.method`)
    if (e.expect !== null && !(isStr(e.expect) && /^[A-Z]+ \//.test(e.expect))) errors.push(`${at}.expect 必须是「方法 路径」，如 "GET /x/{}"；算不出接口的写 null`)
  })
  if (errors.length === 0) {
    for (const f of runExamples(api)) errors.push(f)
  }
  return errors
}

/**
 * 跑规则自带的例子，返回对不上的说明
 * @param {object} api
 */
export function runExamples(api) {
  const out = []
  for (const [i, e] of (api.examples ?? []).entries()) {
    const path = normalizePath(e.raw, { prefixes: api.prefixes ?? [] })
    const got = path === null ? null : endpointKey(e.method ?? 'GET', path)
    if (got !== e.expect) out.push(`api.examples[${i}]：${JSON.stringify(e.raw)} 归一化后是 ${got === null ? 'null（算不出接口）' : got}，规则里写的是 ${e.expect}`)
  }
  return out
}

/**
 * 编译请求写法，供 extract 使用
 * @param {object} api 已校验过的规则
 */
export function compileCalls(api) {
  return api.calls.map((c) => ({ call: c.call, steps: parseTemplate(c.call), method: c.method ?? null, defaultMethod: c.defaultMethod ?? 'GET' }))
}
