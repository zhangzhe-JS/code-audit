import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRepo } from './helpers/repo.js'
import { componentName, findComponentVarUses, findSameNameTags } from '../src/collect/global-components.js'
import { exportNames, findAutoImports, findBareExportUses, findNameUses } from '../src/collect/auto-imports.js'
import { findExternalMaybe, findExternalRefs, joinedPaths } from '../src/collect/external-refs.js'
import { findCommentRefs, hashComments } from '../src/collect/comment-refs.js'
import { findGlobImports, globTailRegex } from '../src/collect/glob-imports.js'
import { lastFetch } from '../src/collect/branch-refs.js'
import { findKnip } from '../src/collect/knip.js'
import { scan } from '../src/collect/scan.js'
import { judge } from '../src/rules/index.js'
import { resolveConfig } from '../src/core/config.js'

let hasKnip = true
try {
  findKnip()
} catch {
  hasKnip = false
}
const needsKnip = hasKnip ? {} : { skip: '没有安装 knip（code-audit 的可选依赖）' }
const ev = [{ rule: 'knip-unreachable', detail: '走不到' }]

// ---------- ① 名字是变量的动态组件 ----------

test('findComponentVarUses：:is / v-bind:is 是变量、resolveComponent 参数是变量的都记下；写死字符串的不记', () => {
  const vue = ['<template>', '  <component :is="name" />', "  <component :is=\"'X'\" />", '  <component v-bind:is="pick(a)" />', '</template>', '<script setup>', 'const a = resolveComponent(n)', "const b = resolveComponent('Y')", '</script>'].join('\n')
  assert.deepEqual(findComponentVarUses([{ path: 'src/A.vue', content: vue }]).map((u) => [u.line, u.expr]), [
    [2, ':is="name"'],
    [4, 'v-bind:is="pick(a)"'],
    [7, 'resolveComponent(n)']
  ])
})

// ---------- ② 同名标签 ----------

test('componentName：从路径推组件名', () => {
  assert.equal(componentName('src/UserCard.vue'), 'UserCard')
  assert.equal(componentName('src/user-card/index.vue'), 'UserCard')
  assert.equal(componentName('src/my_card.vue'), 'MyCard')
  assert.equal(componentName('index.vue'), null)
})

test('findSameNameTags：在用的模板里有同名标签算 used，只在注释里的算 commented；自己 import 了同名组件的、单个单词的短横线写法不算', () => {
  const r = findSameNameTags({
    files: [
      { path: 'src/Page.vue', content: '<template>\n  <UserCard />\n  <!-- <old-card /> -->\n  <header />\n  <Header-x />\n</template>' },
      { path: 'src/Other.vue', content: "<template><UserCard /></template><script setup>import UserCard from './x/UserCard.vue'</script>" },
      { path: 'src/Named.vue', content: "<template><UserCard /></template><script setup>import { UserCard } from '@/ui'</script>" }
    ],
    targets: ['src/components/UserCard/index.vue', 'src/components/OldCard.vue', 'src/Header.vue']
  })
  assert.deepEqual([...r.used], [['src/components/UserCard/index.vue', [{ from: 'src/Page.vue', line: 2, tag: '<UserCard>' }]]])
  assert.deepEqual([...r.commented], [['src/components/OldCard.vue', [{ from: 'src/Page.vue', line: 3, tag: '<old-card>' }]]])
})

// ---------- ③ 换算不了的 glob ----------

test('findGlobImports：换算不了的 glob 记进 unresolved，按模式匹配；参数不是字符串的范围是整个仓库', () => {
  const r = findGlobImports({ files: [{ path: 'src/a.js', content: "import.meta.glob('~/views/**/*.vue')\nimport.meta.glob(pat)\nimport.meta.glob(['./ok/*.js', '!~/x/*.js'])" }] })
  assert.deepEqual(r.unresolved.map((u) => [u.line, u.expr, u.regex && String(u.regex)]), [
    [1, "import.meta.glob('~/views/**/*.vue')", String(globTailRegex('~/views/**/*.vue'))],
    [2, 'import.meta.glob(pat)', null]
  ])
  assert.ok(globTailRegex('~/views/**/*.vue').test('src/views/a/b.vue'))
  assert.ok(!globTailRegex('menu/*.js').test('src/menu/a/b.js'))
  assert.ok(globTailRegex('x/*.{js,ts}').test('src/x/a.ts'))
})

