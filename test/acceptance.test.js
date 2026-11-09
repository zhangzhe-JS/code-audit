/**
 * 验收测试：从候选清单到最终输出，完整走一遍 history --in → report
 * 用两个目录结构、约定都不同的项目，验证工具是通用的，不依赖某个项目的写法
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo } from './helpers/repo.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-acc-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 跑完整流程，返回输出目录 */
function runPipeline(t, repo, candidates, { profile, movedAt } = {}) {
  const dir = tempDir(t)
  writeFileSync(join(dir, 'candidates.json'), JSON.stringify(candidates))
  const profileArgs = []
  if (profile) {
    writeFileSync(join(dir, 'profile.js'), profile)
    profileArgs.push('--profile', join(dir, 'profile.js'))
  }

  const h = cli('history', '--root', repo.root, '--in', join(dir, 'candidates.json'), '--out', join(dir, 'data.json'), ...profileArgs)
  assert.equal(h.status, 0, h.stderr)

  const out = join(dir, 'out')
  const r = cli('report', '--in', join(dir, 'data.json'), '--out', out, ...profileArgs, ...(movedAt ? ['--moved-at', movedAt] : []))
  assert.equal(r.status, 0, r.stderr)
  return { out, stdout: r.stdout, data: JSON.parse(readFileSync(join(dir, 'data.json'), 'utf8')) }
}

test('项目一：默认约定（源码在 src/，隔离目录 src/_deprecated/，不写配置）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/utils/math.js', 'export const add = 1\n')
  repo.commit('新增 math', { date: '2024-01-01', author: 'alice' })
  repo.write('src/views/Home.vue', "<script>\nimport { add } from '@/utils/math'\n</script>\n")
  repo.commit('首页使用', { date: '2024-02-01', author: 'bob' })
  repo.write('src/views/Home.vue', '<script>\nexport default {}\n</script>\n')
  repo.commit('首页去掉', { date: '2024-03-01', author: 'carol' })
  // 隔离：移动并加头注释（git 认不出是改名）
  repo.run(['rm', '-q', 'src/utils/math.js'])
  repo.write('src/_deprecated/math.js', '/**\n' + ' * 旧注释\n'.repeat(20) + ' */\nexport const add = 1\n')
  repo.commit('隔离', { date: '2024-04-01' })

  const { out, data } = runPipeline(t, repo, {
    project: 'web-default',
    entries: ['src/main.js'],
    files: [{ file: 'src/_deprecated/math.js', notes: ['恢复前确认依赖'] }]
  }, { movedAt: '2024-04-01' })

  const item = data.items[0]
  assert.equal(item.history.pattern, 'utils/math') // 从原路径推出
  assert.equal(item.history.lostRef.subject, '首页去掉')

  const header = readFileSync(join(out, 'headers/src/_deprecated/math.js.txt'), 'utf8')
  assert.match(header, /^\/\*\*\n \* \[code-audit\] 文件排查记录\n/)
  assert.match(header, / \* 原路径：src\/utils\/math\.js\n/)
  assert.match(header, / \* 移入：2024-04-01\n/)
  assert.match(header, /失去引用：2024-03-01 \w+ carol「首页去掉」/)

  const report = readFileSync(join(out, 'report.md'), 'utf8')
  assert.match(report, /^# 排查报告：web-default\n/)
  assert.match(report, /搜索的引用写法：`utils\/math`/)
  assert.match(readFileSync(join(out, 'quarantine-table.md'), 'utf8'), /\| src\/_deprecated\/math\.js \| src\/utils\/math\.js \|/)
})

test('项目二：不同约定（源码在 app/、.svelte 和 .astro 文件、英文文案、自定义表格列）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('app/lib/format.ts', 'export const fmt = (s: string) => s\n')
  repo.write('app/components/Old.svelte', '<script>\nexport let x\n</script>\n')
  repo.commit('init', { date: '2024-01-01', author: 'dana' })
  repo.write('app/pages/index.astro', "---\nimport { fmt } from '~/lib/format'\n---\n")
  repo.commit('page uses fmt', { date: '2024-02-01', author: 'erin' })
  repo.run(['rm', '-q', 'app/pages/index.astro'])
  repo.write('app/pages/other.ts', 'export {}\n')
  repo.commit('drop page', { date: '2024-03-01', author: 'frank' })

  const profile = `export default {
    sourceRoots: ['app'],
    extensions: ['.ts', '.svelte', '.astro'],
    shortHashLength: 7,
    headerTitle: '@deprecated code-audit record',
    headerFooter: ['Restore: move back and update legacy/README.md'],
    statusLabels: { unknown: 'needs review' },
    tableColumns: ['target', 'status', 'lostRef'],
    columnTitles: { target: 'File', status: 'Status', lostRef: 'Last reference removed' }
  }\n`

  const { out, stdout, data } = runPipeline(t, repo, {
    project: 'site-custom',
    files: [{ file: 'app/lib/format.ts' }, { file: 'app/components/Old.svelte' }]
  }, { profile })

  // 源码根目录 app/、.astro 里的引用都按配置找到了
  const fmt = data.items.find((i) => i.target === 'app/lib/format.ts')
  assert.equal(fmt.history.pattern, 'lib/format')
  assert.deepEqual(fmt.history.timeline.map((e) => `${e.change} ${e.from}`), ['add app/pages/index.astro', 'remove app/pages/index.astro'])

  // .ts 用块注释，.svelte 用 HTML 注释；文案、提交号长度来自配置
  const ts = readFileSync(join(out, 'headers/app/lib/format.ts.txt'), 'utf8')
  assert.match(ts, /^\/\*\*\n \* @deprecated code-audit record\n \* 状态：unknown（needs review）\n/)
  assert.match(ts, / \* Restore: move back and update legacy\/README\.md\n \*\/\n$/)
  assert.match(ts, /失去引用：2024-03-01 [0-9a-f]{7} frank「drop page」/)
  const svelte = readFileSync(join(out, 'headers/app/components/Old.svelte.txt'), 'utf8')
  assert.match(svelte, /^<!--\n  @deprecated code-audit record\n/)
  assert.match(svelte, /\n-->\n$/)

  // 表格只有配置的三列，英文标题
  const table = readFileSync(join(out, 'quarantine-table.md'), 'utf8')
  assert.match(table, /^\| File \| Status \| Last reference removed \|\n/)
  assert.match(table, /\| app\/components\/Old\.svelte \| unknown（needs review） \| 从未被引用 \|/)

  assert.match(stdout, /头注释 2 个/)
  assert.deepEqual(readdirSync(join(out, 'headers/app')).sort(), ['components', 'lib'])
})
