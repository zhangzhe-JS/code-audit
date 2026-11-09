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
 *    构建配置、脚本等 knip 不分析的文件里写着路径的判为 external，在用的代码里有注释掉的引用的判为 dormant，
 *    没合并的分支在用的判为 pending，只有测试用到的判为 test-only；
 *    再顺着候选之间的 import 传递，只被没人用的文件引用的判为 dead-only-ref
 *
 * 候选清单里写好状态、证据、引用，history 只补历史，不改结论
 */
import { DEFAULT_CONFIG } from './../core/config.js'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { findGlobImports } from './glob-imports.js'
import { addCompilerDeps, buildKnipConfig, findKnip, readPluginNames, runKnip } from './knip.js'
import { createSnapshot } from './snapshot.js'
import { findDynamicLoads } from './dynamic-imports.js'
import { EXTERNAL_EXTENSIONS, externalFiles, findExternalRefs } from './external-refs.js'
import { findCommentRefs } from './comment-refs.js'
import { findImportRefs } from './path-refs.js'
import { findBranchRefs } from './branch-refs.js'
import { findComponentVarUses, findGlobalComponents, findSameNameTags, findTagUses, injectImports, mergeRefs } from './global-components.js'
import { findAutoImports, findBareExportUses, findNameUses } from './auto-imports.js'
import { findExternalMaybe } from './external-refs.js'
import { wideScope } from './dynamic-imports.js'
import { judge } from '../rules/index.js'

/**
 * 仓库根目录下一并导出的配置文件：knip 找项目根目录、读路径别名时会用到。
 * 不导出时，分析结果可能和在原仓库里跑不一样
 */
const ROOT_FILES = ['package.json', 'tsconfig.json', 'jsconfig.json']

import { SCAN_RULES } from './scan-rules.js'
export { SCAN_RULES }

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
    return scanSnapshot({ root, snap, project, config, knip, pluginNames, run })
  } finally {
    snap.cleanup()
  }
}