// ---------- ④ 自动导入 ----------

test('findAutoImports、findNameUses：读出登记的本地函数（别名、补扩展名、目录 index），按名字找用法', () => {
  const dts = "declare global {\n  const useTable: typeof import('./composables/useTable')['useTable']\n  const ref: typeof import('vue')['ref']\n  const fmt: typeof import('@/utils/fmt')['fmt']\n}"
  const a = findAutoImports({ files: [{ path: 'src/auto-imports.d.ts', content: dts }], sourceSet: new Set(['src/composables/useTable.ts', 'src/utils/fmt/index.ts']), extensions: ['.ts'], aliases: { '@': 'src' } })
  assert.equal(a.found, true)
  assert.deepEqual(a.declarations, ['src/auto-imports.d.ts'])
  assert.deepEqual([...a.names], [['useTable', 'src/composables/useTable.ts'], ['fmt', 'src/utils/fmt/index.ts']])
  const uses = findNameUses({ files: [{ path: 'src/A.vue', content: '<template>{{ fmt(x) }}</template><script setup>\nconst t = useTable()\nobj.useTable()\n// useTable()\n</script>' }], names: a.names })
  assert.deepEqual([...uses], [['src/composables/useTable.ts', [{ from: 'src/A.vue', line: 2 }]], ['src/utils/fmt/index.ts', [{ from: 'src/A.vue', line: 1 }]]])
  // 只登记了第三方库的：found 为 true，但不拿掉
  const only = findAutoImports({ files: [{ path: 'src/a.d.ts', content: "declare global { const ref: typeof import('vue')['ref'] }" }], sourceSet: new Set(), extensions: ['.ts'] })
  assert.deepEqual([only.found, only.declarations], [true, []])
})

test('findBareExportUses、exportNames：导出的名字被直接用到、又没 import / 自己定义', () => {
  assert.deepEqual(exportNames('export const a = 1\nexport async function b(){}\nexport { c, d as e, x as default }'), ['a', 'b', 'c', 'e'])
  const r = findBareExportUses({
    files: [
      { path: 'src/P.ts', content: 'helper(1)' },
      { path: 'src/Q.ts', content: "import { helper } from './x'\nhelper()" },
      { path: 'src/R.ts', content: 'function helper() {}\nhelper()' }
    ],
    targets: [{ path: 'src/dead.ts', content: 'export function helper(){}' }]
  })
  assert.deepEqual([...r], [['src/dead.ts', [{ from: 'src/P.ts', line: 1, name: 'helper' }]]])
})

// ---------- ⑤ external：相对路径、path.join、拼出来的 ----------

test('findExternalRefs：相对这个文件的路径、path.join / resolve 拼出来的；findExternalMaybe 兜底同名文件名', () => {
  const files = [
    {
      path: 'build/gen.js',
      content: [
        "const a = require('../src/menu.js')",
        "const b = path.join(__dirname, '..', 'src', 'stub.js')",
        "const c = path.resolve(process.cwd(), 'src/cfg.js')",
        "const d = path.join(ROOT, 'src/r.js')",
        "const e = 'src/old/' + v + '/legacy.js'",
        "const f = path.join(__dirname, 'src')"
      ].join('\n')
    }
  ]
  const targets = ['src/menu.js', 'src/stub.js', 'src/cfg.js', 'src/r.js', 'src/old/x/legacy.js', 'src/index.js']
  const found = findExternalRefs({ files, targets })
  assert.deepEqual(Object.fromEntries([...found].map(([k, v]) => [k, v.map((r) => r.line)])), {
    'src/menu.js': [1],
    'src/stub.js': [2],
    'src/cfg.js': [3],
    'src/r.js': [4]
  })
  assert.deepEqual([...findExternalMaybe({ files, targets, found })].map(([k, v]) => [k, v.map((r) => r.line)]), [['src/old/x/legacy.js', [5]]])
  assert.deepEqual(joinedPaths("path.join(name, x + '.js')", 'a.js'), [])
  // 相对这个文件所在目录的路径：路径里没有 src/，只能按文件目录解析
  const local = findExternalRefs({ files: [{ path: 'src/legacy/tool.cjs', content: "require('./widget.js')" }], targets: ['src/legacy/widget.js'] })
  assert.deepEqual([...local.keys()], ['src/legacy/widget.js'])
})

