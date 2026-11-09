import { test } from 'node:test'               // Node 自带的测试框架
import assert from 'node:assert/strict'        // 断言：结果不对就报错
import { spawnSync } from 'node:child_process' // 像在终端里一样执行一条命令
import { fileURLToPath } from 'node:url'

// 入口文件的绝对路径：不管在哪个目录执行测试，都能找到它
const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))

// 相当于在终端执行：node bin/code-audit.js ...args
// status 是退出码，stdout 是正常输出，stderr 是错误输出。
function cli(...args) {
  return spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
}

test('不带参数时打印帮助', () => {
  const r = cli()
  assert.equal(r.status, 0)
  assert.match(r.stdout, /用法：code-audit/)
})

test('--help 列出全部命令', () => {
  const r = cli('--help')
  for (const name of ['scan', 'history', 'verify', 'report', 'quarantine']) {
    assert.match(r.stdout, new RegExp(name))
  }
})

test('子命令能收到剩下的参数', () => {
  // 用还是空壳的 quarantine 来测分发：空壳会原样打印收到的参数
  const r = cli('quarantine', '--file', 'a.js')
  assert.equal(r.status, 0)
  assert.match(r.stdout, /quarantine: 未实现/)
  assert.match(r.stdout, /a\.js/)
})

test('未知命令的退出码为 1', () => {
  const r = cli('abc')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /未知命令：abc/)
})