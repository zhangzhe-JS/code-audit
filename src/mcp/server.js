/**
 * MCP 服务（stdio）：把查询和变化检查给 AI 编码工具（Claude Code、Cursor 等）用
 *
 * 协议：MCP 的 stdio 传输，每行一条 JSON-RPC 2.0 消息；stdout 只写协议消息，日志写 stderr。
 * 不依赖 MCP SDK（核心零依赖），只实现用到的部分：initialize、tools/list、tools/call、ping
 *
 * 工具：
 *   api_impact    一个接口在各项目在不在用、哪些菜单在用、引用方、停用历史（改接口、删接口前先查）
 *   similar_apis  路径相似的接口（新增接口前先查有没有现成的）
 *   search_apis   路径里含某段文字的接口
 *   file_info     一个文件里定义的接口、没人用的导出（改文件前先查）
 *   check_change  对比两个提交的接口变化（要跑分析，十几秒）。只能检查启动时用 --check 登记过的项目：
 *                 profile 是会被加载执行的 JS，不能让模型随意传路径
 *
 * 结果目录（code-audit api / exports 的 JSON）每次调用都重新读：结果更新了不用重启服务
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TOOL } from '../core/tool.js'
import { loadIndex, apiImpact, similarApis, searchApis, fileInfo } from '../query/index.js'

export const PROTOCOL_VERSION = '2025-06-18'

export const TOOLS = Object.freeze([
  {
    name: 'api_impact',
    description: '查一个后端接口（方法 + 路径）在各前端项目里在不在用、哪些菜单在用、引用方文件、定义位置、什么时候停用的。改接口、删接口、改调用前先查',
    inputSchema: { type: 'object', properties: { api: { type: 'string', description: '接口，如 "GET /template/v2/{}"；不写方法就查所有方法；${id} 这种参数写法也行' } }, required: ['api'] }
  },
  {
    name: 'similar_apis',
    description: '找路径相似的已有接口。新增接口前先查，避免同一个接口写两遍',
    inputSchema: { type: 'object', properties: { api: { type: 'string', description: '打算新增的接口或路径' }, limit: { type: 'number', description: '最多返回几个，默认 10' } }, required: ['api'] }
  },
  {
    name: 'search_apis',
    description: '按路径里的一段文字搜接口（不分大小写）',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }
  },
  {
    name: 'file_info',
    description: '查一个源码文件里定义了哪些接口（在不在用、哪些菜单在用）、有哪些没人用的导出。改文件、删函数前先查',
    inputSchema: { type: 'object', properties: { file: { type: 'string', description: '相对仓库根目录的路径，如 src/api/user.js' }, project: { type: 'string', description: '只看这个项目（结果里的项目名）' } }, required: ['file'] }
  },
  {
    name: 'check_change',
    description: '对比两个提交的接口变化：地址改了、新增的和已有的很像、在用变成没人用、多处定义等。只能检查启动服务时登记过的项目；要跑分析，十几秒',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目名（启动服务时 --check 登记的，即仓库目录名）' },
        base: { type: 'string', description: '目标分支或提交，如 origin/master' },
        head: { type: 'string', description: '当前提交，默认 HEAD' }
      },
      required: ['project', 'base']
    }
  }
])

/**
 * 处理一条请求，返回响应（通知返回 null）
 * @param {object} msg
 * @param {{dir: string, projects?: Map<string, {root: string, profile: string}>, check?: Function}} ctx
 *   dir：结果目录；projects：允许 check_change 的项目（名字 → 仓库目录、profile）；check：测试时替换 check_change 的实现
 */
export async function handle(msg, ctx) {
  const reply = (result) => ({ jsonrpc: '2.0', id: msg.id, result })
  const error = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } })
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return error(-32600, '不是 JSON-RPC 2.0 请求')
  const isNotification = msg.id === undefined
  switch (msg.method) {
    case 'initialize':
      return reply({ protocolVersion: msg.params?.protocolVersion ?? PROTOCOL_VERSION, capabilities: { tools: {} }, serverInfo: { name: TOOL.name, version: TOOL.version } })
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null
    case 'ping':
      return reply({})
    case 'tools/list':
      return reply({ tools: TOOLS })
    case 'tools/call': {
      const name = msg.params?.name
      const args = msg.params?.arguments ?? {}
      try {
        const data = await callTool(name, args, ctx)
        return reply({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })
      } catch (e) {
        // 工具自己的错误（参数不对、结果文件坏了）按 MCP 的约定放在结果里，让模型看得到原因
        return reply({ content: [{ type: 'text', text: e.message }], isError: true })
      }
    }
    default:
      return isNotification ? null : error(-32601, `不支持的方法：${msg.method}`)
  }
}

async function callTool(name, args, ctx) {
  const need = (k) => {
    if (typeof args[k] !== 'string' || args[k].trim() === '') throw new Error(`缺少参数 ${k}`)
    return args[k]
  }
  if (name === 'check_change') {
    const projects = ctx.projects ?? new Map()
    const p = projects.get(need('project'))
    if (!p) throw new Error(projects.size === 0 ? 'check_change 没有可用的项目：启动服务时用 --check <仓库目录>::<profile> 登记' : `没有登记这个项目：${args.project}（可用的：${[...projects.keys()].join('、')}）`)
    const base = need('base')
    const head = args.head ?? 'HEAD'
    for (const rev of [base, head]) if (typeof rev !== 'string' || rev.startsWith('-')) throw new Error(`提交写法不对：${rev}`)
    const run = ctx.check ?? (await import('./check-tool.js')).runCheck
    return run({ root: p.root, profile: p.profile, base, head, dir: ctx.dir })
  }
  const index = loadIndex(resultFiles(ctx.dir))
  if (name === 'api_impact') return apiImpact(index, need('api'))
  if (name === 'similar_apis') return similarApis(index, need('api'), { limit: Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 10 })
  if (name === 'search_apis') return searchApis(index, need('text'))
  if (name === 'file_info') return fileInfo(index, need('file'), args.project)
  throw new Error(`没有这个工具：${name}`)
}

export function resultFiles(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort().map((f) => join(dir, f))
  if (files.length === 0) throw new Error(`结果目录里没有 .json：${dir}（先用 code-audit api / exports 生成）`)
  return files
}

/**
 * 跑服务：按行读 stdin，一行一条请求；同一时间可能有多条在处理，各自写回
 * @param {{dir: string, projects?: Map<string, {root: string, profile: string}>, input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream}} opts
 */
export function serve({ dir, projects = new Map(), input = process.stdin, output = process.stdout }) {
  let buf = ''
  const write = (obj) => output.write(`${JSON.stringify(obj)}\n`)
  input.setEncoding?.('utf8')
  input.on('data', (chunk) => {
    buf += chunk
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: '不是合法的 JSON' } })
        continue
      }
      handle(msg, { dir, projects }).then((res) => res && write(res), (e) => write({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: e.message } }))
    }
  })
}