// ---------- ⑥ yml、sh 的 # 注释 ----------

test('hashComments、findCommentRefs：yml、sh 的 # 注释里的路径（不带引号也认）', () => {
  assert.deepEqual(hashComments('#!/bin/sh\na: 1 # x\n  # y'), [{ line: 2, text: ' x' }, { line: 3, text: ' y' }])
  const r = findCommentRefs({
    files: [
      { path: '.gitlab-ci.yml', content: 'build:\n  # script: node src/old/gen.js\n  script: node src/new.js # was src/legacy.vue\n' },
      { path: 'run.sh', content: '#!/bin/sh\nnode src/live.js # src/old/gen.js\n' }
    ],
    targets: ['src/old/gen.js', 'src/legacy.vue', 'src/new.js']
  })
  assert.deepEqual(Object.fromEntries([...r].map(([k, v]) => [k, v.map((x) => `${x.from}:${x.line}`)])), {
    'src/old/gen.js': ['.gitlab-ci.yml:2', 'run.sh:2'],
    'src/legacy.vue': ['.gitlab-ci.yml:3']
  })
})

// ---------- ⑦ 上次 fetch ----------

test('lastFetch：远程跟踪分支的个数、上次 fetch 是几天前（没 fetch 过为 null）', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('a.js', '')
  repo.commit('init')
  assert.deepEqual(lastFetch(repo.root), { count: 0, lastFetchDays: null })
  repo.run(['update-ref', 'refs/remotes/origin/x', 'HEAD'])
  writeFileSync(join(repo.root, '.git/FETCH_HEAD'), '')
  assert.deepEqual(lastFetch(repo.root), { count: 1, lastFetchDays: 0 })
})

// ---------- 规则 ----------

test('盲区规则：同名标签、疑似自动导入、拼出来的路径判 unknown；注释里的同名标签判 dormant；证据写明原因', () => {
  const r = Object.fromEntries(
    judge({
      files: ['src/A.vue', 'src/B.vue', 'src/c.ts', 'src/d.js'].map((file) => ({ file, evidence: ev })),
      blindSpots: {
        sameNameTags: new Map([['src/A.vue', [{ from: 'src/P.vue', line: 3, tag: '<A>' }]]]),
        commentedTags: new Map([['src/B.vue', [{ from: 'src/P.vue', line: 4, tag: '<B>' }]]]),
        bareExports: new Map([['src/c.ts', [{ from: 'src/P.ts', line: 1, name: 'helper' }]]]),
        externalMaybe: new Map([['src/d.js', [{ from: 'build/x.js', line: 2, text: "'d.js'" }]]])
      }
    }).map((x) => [x.file, x])
  )
  assert.deepEqual([r['src/A.vue'].status, r['src/B.vue'].status, r['src/c.ts'].status, r['src/d.js'].status], ['unknown', 'dormant', 'unknown', 'unknown'])
  assert.match(r['src/A.vue'].evidence[1].detail, /src\/P\.vue:3 的模板里有 <A>，和这个文件同名.*无法确认/)
  assert.match(r['src/c.ts'].evidence[1].detail, /直接用了它导出的 helper，没有 import/)
  assert.match(r['src/d.js'].evidence[1].detail, /路径可能是拼出来的/)
})

// ---------- scan 里接上：用假的 knip ----------

function fakeKnipDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-fakeknip-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'dist', 'types'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'knip', version: '0.0.0-test', bin: { knip: 'bin/knip.js' } }))
  writeFileSync(join(dir, 'bin', 'knip.js'), '')
  writeFileSync(join(dir, 'dist', 'types', 'PluginNames.js'), "export const pluginNames = ['vue'];\n")
  return dir
}
const fake = (unused) => () => ({ unusedFiles: unused, enabledPlugins: [] })

