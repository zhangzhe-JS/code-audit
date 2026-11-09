import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRepo } from './helpers/repo.js'
import { scan, SCAN_RULES } from '../src/collect/scan.js'
import { COMPILER_PLUGINS, findKnip } from '../src/collect/knip.js'
import { resolveConfig } from '../src/core/config.js'
import { validateCandidates } from '../src/history/batch.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

/** 本机有没有装 knip：没装时跳过真正调用 knip 的测试 */
let hasKnip = true
try {
  findKnip()
} catch {
  hasKnip = false
}
const needsKnip = hasKnip ? {} : { skip: '没有安装 knip（code-audit 的可选依赖）' }

/** 假的 knip 目录：只够 findKnip 和 readPluginNames 用，真正的运行由 fakeRun 代替 */
function fakeKnipDir() {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-fakeknip-'))
  mkdirSync(join(dir, 'bin'))
  mkdirSync(join(dir, 'dist', 'types'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'knip', version: '0.0.0-test', bin: { knip: 'bin/knip.js' } }))
  writeFileSync(join(dir, 'bin', 'knip.js'), '')
  writeFileSync(join(dir, 'dist', 'types', 'PluginNames.js'), "export const pluginNames = ['vite', 'vue'];\n")
  return dir
}

/**
 * 代替 runKnip：记下每次收到的配置；入口里有测试入口时，返回 withTests，否则返回 mainOnly
 */
function fakeRun({ mainOnly, withTests = [] }) {
  const calls = []
  const run = ({ config }) => {
    calls.push(config)
    const hasTests = config.entry.some((e) => e.includes('test'))
    return { unusedFiles: hasTests ? withTests : mainOnly, enabledPlugins: [] }
  }
  return { run, calls }
}

function sampleRepo() {
  const repo = createRepo()
  repo.write('src/main.js', "import './used.js'\n")
  repo.write('src/used.js', 'export const a = 1\n')
  repo.write('src/dead.js', 'export const b = 2\n')
  repo.write('src/helper.js', 'export const c = 3\n')
  repo.write('src/i18n/index.js', "export const m = import.meta.glob('./menu/*.js', { eager: true })\n")
  repo.write('src/i18n/menu/zh.js', 'export default {}\n')
  repo.write('src/mock/data.js', 'export default []\n')
  repo.write('src/tests/helper.test.js', "import '../helper.js'\n")
  repo.commit('init')
  return repo
}

// ---------- 用假的 knip：测 scan 自己的逻辑 ----------

test('scan：入口没写时报错，不猜默认入口', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  assert.throws(
    () => scan({ root: repo.root, project: 'p', config: resolveConfig({}), knipDir, run: fakeRun({ mainOnly: [] }).run }),
    /没有写 entries/
  )
})

test('scan：import.meta.glob 换算成入口交给 knip；参与分析的文件按源码目录和扩展名', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const fake = fakeRun({ mainOnly: [] })
  const config = resolveConfig({ entries: ['src/main.js'], extensions: ['.js', '.vue'], aliases: { '@': 'src' } })
  const r = scan({ root: repo.root, project: 'p', config, knipDir, run: fake.run })

  assert.equal(fake.calls.length, 1) // 没有测试入口：只跑一次
  assert.deepEqual(fake.calls[0].entry, ['src/main.js', 'src/i18n/menu/*.js'])
  assert.deepEqual(fake.calls[0].project, ['src/**/*.js', 'src/**/*.vue'])
  assert.deepEqual(fake.calls[0].paths, { '@': ['src'], '@/*': ['src/*'] })
  assert.equal(fake.calls[0].vite, false)
  assert.deepEqual(fake.calls[0].vue, { config: [], entry: [] })
  assert.deepEqual(r.summary.globs.map((g) => g.resolved), ['src/i18n/menu/*.js'])
})

