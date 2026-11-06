import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATUSES } from '../src/core/schema.js'

const dir = fileURLToPath(new URL('./fixtures/', import.meta.url))

// fixtures 下的每个子目录就是一个 fixture
const names = readdirSync(dir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name)

for (const name of names) {
  test(`fixture ${name}：标准答案本身没写错`, () => {
    const root = join(dir, name)
    const expected = JSON.parse(readFileSync(join(root, 'expected.json'), 'utf8'))

    for (const entry of expected.entries) {
      assert.ok(existsSync(join(root, 'project', entry)), `入口不存在：${entry}`)
    }

    const ids = new Set()
    for (const item of expected.items) {
      assert.ok(STATUSES.includes(item.status), `${item.id} 的状态不合法：${item.status}`)
      assert.ok(!ids.has(item.id), `id 重复：${item.id}`)
      ids.add(item.id)

      // 从 id 取出文件路径：去掉 "file:" / "export:"，再去掉 "#名字"
      const file = item.id.replace(/^\w+:/, '').split('#')[0]
      assert.ok(existsSync(join(root, 'project', file)), `文件不存在：${file}`)
    }
  })
}