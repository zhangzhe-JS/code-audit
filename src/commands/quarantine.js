/**
 * quarantine 子命令：把确认没人用的文件移进隔离区。唯一会改动目标项目的命令
 *
 *   code-audit quarantine --root <仓库> --profile <配置> --in <verified.json>           只打印计划，不改任何东西
 *   code-audit quarantine --root <仓库> --profile <配置> --in <verified.json> --apply   在工作区里做好隔离，不建分支、不提交
 *
 * 提交交给开发人员：--apply 只改工作区（移动用 git mv 暂存好，其余改动不暂存），最后列出改了什么
 *
 * 执行前检查（任何一条不满足都不动手）：
 * - 工作区干净（已跟踪的文件没有改动）：出错时才能整体撤回，也不会和别人的改动混在一起
 * - HEAD 就是数据里分析的提交：中间有新提交的话，结论可能已经不对，要重新 scan
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { readJson } from '../core/output.js'
import { validate } from '../core/schema.js'
import { git } from '../history/git.js'
import { buildPlan } from '../quarantine/plan.js'
import { makeRecaptureCheck } from '../quarantine/recapture.js'
import { applyPlan, currentBranch } from '../quarantine/apply.js'

const USAGE = `用法：code-audit quarantine --root <仓库> --profile <配置> --in <verified.json> [--apply]

把 dead / dead-only-ref、并且实删验证通过的文件移进隔离区，加头注释，修正相对路径，更新隔离目录的 README。
默认就近隔离：放进文件所在目录下的 _deprecated（src/a/b.js → src/a/_deprecated/b.js）；
挪过去以后会被 import.meta.glob、require.context 等重新加载的，不移。
不带 --apply 只打印计划；带 --apply 时在工作区里做好隔离，不建分支、不提交，提交交给开发人员。

选项：
  --root         仓库目录，默认当前目录
  --profile      项目配置文件（必填）；隔离方式在 quarantine 里配置：
                   { layout: 'nearby', dirName: '_deprecated' }（默认，就近）
                   { layout: 'central', dir: 'src/_deprecated', base: 'src' }（集中，子目录结构不变）
  --in           verify 输出的数据（必填）
  --apply        真的执行：在工作区里移动文件、加头注释、改路径、写 README。不建分支、不提交
  --moved-at     头注释、清单里写的移入日期，默认今天（YYYY-MM-DD）
  -h, --help     显示帮助`

export async function run(argv) {
  let values
  try {
    ;({ values } = parseArgs({
      args: argv,
      options: {
        root: { type: 'string' },
        profile: { type: 'string' },
        in: { type: 'string' },
        apply: { type: 'boolean' },
        'moved-at': { type: 'string' },
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
  if (!values.profile) return fail(`缺少 --profile\n\n${USAGE}`)
  if (!values.in) return fail(`缺少 --in（verify 输出的数据）\n\n${USAGE}`)

  const root = resolve(values.root ?? '.')
  const log = (msg) => console.error(msg)
  try {
    const config = await loadProfile(values.profile)
    const data = readJson(values.in)
    const errors = validate(data)
    if (errors.length > 0) throw new Error(`数据不符合格式：\n- ${errors.join('\n- ')}`)

    const movedAt = values['moved-at'] ?? today()
    if (!isDate(movedAt)) throw new Error(`--moved-at 必须是实际存在的 YYYY-MM-DD 日期：${movedAt}`)
    const from = currentBranch(root)
    const branch = from.startsWith('detached:') ? undefined : from

    // 计划按分析的提交算（和 scan、history、verify 看到的是同一份代码）
    const rev = data.project.rev
    const files = git(root, ['ls-tree', '-r', '-z', '--name-only', rev], { raw: true }).split('\0').filter(Boolean)
    const tree = git(root, ['ls-tree', '-r', '-z', '--format=%(objectmode) %(path)', rev], { raw: true }).split('\0').filter(Boolean)
    const modes = new Map(tree.map((entry) => [entry.slice(0, 6), entry.slice(7)]))
    const readFile = (p) => git(root, ['show', `${rev}:${p}`], { raw: true })
    const plan = buildPlan({
      data,
      config,
      files,
      readFile,
      recaptured: makeRecaptureCheck({ files, readFile, config }),
      isSymlink: (path) => modes.get(path) === '120000',
      movedAt,
      branch
    })
    printPlan(plan, log)

    if (!values.apply) {
      log('\n以上只是计划，没有改任何东西。确认后加 --apply 执行（只改工作区，不建分支、不提交）')
      return
    }
    if (plan.moves.length === 0) throw new Error('没有要隔离的文件，不执行')

    // 执行前检查
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty) throw new Error(`目标项目的工作区有没提交的改动，先提交或处理掉再隔离：\n${dirty}`)
    const hidden = git(root, ['ls-files', '-v']).split('\n').filter((line) => /^[a-zS]/.test(line))
    if (hidden.length > 0) throw new Error(`目标项目存在 assume-unchanged 或 skip-worktree 文件，无法可靠回滚隔离：\n${hidden.join('\n')}`)
    const head = git(root, ['rev-parse', 'HEAD'])
    if (head !== rev) {
      throw new Error(`目标项目当前的提交 ${head} 不是分析时的提交 ${rev}：中间代码变了，结论可能已经不对。请切到 ${rev}，或对当前提交重新 scan、history、verify`)
    }

    const r = applyPlan({ root, plan, config, movedAt, branch, log })
    printResult(r, root, log)
  } catch (e) {
    fail(e.message)
  }
}

function printPlan(plan, log) {
  log(plan.layout === 'central' ? `隔离方式：集中放进 ${plan.dir}（按相对 ${plan.base} 的路径）` : `隔离方式：就近，放进文件所在目录下的 ${plan.dirName}`)
  log(`要隔离 ${plan.moves.length} 个文件：`)
  for (const m of plan.moves) {
    log(`  - ${m.from} → ${m.to}`)
    for (const c of m.changes) log(`      第 ${c.line} 行：${c.before} → ${c.after}`)
    for (const u of m.unresolved) log(`      第 ${u.line} 行：${u.spec} 找不到指向的文件，不改`)
    if (!m.header) log(`      不加头注释：${m.headerSkipped}`)
  }
  if (plan.skipped.length > 0) {
    log(`不隔离 ${plan.skipped.length} 个：`)
    for (const s of plan.skipped) log(`  - ${s.file}：${s.reason}`)
  }
  if (plan.readmes.length > 0) {
    log(`隔离目录 ${plan.readmes.length} 个，每个一份 README：`)
    for (const r of plan.readmes) log(`  - ${r.path}（${r.moves.length} 个文件，${r.exists ? '已有，在最后追加' : '新建'}）`)
  }
  if (plan.lintHints.length > 0) {
    log('lint 等工具配置不自动改，需要的话手动加上：')
    for (const h of plan.lintHints) log(`  - ${h}`)
  }
}

/** 执行结果：改了什么。提交交给开发人员 */
function printResult(r, root, log) {
  log('\n隔离完成（只改了工作区，没有建分支、没有提交）：')
  log(`移动 ${r.moved.length} 个文件（git mv，改名已暂存）：`)
  for (const m of r.moved) log(`  - ${m.from} → ${m.to}`)
  if (r.rewrites.length > 0) {
    log(`改了 ${r.rewrites.length} 处相对路径（未暂存）：`)
    for (const c of r.rewrites) log(`  - ${c.file} 第 ${c.line} 行：${c.before} → ${c.after}`)
  }
  log(`加了头注释 ${r.headers.length} 个文件（未暂存）`)
  log(`README ${r.readmes.length} 份（未暂存）：`)
  for (const x of r.readmes) log(`  - ${x.path}（${x.created ? '新建' : '在最后追加'}）`)
  log('\n接下来由开发人员审核后提交。建议先提交已暂存的改名，再提交其余改动：一起提交的话，小文件可能被 git 当成删了再新建，历史接不上')
  log(`  查看改动：git -C ${root} status；git -C ${root} diff`)
  log(`  不要了：git -C ${root} reset --hard HEAD，再删掉新建的 README（见上面「新建」的）`)
}

function today() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function isDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