test('scan：配置了测试入口时跑两次，区分「只有测试用到」；测试文件本身不列为候选', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const fake = fakeRun({
    mainOnly: ['src/dead.js', 'src/helper.js', 'src/tests/helper.test.js'],
    withTests: ['src/dead.js']
  })
  const config = resolveConfig({ entries: ['src/main.js'], testEntries: ['src/tests/**/*.test.js'] })
  const r = scan({ root: repo.root, project: 'p', config, knipDir, run: fake.run })

  assert.equal(fake.calls.length, 2)
  assert.deepEqual(fake.calls[1].entry.at(-1), 'src/tests/**/*.test.js')
  assert.deepEqual(
    r.candidates.files.map((f) => [f.file, f.evidence[0].rule]),
    [
      ['src/dead.js', SCAN_RULES.unreachable],
      ['src/helper.js', SCAN_RULES.testOnly]
    ]
  )
  assert.match(r.candidates.files[0].evidence[0].detail, /入口和测试入口都走不到（knip 0\.0\.0-test）/)
  assert.equal(r.summary.counts.skippedTests, 1)
  assert.equal(r.summary.counts.testOnly, 1)
})

test('scan：scanIgnore 匹配的文件不列为候选', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const fake = fakeRun({ mainOnly: ['src/dead.js', 'src/mock/data.js'] })
  const config = resolveConfig({ entries: ['src/main.js'], scanIgnore: ['src/mock/**'] })
  const r = scan({ root: repo.root, project: 'p', config, knipDir, run: fake.run })

  assert.deepEqual(r.candidates.files.map((f) => f.file), ['src/dead.js'])
  assert.equal(r.summary.counts.skippedIgnored, 1)
})

test('scan：分析提交里的代码，工作区的改动、未提交的文件都不看；提交号写进候选清单', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const head = repo.run(['rev-parse', 'HEAD'])
  // 工作区：删掉 main.js 里的 import、新建一个没提交的文件、暂存一处改动
  repo.write('src/main.js', '\n')
  repo.write('src/new.js', "import './dead.js'\n")
  repo.write('src/used.js', 'export const staged = 1\n')
  repo.run(['add', 'src/used.js'])
  const statusBefore = repo.run(['status', '--porcelain'])

  let seen
  const run = ({ root, config }) => {
    seen = {
      root,
      main: readFileSync(join(root, 'src/main.js'), 'utf8'),
      used: readFileSync(join(root, 'src/used.js'), 'utf8'),
      hasNew: existsSync(join(root, 'src/new.js')),
      hasPackage: existsSync(join(root, 'package.json'))
    }
    return { unusedFiles: ['src/dead.js'], enabledPlugins: [] }
  }
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run })

  assert.notEqual(seen.root, repo.root)
  assert.equal(seen.main, "import './used.js'\n")
  assert.equal(seen.used, 'export const a = 1\n')
  assert.equal(seen.hasNew, false)
  assert.equal(r.candidates.rev, head)
  assert.equal(r.summary.rev, head)
  // 用完删掉临时目录；目标仓库的工作区、暂存区原样不动
  assert.equal(existsSync(seen.root), false)
  assert.equal(repo.run(['status', '--porcelain']), statusBefore)
})

