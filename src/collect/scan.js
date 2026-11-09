/**
 * scan：找出从入口走不到的文件，生成候选清单（交给 history --in）
 *
 * 步骤：
 * 1. 把要分析的提交（默认 HEAD）里的源码导出到临时目录：工作区没提交的改动一概不看，
 *    和 history 以同一个提交为准（提交号写进候选清单，history 默认就查它）
 * 2. 找出 import.meta.glob，换算成入口：knip 不认识这种写法
 * 3. 只用项目入口跑一次 knip：得到「从入口走不到」的文件
 * 4. 配置了测试入口时，再加上测试入口跑一次：两次一比，就知道哪些「只被测试用到」
 * 5. 规则层判定状态（src/rules/）：比如落在拼接路径的 import() 范围里的判为 unknown，
 *    构建配置、脚本等 knip 不分析的文件里写着路径的判为 external
 *
 * 候选清单里写好状态、证据、引用，history 只补历史，不改结论
 */
import { DEFAULT_CONFIG } from './../core/config.js'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findGlobImports } from './glob-imports.js'
import { buildKnipConfig, findKnip, readPluginNames, runKnip } from './knip.js'
import { createSnapshot } from './snapshot.js'
import { findDynamicLoads } from './dynamic-imports.js'
import { EXTERNAL_EXTENSIONS, externalFiles, findExternalRefs } from './external-refs.js'
import { judge } from '../rules/index.js'

/**
 * 仓库根目录下一并导出的配置文件：knip 找项目根目录、读路径别名时会用到。
 * 不导出时，分析结果可能和在原仓库里跑不一样
 */
const ROOT_FILES = ['package.json', 'tsconfig.json', 'jsconfig.json']

/** 候选证据的规则名 */
export const SCAN_RULES = Object.freeze({
  unreachable: 'knip-unreachable',
  testOnly: 'knip-test-only'
})

/**
 * @typedef {object} ScanResult
 * @property {import('../history/batch.js').Candidates} candidates 候选清单
 * @property {object} summary 给人看的统计，不写进候选清单
 */

/**
 * @param {object} opts
 * @param {string} opts.root 仓库根目录（绝对路径）
 * @param {string} opts.project 项目名
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @param {string} [opts.rev] 分析哪个提交，默认 HEAD
 * @param {string} [opts.knipDir] 指定 knip 的安装目录；不传用 code-audit 自己的依赖
 * @param {typeof runKnip} [opts.run] 测试时可以替换
 * @returns {ScanResult}
 */
export function scan({ root, project, config = DEFAULT_CONFIG, rev = 'HEAD', knipDir, run = runKnip }) {
  if (config.entries.length === 0) {
    throw new Error('配置里没有写 entries（项目入口）。入口没有默认值：猜错会把在用的文件当成没人用，请在 profile 里写明，如 entries: ["src/main.js"]')
  }

  const knip = findKnip(knipDir)
  const pluginNames = readPluginNames(knip.dir)

  const snap = createSnapshot(root, rev)
  try {
    return scanSnapshot({ snap, project, config, knip, pluginNames, run })
  } finally {
    snap.cleanup()
  }
}