test('scan：名字是变量的 :is 让全局组件判 unknown；人工确认后放过，判 dead 并写明理由', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.ts', "import App from './App.vue'\n")
  repo.write('src/App.vue', '<template>\n  <component :is="current" />\n</template>\n')
  repo.write('src/components/Modal.vue', '<template><i /></template>\n')
  repo.write('src/components.d.ts', "declare module 'vue' { export interface GlobalComponents {\n  Modal: (typeof import('./components/Modal.vue'))['default']\n} }\n")
  repo.commit('init')
  const knipDir = fakeKnipDir(t)
  const run = fake(['src/components/Modal.vue'])
  let r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'] }), knipDir, run })
  assert.equal(r.candidates.files[0].status, 'unknown')
  assert.match(r.candidates.files[0].evidence[1].detail, /src\/App\.vue:2 动态加载：:is="current"；组件名是变量/)

  const reviewed = [{ from: 'src/App.vue', expr: ':is="current"', reason: '只会是路由组件' }]
  r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'], reviewedDynamicLoads: reviewed }), knipDir, run })
  assert.equal(r.candidates.files[0].status, 'dead')
  assert.match(r.candidates.files[0].evidence.at(-1).detail, /已人工确认不加载本地源码：只会是路由组件/)
})

test('scan：没有全局组件时，名字是变量的 :is 不影响判定', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.ts', "import App from './App.vue'\n")
  repo.write('src/App.vue', '<template><component :is="current" /></template>\n')
  repo.write('src/Old.vue', '<template><i /></template>\n')
  repo.commit('init')
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'] }), knipDir: fakeKnipDir(t), run: fake(['src/Old.vue']) })
  assert.equal(r.candidates.files[0].status, 'dead')
})

test('scan：同名标签判 unknown，注释里的判 dormant；换算不了的 glob 圈到的判 unknown；拼出来的路径判 unknown', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.ts', "import App from './App.vue'\nconst pages = import.meta.glob('~/pages/*.vue')\n")
  repo.write('src/App.vue', '<template>\n  <UserCard />\n  <!-- <OldBanner /> -->\n</template>\n')
  repo.write('src/widgets/UserCard.vue', '<template><i /></template>\n')
  repo.write('src/widgets/OldBanner.vue', '<template><i /></template>\n')
  repo.write('src/pages/About.vue', '<template><i /></template>\n')
  repo.write('src/data/seed.js', 'export default []\n')
  repo.write('scripts/seed.js', "const f = path.join(dir, name + '/seed.js')\nconst g = 'seed.js'\n")
  repo.write('src/lonely.js', '')
  repo.commit('init')
  const unused = ['src/widgets/UserCard.vue', 'src/widgets/OldBanner.vue', 'src/pages/About.vue', 'src/data/seed.js', 'src/lonely.js']
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'] }), knipDir: fakeKnipDir(t), run: fake(unused) })
  const by = Object.fromEntries(r.candidates.files.map((f) => [f.file, f]))
  assert.equal(by['src/widgets/UserCard.vue'].status, 'unknown')
  assert.equal(by['src/widgets/OldBanner.vue'].status, 'dormant')
  assert.equal(by['src/pages/About.vue'].status, 'unknown')
  assert.match(by['src/pages/About.vue'].evidence.map((e) => e.detail).join(), /glob 换算不了/)
  assert.equal(by['src/data/seed.js'].status, 'unknown')
  assert.equal(by['src/lonely.js'].status, 'dead')
  assert.deepEqual(r.summary.blindSpots.sameNameTags, 1)
})

test('scan：装了 unplugin-auto-import 却没有声明文件时，按导出名兜底判 unknown', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('package.json', JSON.stringify({ devDependencies: { 'unplugin-auto-import': '^0.17.0' } }))
  repo.write('src/main.ts', 'const t = useTable()\n')
  repo.write('src/composables/useTable.ts', 'export function useTable() { return 1 }\n')
  repo.write('src/composables/unused.ts', 'export function neverUsed() {}\n')
  repo.commit('init')
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'] }), knipDir: fakeKnipDir(t), run: fake(['src/composables/unused.ts', 'src/composables/useTable.ts']) })
  const by = Object.fromEntries(r.candidates.files.map((f) => [f.file, f.status]))
  assert.deepEqual(by, { 'src/composables/unused.ts': 'dead', 'src/composables/useTable.ts': 'unknown' })
  assert.equal(r.summary.blindSpots.autoImportWithoutDeclaration, true)
})

// ---------- 真正调用 knip：自动导入的声明文件 ----------

test('scan + knip：自动导入登记的本地函数，用到的算在用；没人用的列为候选；声明文件本身不算引用', needsKnip, (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('package.json', '{ "dependencies": { "vue": "^3.4.0" } }')
  repo.write('tsconfig.json', JSON.stringify({ include: ['src/**/*.ts', 'src/**/*.vue', 'src/auto-imports.d.ts'] }))
  repo.write('src/main.ts', "import App from './App.vue'\nexport default App\n")
  repo.write('src/App.vue', '<template>{{ fmt(1) }}</template>\n<script setup lang="ts">\nconst t = useTable()\n</script>\n')
  repo.write('src/composables/useTable.ts', "import { helper } from './helper'\nexport const useTable = () => helper\n")
  repo.write('src/composables/helper.ts', 'export const helper = 1\n')
  repo.write('src/utils/fmt.ts', 'export const fmt = (x: number) => x\n')
  repo.write('src/composables/useOld.ts', 'export const useOld = () => 1\n')
  repo.write(
    'src/auto-imports.d.ts',
    "export {}\ndeclare global {\n" +
      "  const useTable: typeof import('./composables/useTable')['useTable']\n" +
      "  const fmt: typeof import('./utils/fmt')['fmt']\n" +
      "  const useOld: typeof import('./composables/useOld')['useOld']\n" +
      "  const ref: typeof import('vue')['ref']\n}\n"
  )
  repo.commit('init')
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'] }) })
  assert.deepEqual(r.candidates.files.map((f) => [f.file, f.status]), [['src/composables/useOld.ts', 'dead']])
  assert.equal(r.summary.blindSpots.autoImports, 3)
})