test('scan：--rev 分析指定的提交；导出入口和根目录的配置文件，不导出扩展名之外的文件', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const first = repo.run(['rev-parse', 'HEAD'])
  repo.write('package.json', '{"name":"x"}\n')
  repo.write('index.html', '<script type="module" src="/src/main.js"></script>\n')
  repo.write('scripts/build.js', "import '../src/helper.js'\n")
  repo.write('src/assets/logo.png', 'png')
  repo.write('src/later.js', '')
  const second = repo.commit('第二次')

  let seenRoot
  const seen = {}
  const run = ({ root }) => {
    seenRoot = root
    for (const f of ['package.json', 'index.html', 'scripts/build.js', 'src/assets/logo.png', 'src/later.js']) seen[f] = existsSync(join(root, f))
    return { unusedFiles: [], enabledPlugins: [] }
  }
  const config = resolveConfig({ entries: ['src/main.js', 'index.html'] })

  scan({ root: repo.root, project: 'p', config, knipDir, run })
  assert.deepEqual(seen, {
    'package.json': true,
    'index.html': true, // 写在 entries 里
    'scripts/build.js': true, // 源码目录外，但可能 import 源码
    'src/assets/logo.png': false,
    'src/later.js': true
  })
  assert.notEqual(seenRoot, undefined)

  const r = scan({ root: repo.root, project: 'p', config, rev: first, knipDir, run })
  assert.equal(r.candidates.rev, first)
  assert.equal(seen['src/later.js'], false)
  assert.equal(seen['package.json'], true) // 第一个提交没有 package.json：knip 要求有，补了一个空的
  assert.notEqual(first, second)
})

test('scan：提交不存在时报错', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const config = resolveConfig({ entries: ['src/main.js'] })
  assert.throws(() => scan({ root: repo.root, project: 'p', config, rev: 'nope', knipDir, run: fakeRun({ mainOnly: [] }).run }), /找不到提交：nope/)
})

test('scan：没有候选时，空清单也能通过 history 的校验', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run: fakeRun({ mainOnly: [] }).run })
  assert.deepEqual(r.candidates.files, [])
  assert.deepEqual(validateCandidates(r.candidates), [])
})

test('scan：动态加载范围里的是 unknown；确定不了目录的圈整个仓库并记警告；人工确认过的放过，写明理由', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('src/loader.js', "export const l = (n) => import('./pages/' + n)\nexport const x = (p) => import(p)\n")
  repo.write('src/pages/a.js', '')
  repo.commit('动态加载')
  const fake = fakeRun({ mainOnly: ['src/dead.js', 'src/pages/a.js'] })

  // 没确认：import(p) 确定不了目录，整个仓库都可能，dead.js 也判 unknown
  let r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run: fake.run })
  let [dead, page] = r.candidates.files
  assert.equal(dead.status, 'unknown')
  assert.deepEqual(dead.refs, [{ from: 'src/loader.js', line: 2, via: 'dynamic' }])
  assert.equal(page.status, 'unknown')
  assert.deepEqual(page.refs.map((x) => x.line), [1, 2])
  assert.deepEqual(r.summary.counts.byStatus, { unknown: 2 })
  assert.equal(r.summary.dynamicLoads, 2)
  assert.match(r.summary.warnings.map((w) => `${w.from}:${w.line} ${w.detail}`).join('\n'), /src\/loader\.js:2 动态加载确定不了目录：import\(p\)/)
  assert.deepEqual(validateCandidates(r.candidates), [])

  // 人工确认 import(p) 不加载本地源码：dead.js 判 dead，写明理由；pages/a.js 仍在 ./pages/ 的范围里
  const reviewed = [
    { from: 'src/loader.js', expr: 'import(p)', reason: '加载的是 CDN 脚本' },
    { from: 'src/gone.js', expr: 'import(x)', reason: '已删除' }
  ]
  r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'], reviewedDynamicLoads: reviewed }), knipDir, run: fake.run })
  ;[dead, page] = r.candidates.files
  assert.equal(dead.status, 'dead')
  assert.deepEqual(dead.evidence.map((e) => e.rule), [SCAN_RULES.unreachable, 'no-ref', 'reviewed-dynamic-load'])
  assert.match(dead.evidence[2].detail, /已人工确认不加载本地源码：加载的是 CDN 脚本/)
  assert.equal(page.status, 'unknown')
  assert.equal(r.summary.reviewedLoads, 1)
  const warnings = r.summary.warnings.map((w) => w.detail).join('\n')
  assert.doesNotMatch(warnings, /确定不了目录：import\(p\)/)
  assert.match(warnings, /reviewedDynamicLoads 里的 import\(x\) 在这个提交里找不到/)
})

