/**
 * quarantine 子命令：把确认没人用的文件移进隔离区。唯一会改动目标项目的命令
 *
 *   code-audit quarantine --root <仓库> --profile <配置> --in <verified.json>           只打印计划，不改任何东西
 *   code-audit quarantine --root <仓库> --profile <配置> --in <verified.json> --apply   新建分支，分两次提交；不 push
 *
 * 执行前检查（任何一条不满足都不动手）：
 * - 工作区干净（已跟踪的文件没有改动）
 * - HEAD 就是数据里分析的提交：中间有新提交的话，结论可能已经不对，要重新 scan
 * - 新分支名没被占用
 */
import { parseArgs } from 'node:util'
import { resolve } from 'node:path'
import { loadProfile } from '../core/config.js'
import { readJson } from '../core/output.js'
import { validate } from '../core/schema.js'
import { git } from '../history/git.js'
import { buildPlan } from '../quarantine/plan.js'
import { applyPlan, currentBranch } from '../quarantine/apply.js'

const USAGE = `用法：code-audit quarantine --root <仓库> --profile <配置> --in <verified.json> [--apply]

把 dead / dead-only-ref、并且实删验证通过的文件移进隔离区，加头注释，修正相对路径，更新隔离区的 README。
不带 --apply 只打印计划；带 --apply 时新建分支、分两次提交（第一次只移动，git 认得出是改名），不 push。

选项：
  --root         仓库目录，默认当前目录
  --profile      项目配置文件（必填）；隔离区在 quarantine: { dir, base } 里配置，默认 <源码目录>/_deprecated
  --in           verify 输出的数据（必填）
  --apply        真的执行：新建分支并提交。不带时只打印计划
  --branch       新分支名，默认 code-audit/quarantine-<日期>
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
        branch: { type: 'string' },
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(movedAt)) throw new Error(`--moved-at 格式应为 YYYY-MM-DD：${movedAt}`)
    const branchName = values.branch ?? `code-audit/quarantine-${movedAt}`
    const from = currentBranch(root)

    // 计划按分析的提交算（和 scan、history、verify 看到的是同一份代码）
    const rev = data.project.rev
    const files = git(root, ['ls-tree', '-r', '-z', '--name-only', rev], { raw: true }).split('\0').filter(Boolean)
    const plan = buildPlan({
      data,
      config,
      files,
      readFile: (p) => git(root, ['show', `${rev}:${p}`], { raw: true }),
      movedAt,
      branch: from.startsWith('detached:') ? undefined : from
    })
    printPlan(plan, log)

    if (!values.apply) {
      log('\n以上只是计划，没有改任何东西。确认后加 --apply 执行（会新建分支、提交两次，不 push）')
      return
    }
    if (plan.moves.length === 0) throw new Error('没有要隔离的文件，不执行')

    // 执行前检查
    const dirty = git(root, ['status', '--porcelain', '--untracked-files=no'])
    if (dirty) throw new Error(`目标项目的工作区有没提交的改动，先提交或处理掉再隔离：\n${dirty}`)
    const head = git(root, ['rev-parse', 'HEAD'])
    if (head !== rev) {
      throw new Error(`目标项目当前的提交 ${head} 不是分析时的提交 ${rev}：中间代码变了，结论可能已经不对。请切到 ${rev}，或对当前提交重新 scan、history、verify`)
    }
    try {
      git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branchName}`])
      throw Object.assign(new Error(`分支 ${branchName} 已经存在，换一个名字（--branch）`), { taken: true })
    } catch (e) {
      if (e.taken) throw e
    }

    const r = applyPlan({ root, plan, config, branchName, movedAt, log })
    log(`\n完成：在新分支 ${r.branch} 上提交了 ${r.commits.length} 次（没有 push）`)
    log(`  查看：git -C ${root} log --stat ${r.from.startsWith('detached:') ? r.from.slice(9) : r.from}..${r.branch}`)
    log(`  不要了：git -C ${root} switch ${r.from.startsWith('detached:') ? `--detach ${r.from.slice(9)}` : r.from} && git -C ${root} branch -D ${r.branch}`)
  } catch (e) {
    fail(e.message)
  }
}

function printPlan(plan, log) {
  log(`隔离区：${plan.dir}（按相对 ${plan.base} 的路径放进去）`)
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
  log(`隔离区清单：${plan.readme.path}（${plan.readme.exists ? '已有，在最后追加这一批' : '新建'}）`)
  if (plan.lintHints.length > 0) {
    log('lint 等工具配置不自动改，需要的话手动加上：')
    for (const h of plan.lintHints) log(`  - ${h}`)
  }
}

function today() {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function fail(message) {
  console.error(message)
  process.exitCode = 1
}