test('findExternalRefs：省略扩展名的路径正好也是目录时有歧义，不算确认引用，记进 ambiguous；带扩展名的照常算', () => {
  const files = [{ path: 'scripts/gen.js', content: "const out = path.join(ROOT, 'src/i18n/menu')\nconst src = path.join(ROOT, 'src/i18n/menu.js')" }]
  const ambiguous = new Map()
  const isDir = (p) => p === 'src/i18n/menu'
  const found = findExternalRefs({ files: [{ path: 'scripts/a.js', content: files[0].content.split('\n')[0] }], targets: ['src/i18n/menu.js'], isDir, ambiguous })
  assert.equal(found.size, 0)
  assert.deepEqual(ambiguous.get('src/i18n/menu.js').map((r) => r.line), [1])
  assert.match(ambiguous.get('src/i18n/menu.js')[0].text, /也可能指同名目录 src\/i18n\/menu\//)
  const both = findExternalRefs({ files, targets: ['src/i18n/menu.js'], isDir, ambiguous: new Map() })
  assert.deepEqual(both.get('src/i18n/menu.js').map((r) => r.line), [2])
  // 不是目录时，省略扩展名照常算确认引用
  assert.equal(findExternalRefs({ files, targets: ['src/i18n/menu.js'] }).get('src/i18n/menu.js').length, 2)
})

test('reviewedDynamicLoads：expr 写 * 时放过这个文件里的所有动态加载；没用上时提示', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.ts', "import App from './App.vue'\n")
  repo.write('src/App.vue', '<template>\n  <component :is="a" />\n  <component :is="b" />\n</template>\n')
  repo.write('src/components/Modal.vue', '<template><i /></template>\n')
  repo.write('src/components.d.ts', "declare module 'vue' { export interface GlobalComponents {\n  Modal: (typeof import('./components/Modal.vue'))['default']\n} }\n")
  repo.commit('init')
  const reviewed = [
    { from: 'src/App.vue', expr: '*', reason: '都是图标' },
    { from: 'src/Gone.vue', expr: '*', reason: '已删除' }
  ]
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.ts'], reviewedDynamicLoads: reviewed }), knipDir: fakeKnipDir(t), run: fake(['src/components/Modal.vue']) })
  assert.equal(r.candidates.files[0].status, 'dead')
  assert.equal(r.candidates.files[0].evidence.filter((e) => e.rule === 'reviewed-dynamic-load').length, 2)
  assert.match(r.summary.warnings.map((w) => w.detail).join(), /src\/Gone\.vue 的动态加载（\*）\s?在这个提交里找不到/)
})