function scanSnapshot({ snap, project, config, knip, pluginNames, run }) {
  const byExt = (f) => config.extensions.some((e) => f.endsWith(e))

  // 1. 导出文件：整个提交里配置扩展名的文件（源码目录外的文件也可能 import 源码，影响分析结果），
  //    加上入口、测试入口匹配到的文件、根目录的配置文件，以及规则层要搜的其他文本文件
  const sources = snap.list(config.sourceRoots).filter(byExt)
  const testFiles = new Set(snap.list(globs(config.testEntries)))
  const ignored = new Set(snap.list(globs(config.scanIgnore)))
  const others = externalFiles({
    all: snap.list(globs(EXTERNAL_EXTENSIONS.map((e) => `**/*${e}`))),
    sourceRoots: config.sourceRoots,
    extensions: config.extensions,
    exclude: testFiles
  })
  const extracted = new Set([
    ...snap.list(globs(config.extensions.map((e) => `**/*${e}`))),
    ...snap.list(globs(config.entries)),
    ...testFiles,
    ...snap.list(ROOT_FILES),
    ...others
  ])
  snap.extract([...extracted].sort())
  // knip 要求根目录有 package.json；提交里没有时，在临时目录补一个空的（不影响分析，也不碰原仓库）
  if (!extracted.has('package.json')) {
    mkdirSync(snap.dir, { recursive: true })
    writeFileSync(join(snap.dir, 'package.json'), '{}\n')
  }

  // 2. import.meta.glob → 入口
  const contents = sources.map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') }))
  const { globs: globImports, warnings } = findGlobImports({ files: contents, aliases: config.aliases })
  const globEntries = [...new Set(globImports.map((g) => g.resolved))]

  // 参与分析的文件：源码目录下、配置的扩展名
  const projectGlobs = config.sourceRoots.flatMap((dir) => config.extensions.map((ext) => `${dir}/**/*${ext}`))
  const knipConfig = (entry) => buildKnipConfig({ entry, project: projectGlobs, aliases: config.aliases, pluginNames })

  // 3. 只用项目入口
  const main = run({ knip, root: snap.dir, config: knipConfig([...config.entries, ...globEntries]) })

  // 4. 加上测试入口
  let withTests = null
  if (config.testEntries.length > 0) {
    withTests = run({ knip, root: snap.dir, config: knipConfig([...config.entries, ...globEntries, ...config.testEntries]) })
  }
  const stillUnused = new Set(withTests?.unusedFiles ?? [])

  const sourceSet = new Set(sources)
  const skipped = { test: 0, ignored: 0, outside: [] }
  const files = []
  for (const file of main.unusedFiles) {
    if (testFiles.has(file)) {
      skipped.test++
      continue
    }
    if (ignored.has(file)) {
      skipped.ignored++
      continue
    }
    // knip 只分析源码目录下的文件，正常不会走到这里；万一报了别的文件，不当候选，列出来
    if (!sourceSet.has(file)) {
      skipped.outside.push(file)
      continue
    }
    files.push({ file, evidence: [evidenceFor(file, { withTests, stillUnused, version: knip.version })] })
  }

  // 5. 规则层判定状态
  const loads = findDynamicLoads({ files: contents, aliases: config.aliases })
  for (const l of loads.filter((x) => x.scope === null)) {
    warnings.push({
      from: l.from,
      line: l.line,
      detail: `动态加载的路径确定不了范围：${l.expr}，被它加载的文件可能被误报为没人用`
    })
  }
  const externalRefs = findExternalRefs({
    files: others.map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') })),
    targets: files.map((f) => f.file)
  })
  const judged = judge({ files, loads, externalRefs })
  const byStatus = {}
  for (const f of judged) byStatus[f.status] = (byStatus[f.status] ?? 0) + 1

  return {
    candidates: { project, rev: snap.commit, entries: [...config.entries], files: judged },
    summary: {
      rev: snap.commit,
      engine: { name: 'knip', version: knip.version },
      enabledPlugins: main.enabledPlugins,
      globs: globImports,
      warnings,
      counts: {
        unused: main.unusedFiles.length,
        candidates: files.length,
        testOnly: files.filter((f) => f.evidence[0].rule === SCAN_RULES.testOnly).length,
        skippedTests: skipped.test,
        skippedIgnored: skipped.ignored,
        byStatus
      },
      dynamicLoads: loads.length,
      outside: skipped.outside
    }
  }
}

function evidenceFor(file, { withTests, stillUnused, version }) {
  if (withTests === null) {
    return { rule: SCAN_RULES.unreachable, detail: `从入口走不到（knip ${version}，没有配置测试入口）` }
  }
  if (stillUnused.has(file)) {
    return { rule: SCAN_RULES.unreachable, detail: `从入口和测试入口都走不到（knip ${version}）` }
  }
  return { rule: SCAN_RULES.testOnly, detail: `从入口走不到，只有测试用到（knip ${version}）` }
}

/** glob 写成 git 的 pathspec：和 knip 的 glob 写法一致（** 跨目录） */
function globs(patterns) {
  return patterns.map((p) => `:(glob)${p}`)
}
