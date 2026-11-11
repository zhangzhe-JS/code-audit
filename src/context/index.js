/**
 * code-audit context：整理「生成项目配置」需要的材料，交给任意大模型
 *
 * 规则（profile 的 entries、aliases、api、menus）不靠人手写：模型读这份材料写出 profile，
 * 再用 code-audit api 的覆盖报告验证、补规则，直到清零。工具不调用任何模型，只负责把材料整理好、把结果验证好
 *
 * 材料：项目基本信息（框架、请求库等依赖）、路径别名、入口和路由、.env 里和接口地址有关的变量、疑似请求封装的文件、
 * 几份 api 文件的样本、已有的 profile、上一次扫描的覆盖报告（给了的话），以及 profile 的写法和约束
 *
 * 脱敏：材料可能发给外部模型。.env 只留以 / 开头的路径取值，带 token / key / secret / password 的变量取值隐藏，
 * 完整网址的主机名换成 <host>；代码片段里的 http(s)://主机 也换掉。材料开头写明要按公司规定确认后再发
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSnapshot } from '../collect/snapshot.js'

const HTTP_LIBS = ['axios', 'ky', 'umi-request', 'alova', 'ofetch', 'superagent', 'got', 'node-fetch', 'cross-fetch', 'swr', '@tanstack/vue-query', '@tanstack/react-query', '@vueuse/core', '@microsoft/fetch-event-source', 'graphql', '@apollo/client', 'vue-request', 'ahooks']
const FRAMEWORKS = ['vue', 'react', 'svelte', 'solid-js', 'preact', 'nuxt', 'next', '@angular/core', 'vite', 'webpack', '@vue/cli-service', 'vue-router', 'react-router', 'react-router-dom', 'vuex', 'pinia', 'redux', '@reduxjs/toolkit', 'mobx', 'unplugin-auto-import', 'unplugin-vue-components', 'element-ui', 'element-plus', 'ant-design-vue', 'antd', 'vant']
const MAX_LINES = 120

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} [opts.rev]
 * @param {object|null} [opts.profile]  已有的 profile（resolveConfig 后的），有就附上让模型在它的基础上改
 * @param {object|null} [opts.previous] 上一次 code-audit api 的结果，有就附上覆盖报告
 * @returns {string} Markdown
 */
