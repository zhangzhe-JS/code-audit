/**
 * scan 子命令：找出从入口走不到的文件，输出候选清单（交给 history --in）
 *
 * 用法：
 *   code-audit scan --root <仓库> --profile <配置> [--out <候选清单.json>] [--rev <提交>] [--project <项目名>] [--knip <目录>]
 *
 * 只读：分析的是提交里的文件，导出到系统临时目录，knip 的配置也写在那里；输出不能写在被分析的仓库里
 */
import { parseArgs } from 'node:util'
import { basename, resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { assertOutsideRepo, pathExists, writeFileSafely } from '../core/output.js'
import { scan } from '../collect/scan.js'

const USAGE = `用法：code-audit scan --root <仓库> --profile <配置> [选项]

找出从入口走不到的文件，输出候选清单，再交给 history --in 查历史。
用 knip 分析（code-audit 的可选依赖），再由规则层判定状态。
每个候选都写明判定的原因（证据）。动态加载确定不了目录时，范围内的候选判为 unknown，不判 dead。
分析的是提交里的代码，工作区没提交的改动不算；提交号写进候选清单，history 默认查同一个提交。

选项：
  --root     仓库目录，默认当前目录
  --profile  项目配置文件（必填）：至少要写 entries（项目入口）；
             还可以写 testEntries（测试入口）、aliases（路径别名）、scanIgnore（不列为候选的文件）
  --out      候选清单写到这个文件；不传就打印出来。不能写在被分析的仓库里，文件不能已存在
  --rev      分析哪个提交，默认 HEAD
  --project  写进候选清单的项目名，默认取仓库目录名
  --knip     knip 的安装目录；不传时用 code-audit 自己安装的 knip
  -h, --help 显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        profile: { type: 'string' },
        out: { type: 'string' },
        rev: { type: 'string' },
        project: { type: 'string' },
        knip: { type: 'string' },
        help: { type: 'boolean', short: 'h' }
      }
    }))
  } catch (e) {
    return fail(`${e.message}\n\n${USAGE}`)
  }

  if (values.help) {
    console.log(USAGE)
    return
  }
  // 入口没有默认值，所以 profile 必填：没有它就不知道从哪里开始分析
  if (!values.profile) return fail(`缺少 --profile（至少要在配置里写 entries）\n\n${USAGE}`)

  const root = resolve(values.root ?? '.')
  try {
    const config = await loadProfile(values.profile)

    // 先检查输出位置再开始分析，避免分析完才发现写不进去
    if (values.out) {
      assertOutsideRepo(values.out, root)
      if (pathExists(values.out)) {
        throw new Error(`输出文件已存在：${resolve(values.out)}（工具不覆盖已有文件，请换一个文件名）`)
      }
    }

    const { candidates, summary } = scan({
      root,
      project: values.project ?? basename(root),
      config,
      rev: values.rev,
      knipDir: values.knip
    })
    const json = `${JSON.stringify(candidates, null, 2)}\n`

    // 统计写到 stderr：stdout 只放数据，方便用管道交给别的程序
    printSummary(summary)
    if (values.out) {
      writeFileSafely(values.out, json)
      console.error(`候选清单写入：${resolve(values.out)}`)
    } else {
      process.stdout.write(json)
    }
  } catch (e) {
    fail(e.message)
  }
}

function printSummary(s) {
  const c = s.counts
  console.error(`分析提交 ${s.rev}（工作区没提交的改动不算）`)
  console.error(`knip ${s.engine.version}：从入口走不到 ${c.unused} 个文件`)
  console.error(`  列为候选 ${c.candidates} 个（其中只有测试用到 ${c.testOnly} 个）`)
  console.error(`  状态：${Object.entries(c.byStatus).map(([k, v]) => `${k} ${v} 个`).join('，') || '无'}`)
  if (c.skippedTests > 0) console.error(`  跳过测试文件 ${c.skippedTests} 个`)
  if (c.skippedIgnored > 0) console.error(`  跳过 scanIgnore 匹配的 ${c.skippedIgnored} 个`)
  if (s.outside.length > 0) {
    console.error(`  跳过不在源码目录、或扩展名不在配置里的 ${s.outside.length} 个：`)
    for (const f of s.outside) console.error(`    - ${f}`)
  }
  if (s.globs.length > 0) {
    console.error(`  import.meta.glob 换算成入口 ${s.globs.length} 处：`)
    for (const g of s.globs) console.error(`    - ${g.from}:${g.line}  ${g.pattern} → ${g.resolved}`)
  }
  if (s.branches.checked.length > 0 || s.branches.skipped.length > 0) {
    console.error(`  没合并的分支：查了 ${s.branches.checked.length} 个` + (s.branches.skipped.length > 0 ? `，按配置跳过 ${s.branches.skipped.length} 个` : '') + '（只读本地已有的分支，不 fetch）')
  }
  const rm = s.branches.remotes
  if (rm && rm.count > 0 && (rm.lastFetchDays === null || rm.lastFetchDays > 7)) {
    console.error(`  注意：远程分支以上次 fetch 为准（scan 不 fetch），上次 fetch ${rm.lastFetchDays === null ? '找不到记录' : `在 ${rm.lastFetchDays} 天前`}，别人新推的分支看不到。先 git fetch 再 scan`)
  }
  if (s.branches.byBranch.length > 0) {
    console.error('  这些分支还在用部分候选，相关文件判为 pending：')
    for (const b of s.branches.byBranch) console.error(`    - ${b.branch}（最后提交 ${b.date}）：${b.files.length} 个文件`)
    console.error("  分支不会再合回来的话，可以在 profile 里排除，如 branches: { ignore: ['分支名'] } 或 { maxAgeDays: 90 }；不配置就全部查")
  }
  if (s.globalComponents.declarations.length > 0) {
    const g = s.globalComponents
    console.error(`  全局注册的组件：${g.declarations.join('、')} 里登记了 ${g.components} 个，其中 ${g.used} 个在模板里用到（按标签认，补成引用交给 knip）`)
  }
  const b = s.blindSpots
  const hits = [
    b.sameNameTags && `同名标签 ${b.sameNameTags} 个`,
    b.commentedTags && `注释里的同名标签 ${b.commentedTags} 个`,
    b.bareExports && `疑似自动导入 ${b.bareExports} 个`,
    b.externalMaybe && `疑似拼出来的路径 ${b.externalMaybe} 个`
  ].filter(Boolean)
  if (hits.length > 0) console.error(`  盲区兜底（看不准的不判死，证据里写明原因）：${hits.join('，')}`)
  if (b.autoImportWithoutDeclaration) console.error('  注意：装了 unplugin-auto-import 却没有找到声明文件（dts 关了？），自动导入的本地函数只能按名字兜底')
  if (b.autoImports > 0) console.error(`  自动导入：声明文件里登记了 ${b.autoImports} 个本地函数，按名字认出用法，补成引用交给 knip`)
  if (s.addedDeps.length > 0) {
    console.error(`  package.json 没有声明 ${s.addedDeps.join('、')}：只在临时目录里补上，否则 knip 会跳过对应的单文件组件`)
  }
  if (s.dynamicLoads > 0) {
    console.error(`  路径里有变量的动态加载 ${s.dynamicLoads} 处，落在范围里的候选判为 unknown` + (s.reviewedLoads > 0 ? `（其中 ${s.reviewedLoads} 处已人工确认，不圈文件）` : ''))
  }
  if (s.warnings.length > 0) {
    console.error(`  注意 ${s.warnings.length} 处：`)
    for (const w of s.warnings) console.error(`    - ${w.from}:${w.line}  ${w.detail}`)
  }
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