test('scan：构建配置里写着路径的判为 external；测试文件里写的不算', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('vite.config.js', "export default { alias: { x: 'src/dead.js' } }\n")
  repo.write('tests/helper.spec.js', "const p = 'src/helper.js'\n")
  repo.commit('配置')
  const fake = fakeRun({ mainOnly: ['src/dead.js', 'src/helper.js'], withTests: ['src/dead.js', 'src/helper.js'] })
  const config = resolveConfig({ entries: ['src/main.js'], testEntries: ['tests/**/*.spec.js'] })
  const r = scan({ root: repo.root, project: 'p', config, knipDir, run: fake.run })

  const [dead, helper] = r.candidates.files
  assert.equal(dead.status, 'external')
  assert.deepEqual(dead.refs, [{ from: 'vite.config.js', line: 1, via: 'config' }])
  assert.equal(helper.status, 'dead')
  assert.deepEqual(helper.refs, [])
})

test('scan：在用的代码里注释掉的引用判为 dormant；候选、测试文件里的注释不算', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('src/main.js', "import './used.js'\n// import '@/dead.js'\n")
  repo.write('src/dead.js', "// import './helper.js'\n") // 候选里的注释
  repo.write('src/tests/a.test.js', "// import '../mock/data.js'\n") // 测试文件里的注释
  repo.commit('注释')
  const fake = fakeRun({ mainOnly: ['src/dead.js', 'src/helper.js', 'src/mock/data.js'] })
  const config = resolveConfig({ entries: ['src/main.js'], aliases: { '@': 'src' }, testEntries: ['src/tests/**'] })
  const r = scan({ root: repo.root, project: 'p', config, knipDir, run: fake.run })

  const byFile = Object.fromEntries(r.candidates.files.map((f) => [f.file, f]))
  assert.equal(byFile['src/dead.js'].status, 'dormant')
  assert.deepEqual(byFile['src/dead.js'].refs, [{ from: 'src/main.js', line: 2, via: 'comment' }])
  // 候选、测试文件里的注释不算（helper.js 被测试 import 了，那是另一回事）
  assert.equal(byFile['src/helper.js'].refs.some((x) => x.via === 'comment'), false)
  assert.deepEqual(byFile['src/mock/data.js'].refs, [])
})

test('scan：只在临时目录的 package.json 里补上单文件组件的依赖，原有内容保留', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('package.json', '{"name":"demo","main":"src/main.js"}\n')
  repo.write('src/App.vue', '<template><div/></template>\n')
  repo.commit('vue')
  let pkg
  const run = ({ root }) => {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
    return { unusedFiles: [], enabledPlugins: [] }
  }
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run })
  assert.deepEqual(pkg, { name: 'demo', main: 'src/main.js', devDependencies: { vue: '*' } })
  assert.deepEqual(r.summary.addedDeps, ['vue'])
  assert.equal(readFileSync(join(repo.root, 'package.json'), 'utf8'), '{"name":"demo","main":"src/main.js"}\n')
})

test('scan：package.json 不是合法的 JSON 时报错', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('package.json', '{ oops')
  repo.commit('bad')
  assert.throws(
    () => scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run: fakeRun({ mainOnly: [] }).run }),
    /package\.json 不是合法的 JSON/
  )
})