export function buildContext({ root, rev = 'HEAD', profile = null, previous = null }) {
  const snap = createSnapshot(root, rev)
  try {
    const all = snap.list(['.'])
    // 每个文件只从提交里解出一次（同一个文件可能既是请求封装又在样本里）
    const cache = new Map()
    const read = (f) => {
      if (!cache.has(f)) {
        snap.extract([f])
        cache.set(f, readFileSync(join(snap.dir, f), 'utf8'))
      }
      return cache.get(f)
    }
    const out = []
    out.push('# 生成 code-audit 项目配置的材料', '')
    out.push('> 这份材料里有项目的代码片段和配置。发给外部模型前，请确认符合公司的保密规定。主机名、密钥类取值已经隐藏。', '')
    out.push(`提交：${snap.commit}　源码文件：${all.filter((f) => /\.(js|jsx|ts|tsx|vue|svelte|mjs|cjs)$/.test(f)).length} 个`, '')

    // 1. 依赖
    const pkg = all.includes('package.json') ? safeJson(read('package.json')) : null
    out.push('## 项目依赖', '')
    if (!pkg) out.push('（仓库根目录没有 package.json）')
    else {
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) }
      const pick = (list) => list.filter((d) => d in deps).map((d) => `${d}@${deps[d]}`)
      out.push(`- 框架 / 构建 / 路由 / 状态：${pick(FRAMEWORKS).join('、') || '无'}`)
      out.push(`- 请求相关：${pick(HTTP_LIBS).join('、') || '无（可能用 fetch 或自己封装）'}`)
      const scoped = Object.keys(deps).filter((d) => d.startsWith('@') && !FRAMEWORKS.includes(d) && !HTTP_LIBS.includes(d) && !/^@(types|vue|vitejs|babel|eslint|typescript-eslint|rollup|esbuild)\//.test(d))
      out.push(`- 带 scope 的包（可能有自家 SDK，SDK 里发的请求要写进 api.sdk）：${scoped.join('、') || '无'}`)
      out.push(`- scripts：${redact(Object.entries(pkg.scripts ?? {}).map(([k, v]) => `${k}=${v}`).join('；')) || '无'}`)
    }
    out.push('')

    // 2. 别名
    out.push('## 路径别名', '')
    for (const f of ['tsconfig.json', 'jsconfig.json', 'tsconfig.app.json'].filter((x) => all.includes(x))) {
      const paths = safeJson(stripJsonComments(read(f)))?.compilerOptions?.paths
      if (paths) out.push(`- ${f} 的 compilerOptions.paths：\`${JSON.stringify(paths)}\``)
    }
    for (const f of all.filter((x) => /^(vite|vue|webpack)\.config\.(js|ts|mjs|cjs|mts)$/.test(x) || /^(vite-config|config|build)\/[^/]*resolve[^/]*\.(js|ts)$/.test(x))) {
      const lines = read(f).split('\n')
      const hits = lines.map((l, i) => (/alias|resolve\(|@'|"@"/.test(l) ? i : -1)).filter((i) => i >= 0)
      if (hits.length === 0) continue
      const from = Math.max(0, hits[0] - 2)
      out.push(`- ${f}（含 alias 的部分）：`, '', fence(redact(lines.slice(from, Math.min(lines.length, hits[0] + 20)).join('\n')), f), '')
    }
    out.push('')

    // 3. 入口、路由
    const entries = all.filter((f) => /^(src|app)\/(main|index)\.(js|ts|jsx|tsx)$/.test(f) || /^(src\/)?(App|app)\.(vue|jsx|tsx)$/.test(f))
    out.push('## 入口和路由', '', `- 可能的入口：${entries.join('、') || '没找到常见写法（src/main.*、src/index.*），请看 package.json 和构建配置'}`)
    const routers = all.filter((f) => /(^|\/)(router|routes)(\/|\.)/.test(f) && /\.(js|ts)$/.test(f) && !/\.(test|spec)\./.test(f)).slice(0, 8)
    out.push(`- 路由相关的文件：${routers.join('、') || '没找到'}`, '')
    const mainRouter = routers.find((f) => /router\/(index|router)\.(js|ts)$/.test(f)) ?? routers[0]
    if (mainRouter) out.push(`主路由文件 ${mainRouter}（菜单划分 menus 要按它写：具体菜单只写路由对应的页面入口文件）：`, '', fence(redact(head(read(mainRouter), MAX_LINES)), mainRouter), '')

    // 4. .env
    const envFiles = all.filter((f) => /^\.env(\.|$)/.test(f))
    out.push('## .env 里和接口地址有关的变量', '')
    const envLines = []
    for (const f of envFiles) {
      for (const line of read(f).split('\n')) {
        const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/.exec(line)
        if (!m || !/(BASE|API|URL|PREFIX|PROXY|GATEWAY|HOST)/i.test(m[1])) continue
        envLines.push(`- ${f}：${m[1]}=${envValue(m[1], m[2])}`)
      }
    }
    out.push(...(envLines.length ? envLines : ['（没有）']), '')

    // 5. 请求封装、api 样本
    const code = all.filter((f) => /\.(js|ts|jsx|tsx|vue|mjs)$/.test(f) && !/(^|\/)(node_modules|dist|tests?|__tests__)\//.test(f) && !/\.(test|spec|d)\./.test(f))
    const scored = []
    for (const f of code) {
      if (scored.length > 400) break
      if (!/(request|http|fetch|api|service|axios|client)/i.test(f)) continue
      const text = read(f)
      // 给「定义请求方式」的写法打分（建实例、拦截器、基础地址），只是调用请求函数的 api 文件不加分
      const count = (re) => (text.match(re) ?? []).length
      const score = 3 * count(/axios\.create|ky\.create|ky\.extend|createFetch|create\w*(Request|Client|Instance|Http)\s*\(|\binterceptors\b/g) +
        2 * count(/\bbaseURL\b|\bbaseUrl\b/g) +
        count(/\bfetch\(|new XMLHttpRequest|\$fetch\(|axios\(/g)
      if (score > 0) scored.push({ f, score, text })
    }
    scored.sort((a, b) => b.score - a.score)
    out.push('## 疑似请求封装的文件（请求是怎么发出去的，api.calls 要按这里的写法写）', '')
    for (const s of scored.slice(0, 3)) out.push(`${s.f}：`, '', fence(redact(head(s.text, MAX_LINES)), s.f), '')
    if (scored.length === 0) out.push('（没找到 axios.create、fetch( 这类写法；请看 api 样本里调用的是什么函数）', '')
    const samples = code.filter((f) => /(^|\/)(api|apis|services?|requests?)\//.test(f) && !scored.slice(0, 3).some((s) => s.f === f)).slice(0, 4)
    out.push('## api 文件样本（各取开头一段）', '')
    for (const f of samples) out.push(`${f}：`, '', fence(redact(head(read(f), 60)), f), '')
    if (samples.length === 0) out.push('（没有 api、services 这类目录：请求可能写在组件里，用 code-audit api 的覆盖报告找）', '')

    // 6. 已有的 profile、覆盖报告
    if (profile) {
      out.push('## 已有的 profile（在它的基础上改）', '')
      out.push(fence(JSON.stringify({ sourceRoots: profile.sourceRoots, entries: profile.entries, aliases: profile.aliases, testEntries: profile.testEntries, api: profile.api, menus: profile.menus }, null, 2), 'json'), '')
    }
    if (previous?.coverage) {
      const c = previous.coverage
      const list = (title, xs, fmt) => (xs?.length ? [`- ${title}（${xs.length}）：`, ...xs.slice(0, 30).map((x) => `  - ${fmt(x)}`)] : [])
      out.push('## 上一次扫描的覆盖报告（要补的规则）', '')
      out.push(`规则版本 ${previous.rules?.version}，接口 ${previous.summary?.endpoints} 个`)
      out.push(...list('像请求但没有规则命中的调用', c.suspects, (x) => `${x.from}:${x.line} ${x.shape} ${redact(x.text)}`))
      out.push(...list('地址由参数传入的封装函数', c.wrappers, (x) => `${x.from}:${x.line} ${x.fn}（参数 ${x.param}）`))
      out.push(...list('算不出地址的定义', c.dynamic, (x) => `${x.from}:${x.line} ${x.fn} ${redact(String(x.raw ?? '整个是变量'))}`))
      out.push(...list('方法算不出的定义', c.unknownMethod, (x) => `${x.from}:${x.line} ${x.fn} ${x.path}`))
      out.push('')
    }

    // 7. 要求
    out.push(INSTRUCTIONS)
    return `${out.join('\n')}\n`
  } finally {
    snap.cleanup()
  }
}

export const INSTRUCTIONS = `## 请写出 profile

输出一个 JS 文件，\`export default { ... }\`，只写和默认值不同的项：

- \`entries\`：项目入口（必填，没有默认值），如 \`['src/main.ts']\`
- \`aliases\`：路径别名 → 目录，照抄构建配置 / tsconfig，如 \`{ '@': 'src' }\`
- \`sourceRoots\`：源码目录，默认 \`['src']\`
- \`testEntries\`：测试文件的 glob（有测试的话），如 \`['src/**/*.test.ts']\`
- \`api\`：请求是怎么发出去的
  - \`version\`：从 1 开始，改一次加 1
  - \`calls\`：照着代码写调用的样子，参数换成占位：\`url\` 地址、\`method\` 方法、\`_\` 任意一个参数、\`...\` 后面还有参数、\`{url, method}\` 对象参数里的属性、
    成员名写 \`*\` 表示 get / post 这类 HTTP 方法名。例：\`request({url, method})\`、\`http.*(url, ...)\`、\`client(_)(url, ...).*()\`、\`upload(url, ...)\`（要写 \`method: 'POST'\`）。
    模板里看不出方法时要写 \`method\`；能看出但可能取不到时写 \`defaultMethod\`
  - \`attrs\`：模板里写地址的属性，如 \`{ tag: 'el-upload', attr: 'action', method: 'POST' }\`
  - \`prefixes\`：要去掉的网关前缀，如 \`['/api']\`（看 .env 和请求封装里的 baseURL）
  - \`sdk\`：自家 SDK 内部发的请求（项目代码里看不到）：\`{ method, path, package, via: ['SDK 导出的函数名'] }\`
  - \`examples\`：每条 calls 至少给一个例子：\`{ raw: '代码里的原始地址', method: 'GET', expect: 'GET /归一化后的路径' }\`
- \`menus\`：菜单划分（可选）：\`{ name: '菜单名', files: ['路由对应的页面入口文件'] }\`，具体菜单只写页面入口、不写整个目录；
  布局、入口、启动配置这类写一个 \`global: true\` 的菜单

约束：

- 只写在材料里看得到依据的规则，看不出的不要猜，在文件末尾用注释列出「需要人确认的地方」
- 不要把封装函数内部的那次调用（如 axios 实例的 get）当成接口定义：写封装函数被调用的样子
- 写完后用这条命令验证，按覆盖报告补规则，直到「没有需要补的规则」：
  \`code-audit api --root <仓库> --profile <这个文件> --out <结果.json>\`
- 补规则时把上一次的结果交给 \`code-audit context --previous <结果.json>\`，材料里会附上要补的地方
`

function head(text, n) {
  const lines = text.split('\n')
  return lines.length > n ? `${lines.slice(0, n).join('\n')}\n// ……后面还有 ${lines.length - n} 行` : text
}

function fence(text, name) {
  const lang = /\.(ts|tsx|mts)$/.test(name) ? 'ts' : /\.vue$/.test(name) ? 'vue' : name === 'json' ? 'json' : 'js'
  const ticks = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((m) => m[0].length + 1)))
  return `${ticks}${lang}\n${text}\n${ticks}`
}

/** 代码片段里的主机名换成 <host>，IP 换成 <ip> */
export function redact(text) {
  return String(text)
    .replace(/\b(https?|wss?):\/\/[^\s'"`/)]+/g, '$1://<host>')
    .replace(/\b\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?\b/g, '<ip>') // 没写协议的 IP（注释、配置里常见）
}

/** .env 的取值：密钥类隐藏；路径（/ 开头）保留；完整网址只留路径 */
export function envValue(name, raw) {
  const v = raw.trim().replace(/^['"]|['"]$/g, '')
  if (/(TOKEN|KEY|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i.test(name)) return '<已隐藏>'
  if (v === '' || v.startsWith('/')) return v
  if (/^[a-z]+:\/\//i.test(v)) return redact(v)
  return '<已隐藏>'
}

function safeJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** tsconfig 允许注释和结尾逗号 */
function stripJsonComments(text) {
  let out = ''
  let inStr = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inStr) {
      out += c
      if (c === '\\') out += text[++i] ?? ''
      else if (c === '"') inStr = false
    } else if (c === '"') {
      inStr = true
      out += c
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++
    } else {
      out += c
    }
  }
  return out.replace(/,\s*([}\]])/g, '$1')
}