function scanSnapshot({ root, snap, project, config, knip, pluginNames, run }) {
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
  // package.json：knip 要求根目录有；提交里没有时在临时目录补一个空的。
  // 再补上单文件组件的依赖声明，否则 knip 会悄悄跳过 .vue 等文件（见 addCompilerDeps）。只改临时目录，不碰原仓库
  const pkgPath = join(snap.dir, 'package.json')
  let pkg = {}
  if (extracted.has('package.json')) {
    try {
      pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    } catch (e) {
      throw new Error(`package.json 不是合法的 JSON，knip 无法分析：${e.message}`)
    }
  }
  const addedDeps = addCompilerDeps(pkg, sources)
  if (!extracted.has('package.json') || addedDeps.length > 0) {
    mkdirSync(snap.dir, { recursive: true })
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`)
  }

  // 2. import.meta.glob → 入口
  const contents = sources.map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') }))
  const { globs: globImports, warnings, unresolved: unresolvedGlobs } = findGlobImports({ files: contents, aliases: config.aliases })
  const globEntries = [...new Set(globImports.map((g) => g.resolved))]
  // 测试文件：在临时目录被改动（下面补 import）之前读出原样
  const testContents = [...testFiles].filter(byExt).map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') }))

  // 全局注册的组件（见 global-components.js）：拿掉声明文件，模板里的标签用法补成 import 交给 knip
  const sourceSet = new Set(sources)
  const allCode = [...contents, ...testContents.filter((t) => !sourceSet.has(t.path))]
  const globals = findGlobalComponents({ files: contents, sourceSet, aliases: config.aliases })
  // 自动导入（见 auto-imports.js）：同样拿掉登记了本地函数的声明文件，按名字找用法
  const autos = findAutoImports({ files: contents, sourceSet, extensions: config.extensions, aliases: config.aliases })
  for (const d of [...globals.declarations, ...autos.declarations]) rmSync(join(snap.dir, d), { force: true })
  const tagUses = mergeRefs(
    findTagUses({ files: allCode, components: globals.components }),
    findNameUses({ files: allCode, names: autos.names, skip: new Set([...globals.declarations, ...autos.declarations]) })
  )
  injectImports(snap.dir, tagUses)
  const deps = new Set(['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) => Object.keys(pkg[k] ?? {})))

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
  // 动态加载：人工确认过不加载本地源码的（配置 reviewedDynamicLoads）不圈文件，只在证据里注明
  const allLoads = findDynamicLoads({ files: contents, aliases: config.aliases })
  const loads = allLoads.filter((l) => !isReviewed(l, config.reviewedDynamicLoads))
  const reviewedLoads = allLoads
    .filter((l) => isReviewed(l, config.reviewedDynamicLoads))
    .map((l) => ({ ...l, reason: isReviewed(l, config.reviewedDynamicLoads).reason }))
  // 盲区：换算不了的 glob、名字是变量的动态组件，也当成范围确定不了的动态加载（同样可以人工确认后放过）
  const extraLoads = [
    ...unresolvedGlobs.map((g) => ({
      from: g.from,
      line: g.line,
      kind: 'import.meta.glob',
      expr: g.expr,
      scope: wideScope('', g.regex),
      note: g.regex
        ? `glob 换算不了（别名没配置？），按模式 ${g.regex} 在全仓库里圈。在 profile 的 aliases 里补上别名，或人工确认后写进配置 reviewedDynamicLoads`
        : 'glob 的参数不是字符串，整个仓库都可能。人工确认后可以写进配置 reviewedDynamicLoads'
    }))
  ]
  // 名字是变量的 :is / resolveComponent：项目有全局注册的组件时，可能用到的是任何一个全局组件；
  // 装了自动注册的插件却没有声明文件时，所有 .vue 都可能
  const autoRegister = ['unplugin-vue-components', 'vite-plugin-components'].some((d) => deps.has(d))
  const componentScope = new Set([...globals.components.values(), ...(autoRegister && globals.declarations.length === 0 ? sources.filter((f) => f.endsWith('.vue')) : [])])
  if (componentScope.size > 0) {
    for (const u of findComponentVarUses(contents)) {
      extraLoads.push({
        ...u,
        kind: 'component',
        scope: { ...wideScope('', null), files: componentScope },
        note: '组件名是变量，看不出是哪个全局组件，所有全局组件都可能。人工确认它不会用到这个组件后，可以写进配置 reviewedDynamicLoads'
      })
    }
  }
  for (const l of extraLoads) {
    const r = isReviewed(l, config.reviewedDynamicLoads)
    if (r) reviewedLoads.push({ ...l, reason: r.reason })
    else loads.push(l)
    allLoads.push(l)
  }
  for (const r of config.reviewedDynamicLoads) {
    if (!allLoads.some((l) => l.from === r.from && l.expr === r.expr)) {
      warnings.push({ from: r.from, line: 0, detail: `配置 reviewedDynamicLoads 里的 ${r.expr} 在这个提交里找不到（代码改了？），这条确认没有用上` })
    }
  }
  for (const l of loads.filter((x) => x.scope.wide && x.kind !== 'import.meta.glob' && !isReviewed(x, config.reviewedDynamicLoads))) {
    warnings.push({
      from: l.from,
      line: l.line,
      detail:
        l.kind === 'component'
          ? `动态组件的名字是变量：${l.expr}，候选里的全局组件都判为 unknown；人工确认后可以写进配置 reviewedDynamicLoads`
          : `动态加载确定不了目录：${l.expr}，范围内的候选都判为 unknown；人工确认它不加载本地源码后，可以写进配置 reviewedDynamicLoads`
    })
  }
  const targets = files.map((f) => f.file)
  const otherContents = others.map((path) => ({ path, content: readFileSync(join(snap.dir, path), 'utf8') }))
  const externalRefs = findExternalRefs({ files: otherContents, targets, aliases: config.aliases })
  // 注释只看在用的文件：候选（没人用的）、测试文件里的注释不算
  const candidateSet = new Set(targets)
  const commentRefs = findCommentRefs({
    files: [...contents.filter((c) => !candidateSet.has(c.path) && !testFiles.has(c.path)), ...otherContents],
    targets,
    aliases: config.aliases
  })
  // 测试文件里的 import：只有测试用到的候选，列出是哪些测试
  const onlyFrom = (refs, from) => new Map([...refs].map(([k, v]) => [k, v.filter((r) => from.has(r.from))]).filter(([, v]) => v.length > 0))
  const testRefs = mergeRefs(findImportRefs({ files: testContents, targets, aliases: config.aliases }), onlyFrom(tagUses, testFiles))
  // 候选之间的 import：只被没人用的文件引用的，跟着引用方处理
  const importers = mergeRefs(
    findImportRefs({ files: contents.filter((c) => candidateSet.has(c.path)), targets, aliases: config.aliases }),
    new Map([...onlyFrom(tagUses, candidateSet)].filter(([k]) => candidateSet.has(k)))
  )
  // 没合并的分支：分支自己改过的文件里 import 了候选，或者改了候选本身
  const branchScan = findBranchRefs({ root, rev: snap.commit, targets, extensions: config.extensions, aliases: config.aliases, branches: config.branches })
  // 盲区兜底（见 rules/blind-spots.js）：只看在用的文件（不是候选、不是测试）
  const live = contents.filter((c) => !candidateSet.has(c.path) && !testFiles.has(c.path))
  const declaredComponents = new Set(globals.components.values())
  const tags = findSameNameTags({ files: live, targets: targets.filter((t) => t.endsWith('.vue') && !declaredComponents.has(t)) })
  const autoImportPlugin = ['unplugin-auto-import'].some((d) => deps.has(d))
  const bareExports =
    autoImportPlugin && !autos.found
      ? findBareExportUses({ files: live, targets: contents.filter((c) => candidateSet.has(c.path) && !c.path.endsWith('.vue')) })
      : new Map()
  const externalMaybe = findExternalMaybe({ files: otherContents, targets, found: externalRefs })
  const blindSpots = { sameNameTags: tags.used, commentedTags: tags.commented, bareExports, externalMaybe }
  const judged = judge({ files, loads, reviewedLoads, externalRefs, commentRefs, testRefs, branchRefs: branchScan.refs, blindSpots, importers })
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
      dynamicLoads: allLoads.length,
      reviewedLoads: reviewedLoads.length,
      branches: { checked: branchScan.checked, skipped: branchScan.skipped, byBranch: refsByBranch(branchScan.refs), remotes: branchScan.remotes },
      blindSpots: {
        sameNameTags: tags.used.size,
        commentedTags: tags.commented.size,
        bareExports: bareExports.size,
        externalMaybe: externalMaybe.size,
        autoImportWithoutDeclaration: autoImportPlugin && !autos.found,
        autoImports: autos.names.size
      },
      addedDeps,
      globalComponents: { declarations: globals.declarations, components: globals.components.size, used: tagUses.size },
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

/** 每个分支引用了哪些候选：输出里告诉用户是哪些分支导致了 pending，好决定要不要在配置里排除 */
function refsByBranch(refs) {
  const by = new Map()
  for (const [file, list] of refs) {
    for (const r of list) {
      const entry = by.get(r.branch) ?? { branch: r.branch, date: r.date, files: [] }
      if (!entry.files.includes(file)) entry.files.push(file)
      by.set(r.branch, entry)
    }
  }
  return [...by.values()].sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : a.branch < b.branch ? -1 : 1))
}

/** 这处动态加载有没有人工确认过：按写加载的文件和写法匹配；确认过返回那条配置 */
function isReviewed(load, reviewed) {
  return reviewed.find((r) => r.from === load.from && r.expr === load.expr) ?? null
}

/** glob 写成 git 的 pathspec：和 knip 的 glob 写法一致（** 跨目录） */
function globs(patterns) {
  return patterns.map((p) => `:(glob)${p}`)
}