test('scan：只有测试用到的判为 test-only，列出引用它的测试；只被候选引用的判为 dead-only-ref', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('src/dead.js', "import './orphan.js'\n")
  repo.write('src/orphan.js', '')
  repo.commit('引用')
  const fake = fakeRun({ mainOnly: ['src/dead.js', 'src/helper.js', 'src/orphan.js'], withTests: ['src/dead.js', 'src/orphan.js'] })
  const config = resolveConfig({ entries: ['src/main.js'], testEntries: ['src/tests/**/*.test.js'] })
  const r = scan({ root: repo.root, project: 'p', config, knipDir, run: fake.run })

  const byFile = Object.fromEntries(r.candidates.files.map((f) => [f.file, f]))
  assert.equal(byFile['src/helper.js'].status, 'test-only')
  assert.deepEqual(byFile['src/helper.js'].refs, [{ from: 'src/tests/helper.test.js', line: 1, via: 'static' }])
  assert.equal(byFile['src/orphan.js'].status, 'dead-only-ref')
  assert.deepEqual(byFile['src/orphan.js'].refs, [{ from: 'src/dead.js', line: 1, via: 'static' }])
})

test('scan：生成的候选清单能通过 history 的校验', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  const fake = fakeRun({ mainOnly: ['src/dead.js'] })
  const r = scan({ root: repo.root, project: 'demo', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run: fake.run })
  assert.deepEqual(validateCandidates(r.candidates), [])
  assert.equal(r.candidates.project, 'demo')
  assert.deepEqual(r.candidates.entries, ['src/main.js'])
})

test('scan：文件名以空格开头、含中文时路径不变', (t) => {
  const repo = sampleRepo()
  const knipDir = fakeKnipDir()
  t.after(() => {
    repo.cleanup()
    rmSync(knipDir, { recursive: true, force: true })
  })
  repo.write('src/ 空格.js', '')
  repo.write('src/可用.js', '')
  repo.commit('特殊文件名')
  const fake = fakeRun({ mainOnly: ['src/ 空格.js', 'src/可用.js'] })
  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }), knipDir, run: fake.run })
  assert.deepEqual(r.candidates.files.map((f) => f.file), ['src/ 空格.js', 'src/可用.js'])
})

// ---------- 真正调用 knip ----------

/** 一个带 .vue、别名、glob、测试、注释掉的引用的小项目 */
function vueRepo() {
  const repo = createRepo()
  repo.write('package.json', JSON.stringify({ name: 'demo', private: true, type: 'module', dependencies: { vue: '3.0.0' } }))
  repo.write('vite.config.js', "throw new Error('不应该被执行')\n")
  repo.write('src/main.js', "import App from './App.vue'\nimport '@/i18n/index.js'\n// import '@/utils/old.js'\n")
  repo.write('src/App.vue', "<template><p>Don't</p></template>\n<script>\nimport Child from '@/components/Child.vue'\nexport default { components: { Child } }\n</script>\n")
  repo.write('src/components/Child.vue', '<template><i/></template>\n')
  repo.write('src/components/Orphan.vue', '<template><b/></template>\n')
  repo.write('src/i18n/index.js', "export const m = import.meta.glob('./menu/*.js', { eager: true })\n")
  repo.write('src/i18n/menu/zh.js', 'export default {}\n')
  repo.write('src/utils/old.js', 'export const x = 1\n')
  repo.write('src/utils/format.js', 'export const f = 1\n')
  repo.write('src/tests/format.test.js', "import { f } from '../utils/format.js'\nconsole.log(f)\n")
  repo.commit('init')
  return repo
}

test('scan + knip：.vue 和别名能解析，glob 加载的不误报，区分只有测试用到', needsKnip, (t) => {
  const repo = vueRepo()
  t.after(() => repo.cleanup())
  const before = repo.run(['status', '--porcelain', '--ignored'])
  const config = resolveConfig({
    entries: ['src/main.js'],
    testEntries: ['src/tests/**/*.test.js'],
    aliases: { '@': 'src' }
  })
  const r = scan({ root: repo.root, project: 'demo', config })

  assert.deepEqual(
    r.candidates.files.map((f) => [f.file, f.evidence[0].rule]),
    [
      ['src/components/Orphan.vue', SCAN_RULES.unreachable],
      ['src/utils/format.js', SCAN_RULES.testOnly],
      ['src/utils/old.js', SCAN_RULES.unreachable] // 引用被注释掉了
    ]
  )
  // 只读：目标仓库没有多出任何文件（也没有执行 vite.config.js，否则 knip 会报错）
  assert.equal(repo.run(['status', '--porcelain', '--ignored']), before)
  // 只启用了解析单文件组件的插件（写了 { config: [] } 的会被启用，但不读配置文件、不加入口）
  assert.ok(r.summary.enabledPlugins.includes('Vue'))
  assert.ok(r.summary.enabledPlugins.every((p) => Object.values(COMPILER_PLUGINS).includes(p)))
})

