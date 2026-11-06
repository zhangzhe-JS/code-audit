import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { DEFAULT_CONFIG, resolveConfig, loadProfile } from '../src/core/config.js'

test('不传配置时得到默认值', () => {
  assert.deepEqual(resolveConfig(), DEFAULT_CONFIG)
})

test('只覆盖写了的项，其余用默认值', () => {
  const c = resolveConfig({ sourceRoots: ['app'] })
  assert.deepEqual(c.sourceRoots, ['app'])
  assert.deepEqual(c.extensions, DEFAULT_CONFIG.extensions)
  assert.equal(c.shortHashLength, DEFAULT_CONFIG.shortHashLength)
})

test('配置项拼错时报错，不悄悄忽略', () => {
  assert.throws(() => resolveConfig({ sourceRoot: ['app'] }), /不认识的配置项：sourceRoot/)
})

test('各配置项类型不对时报错，一次列出所有错误', () => {
  assert.throws(
    () => resolveConfig({ sourceRoots: ['/abs'], extensions: ['js'], shortHashLength: 2 }),
    (e) => /sourceRoots/.test(e.message) && /extensions/.test(e.message) && /shortHashLength/.test(e.message)
  )
  assert.throws(() => resolveConfig({ sourceRoots: ['src/'] }), /sourceRoots/) // 不能以 / 结尾
  assert.throws(() => resolveConfig({ extensions: [] }), /extensions/)
  assert.throws(() => resolveConfig(null), /配置必须是对象/)
})

test('得到的配置不能被修改，避免某处代码悄悄改了全局配置', () => {
  const c = resolveConfig()
  assert.throws(() => { c.sourceRoots.push('x') })
  assert.throws(() => { DEFAULT_CONFIG.extensions.push('.x') })
})

test('示例配置文件能正常加载', async () => {
  const file = fileURLToPath(new URL('../profiles/example.js', import.meta.url))
  const c = await loadProfile(file)
  assert.ok(c.extensions.includes('.astro'))
})
