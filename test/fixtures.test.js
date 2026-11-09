import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { STATUSES } from '../src/core/schema.js'
import { scan } from '../src/collect/scan.js'
import { findKnip } from '../src/collect/knip.js'
import { resolveConfig } from '../src/core/config.js'
import { NOT_JUDGED } from '../src/rules/index.js'
import { createRepo } from './helpers/repo.js'

/**
 * 已经做好规则的状态：这些状态要和标准答案完全一致。
 * 其余状态的规则还没做，只检查文件被列为候选、暂时标着「未判定」。每做完一条规则就加进来
 */
const IMPLEMENTED = new Set(['unknown', 'external', 'dormant'])

let hasKnip = true
try {
  findKnip()
} catch {
  hasKnip = false
}
const needsKnip = hasKnip ? {} : { skip: '没有安装 knip（code-audit 的可选依赖）' }

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
for (const name of names) {
  test(`fixture ${name}：scan 的结论和标准答案一致（已做的规则）`, needsKnip, (t) => {
    const expected = JSON.parse(readFileSync(join(dir, name, 'expected.json'), 'utf8'))
    const repo = createRepo()
    t.after(() => repo.cleanup())
    cpSync(join(dir, name, 'project'), repo.root, { recursive: true })
    repo.commit('fixture')

    const { candidates } = scan({ root: repo.root, project: name, config: resolveConfig({ entries: expected.entries, ...expected.config }) })
    const got = new Map(candidates.files.map((f) => [f.file, f]))

    // 导出维度还没做，只看文件
    for (const item of expected.items.filter((i) => i.id.startsWith('file:'))) {
      const file = item.id.slice('file:'.length)
      const c = got.get(file)
      if (item.status === 'live') {
        assert.equal(c, undefined, `${file} 在用，不该列为候选`)
      } else if (IMPLEMENTED.has(item.status)) {
        assert.equal(c?.status, item.status, `${file} 应为 ${item.status}`)
      } else {
        assert.ok(c, `${file} 应列为候选`)
        assert.ok(c.evidence.some((e) => e.rule === NOT_JUDGED.evidence.rule), `${file} 的规则还没做，应标着未判定`)
      }
    }
  })
}