test('scan + knip：本地删掉 import 但没提交时，按提交里的代码分析', needsKnip, (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.js', "import './used.js'\n")
  repo.write('src/used.js', 'export const a = 1\n')
  repo.write('src/dead.js', 'export const b = 2\n')
  repo.commit('init')
  repo.write('src/main.js', '\n') // 工作区删掉 import，没提交

  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }) })
  assert.deepEqual(r.candidates.files.map((f) => f.file), ['src/dead.js'])
})

test('scan + knip：package.json 没声明 vue 时，.vue 照样解析：只被组件用到的 js 不误报，没人用的组件列为候选', needsKnip, (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())
  repo.write('src/main.js', "import App from './App.vue'\nexport default App\n")
  repo.write('src/App.vue', "<template><div/></template>\n<script>\nimport { fmt } from './fmt.js'\nexport default { methods: { fmt } }\n</script>\n")
  repo.write('src/fmt.js', 'export const fmt = (x) => x\n')
  repo.write('src/Unused.vue', '<template><div/></template>\n')
  repo.commit('init')

  const r = scan({ root: repo.root, project: 'p', config: resolveConfig({ entries: ['src/main.js'] }) })
  assert.deepEqual(r.candidates.files.map((f) => f.file), ['src/Unused.vue'])
})

test('scan 命令：没有 --profile 时报错', () => {
  const r = cli('scan')
  assert.equal(r.status, 1)
  assert.match(r.stderr, /缺少 --profile/)
})

test('scan 命令：输出在仓库里、输出文件已存在时报错，并且不开始分析', (t) => {
  const repo = sampleRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-scan-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  const profile = join(dir, 'p.js')
  writeFileSync(profile, "export default { entries: ['src/main.js'] }\n")

  const inside = cli('scan', '--root', repo.root, '--profile', profile, '--out', join(repo.root, 'c.json'))
  assert.equal(inside.status, 1)
  assert.match(inside.stderr, /输出位置在被分析的仓库里/)
  assert.equal(existsSync(join(repo.root, 'c.json')), false)

  const existing = join(dir, 'c.json')
  writeFileSync(existing, 'old')
  const exists = cli('scan', '--root', repo.root, '--profile', profile, '--out', existing)
  assert.equal(exists.status, 1)
  assert.match(exists.stderr, /输出文件已存在/)
  assert.equal(readFileSync(existing, 'utf8'), 'old')
})

test('scan 命令：写出候选清单，统计写到 stderr', needsKnip, (t) => {
  const repo = vueRepo()
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-scan-'))
  t.after(() => {
    repo.cleanup()
    rmSync(dir, { recursive: true, force: true })
  })
  const profile = join(dir, 'p.js')
  writeFileSync(profile, "export default { entries: ['src/main.js'], aliases: { '@': 'src' } }\n")
  const out = join(dir, 'candidates.json')

  const r = cli('scan', '--root', repo.root, '--profile', profile, '--out', out, '--project', 'demo')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stderr, /从入口走不到/)
  assert.match(r.stderr, /import\.meta\.glob 换算成入口 1 处/)
  assert.match(r.stderr, new RegExp(`分析提交 ${repo.run(['rev-parse', 'HEAD'])}`))
  const c = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(c.project, 'demo')
  assert.deepEqual(validateCandidates(c), [])
  assert.equal(c.rev, repo.run(['rev-parse', 'HEAD']))
})
