import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildContext, redact, envValue } from '../src/context/index.js'
import { resolveConfig } from '../src/core/config.js'
import { createRepo } from './helpers/repo.js'

test('redact / envValue：主机名、IP、密钥类取值隐藏；路径前缀保留', () => {
  assert.equal(redact("baseURL: 'https://api.corp.local:8443/v1'"), "baseURL: 'https://<host>/v1'")
  assert.equal(redact('// 部署在 10.1.2.3:8080 上'), '// 部署在 <ip> 上')
  assert.equal(envValue('VITE_API_TOKEN', 'abc'), '<已隐藏>')
  assert.equal(envValue('VITE_API_KEY', '/k-123'), '<已隐藏>', '密钥类的变量，取值长得像路径也隐藏')
  assert.equal(envValue('VITE_BASE_API', '/api'), '/api')
  assert.equal(envValue('VITE_PROXY', 'http://192.168.0.5:9000/x'), 'http://<host>/x')
  assert.equal(envValue('VITE_HOST', 'internal-host'), '<已隐藏>', '不是路径也不是网址的取值也隐藏（可能是主机名）')
})

test('buildContext：依赖、别名（tsconfig 带注释）、入口和路由、.env、请求封装排在只调用请求的 api 文件前面、样本、已有 profile、覆盖报告；全文脱敏', () => {
  const repo = createRepo()
  try {
    repo.write('package.json', JSON.stringify({ name: 'c', dependencies: { vue: '3.4.0', axios: '1.0.0', '@corp/sdk': '1.0.0' }, devDependencies: { vite: '5.0.0', '@types/node': '20' }, scripts: { dev: 'vite --host 10.0.0.1' } }))
    repo.write('tsconfig.json', '{\n  // 注释\n  "compilerOptions": { "paths": { "@/*": ["./src/*"], }, },\n}\n')
    repo.write('vite.config.ts', "import path from 'path'\nexport default {\n  resolve: { alias: { '@': path.resolve(__dirname, 'src') } },\n  server: { proxy: { '/api': 'http://10.9.8.7:8080' } }\n}\n")
    repo.write('src/main.ts', "import router from './router'\nconsole.log(router)\n")
    repo.write('src/router/index.ts', "export default [{ path: '/order', component: () => import('@/views/order/index.vue') }]\n")
    repo.write('.env.production', 'VITE_BASE_API=/gateway\nVITE_API_SECRET=s3cr3t\nVITE_PROXY_URL=https://inner.corp.local/x\nOTHER=1\n')
    repo.write('src/utils/request.ts', "import axios from 'axios'\n// 内网地址 172.16.0.1\nconst http = axios.create({ baseURL: import.meta.env.VITE_BASE_API })\nhttp.interceptors.request.use((c) => c)\nexport default http\n")
    repo.write('src/api/order.ts', "import http from '@/utils/request'\nexport const list = () => http.get('/order/list')\nexport const one = () => fetch('/x')\nexport const two = () => fetch('/y')\nexport const three = () => fetch('/z')\n") // 只调用请求的文件，fetch 次数比封装文件多
    // 四个都像请求封装的文件：第四个不在前三里，会在样本里再读一次（同一个文件读两次不能出错）
    for (const n of ['a', 'b', 'c']) repo.write(`src/api/${n}.ts`, "export const x = () => fetch('/x')\n")
    repo.commit('i')
    const profile = resolveConfig({ entries: ['src/main.ts'], api: { version: 2, calls: [{ call: 'http.*(url, ...)' }] } })
    const previous = { rules: { version: 2 }, summary: { endpoints: 3 }, coverage: { suspects: [{ from: 'src/a.ts', line: 3, shape: 'legacy()', text: 'https://evil.corp/x' }], wrappers: [], dynamic: [], unknownMethod: [] } }
    const md = buildContext({ root: repo.root, profile, previous })
    for (const s of ['vue@3.4.0', 'axios@1.0.0', '@corp/sdk', '"@/*":["./src/*"]', "alias: { '@'", 'src/main.ts', 'src/router/index.ts', 'VITE_BASE_API=/gateway', 'VITE_API_SECRET=<已隐藏>', 'VITE_PROXY_URL=https://<host>/x', 'axios.create', 'src/api/order.ts：', '"version": 2', 'legacy() https://<host>/x', '## 请写出 profile']) {
      assert.ok(md.includes(s), `应包含：${s}`)
    }
    assert.ok(!md.includes('@types/node'), '常见的工具包不列进 SDK 候选')
    assert.ok(!md.includes('OTHER=1'), '和接口地址无关的变量不列')
    assert.ok(md.indexOf('src/utils/request.ts：') < md.indexOf('src/api/order.ts：'), '定义请求方式的文件排在只调用请求的文件前面')
    assert.doesNotMatch(md, /\b\d{1,3}(\.\d{1,3}){3}\b/, '没有 IP')
    assert.doesNotMatch(md, /(https?):\/\/(?!<host>)/, '没有主机名')
    assert.ok(!md.includes('s3cr3t'))
  } finally {
    repo.cleanup()
  }
})

test('buildContext：没有 package.json、没有路由和 api 目录时说明情况，不报错', () => {
  const repo = createRepo()
  try {
    repo.write('lib/x.js', 'export const a = 1\n')
    repo.commit('i')
    const md = buildContext({ root: repo.root })
    assert.match(md, /仓库根目录没有 package\.json/)
    assert.match(md, /没找到常见写法/)
    assert.match(md, /没有 api、services 这类目录/)
  } finally {
    repo.cleanup()
  }
})
