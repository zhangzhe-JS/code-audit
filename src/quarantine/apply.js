/**
 * 执行隔离计划：唯一会改动目标项目的地方
 *
 * 1. 新建分支（不在原分支上改）
 * 2. 第一次提交只做 git mv：git 才能认出是改名，文件历史接得上（小文件改了内容再移，会被当成删了再新建）
 * 3. 第二次提交：加头注释、改相对路径、更新隔离区的 README
 * 不 push。任何一步出错：撤回这个分支上的改动，切回原分支，删掉新分支——目标项目回到执行前的样子
 *
 * git 钩子（husky pre-commit、commitlint 等）照常执行，不跳过团队的规则；钩子没通过也按出错处理，整体撤回
 *
 * 调用前由命令检查：工作区干净、HEAD 就是分析的提交、新分支名没被占用
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git } from '../history/git.js'
import { renderQuarantineTable } from '../report/quarantine-table.js'
import { makeLocator, rewriteRelativePaths } from './rewrite.js'

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./plan.js').QuarantinePlan} opts.plan
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {string} opts.branchName  新分支名
 * @param {string} opts.movedAt
 * @param {(msg: string) => void} [opts.log]
 * @returns {{branch: string, from: string, commits: string[]}}
 */
export function applyPlan({ root, plan, config, branchName, movedAt, log = () => {} }) {
  if (plan.moves.length === 0) throw new Error('没有要隔离的文件')
  const start = git(root, ['rev-parse', 'HEAD'])
  const from = currentBranch(root)

  git(root, ['switch', '-c', branchName])
  try {
    // 第一次提交：只移动
    for (const m of plan.moves) {
      mkdirSync(dirname(join(root, m.to)), { recursive: true })
      git(root, ['mv', '--', m.from, m.to])
    }
    git(root, ['commit', '-m', `chore(code-audit): 隔离 ${plan.moves.length} 个没人用的文件（只移动，保留 git 历史）`])
    log(`第一次提交：移动 ${plan.moves.length} 个文件`)

    // 第二次提交：头注释、相对路径、README。路径按移动后的文件重新算一遍（内容和计划时一样）
    const files = new Set(git(root, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean))
    const moved = new Map(plan.moves.map((m) => [m.from, m.to]))
    // 移动后旧路径已经不在了，但指向它们的写法要按旧路径解析：把旧路径也算进去
    const locate = makeLocator(new Set([...files, ...moved.keys()]), config.extensions)
    const touched = []
    for (const m of plan.moves) {
      const p = join(root, m.to)
      let content = readFileSync(p, 'utf8')
      content = rewriteRelativePaths({ content, from: m.from, to: m.to, moved, aliases: config.aliases, locate }).content
      if (m.header) content = insertHeader(content, m.header)
      writeFileSync(p, content)
      touched.push(m.to)
    }
    const readme = join(root, plan.readme.path)
    writeFileSync(readme, readmeContent(existsSync(readme) ? readFileSync(readme, 'utf8') : null, plan, { config, movedAt, branchName }))
    touched.push(plan.readme.path)
    git(root, ['add', '--', ...touched])
    git(root, ['commit', '-m', 'chore(code-audit): 隔离文件加头注释、修正相对路径、更新隔离区清单'])
    log('第二次提交：头注释、相对路径、隔离区清单')

    const commits = git(root, ['rev-list', '--reverse', `${start}..HEAD`]).split('\n').filter(Boolean)
    return { branch: branchName, from, commits }
  } catch (e) {
    rollback(root, { start, from, branchName })
    throw new Error(`隔离没有完成，已撤回（切回 ${from}，删掉分支 ${branchName}），目标项目和执行前一样：\n${e.message}`)
  }
}

/** 撤回：这个分支上的改动全部丢掉，切回原分支，删掉新分支。执行前工作区是干净的，所以不会丢别的东西 */
function rollback(root, { start, from, branchName }) {
  try {
    git(root, ['reset', '--hard', start])
    git(root, from.startsWith('detached:') ? ['switch', '--detach', from.slice('detached:'.length)] : ['switch', from])
    git(root, ['branch', '-D', branchName])
  } catch (e) {
    throw new Error(`撤回时出错，请手动检查目标项目（应切回 ${from}，删掉分支 ${branchName}）：${e.message}`)
  }
}

/** 当前分支名；不在分支上（detached HEAD）时返回 detached:<提交号> */
export function currentBranch(root) {
  try {
    return git(root, ['symbolic-ref', '--short', '-q', 'HEAD'])
  } catch {
    return `detached:${git(root, ['rev-parse', 'HEAD'])}`
  }
}

/** 头注释放在文件最前面；第一行是 #!（脚本）时放在它后面 */
export function insertHeader(content, header) {
  if (content.startsWith('#!')) {
    const nl = content.indexOf('\n')
    return nl < 0 ? `${content}\n${header}\n` : `${content.slice(0, nl + 1)}${header}\n${content.slice(nl + 1)}`
  }
  return `${header}\n${content}`
}

/**
 * 隔离区的 README：已经有了就在最后追加这一批；没有就新建
 * 已有的内容一个字不改（可能是人工写的说明、已恢复的记录）
 */
export function readmeContent(existing, plan, { config, movedAt, branchName }) {
  // 清单表格：当前路径是新路径，原路径是最早的路径
  const items = plan.moves.map((m) => ({
    ...m.item,
    id: `file:${m.to}`, // 表格的「文件」列按 id 显示
    target: m.to,
    history: m.item.history ? { ...m.item.history, paths: [m.to, ...(m.item.history.paths ?? [m.from])] } : null
  }))
  const section = [`## ${movedAt} 隔离（code-audit，分支 ${branchName}）`, '', renderQuarantineTable(items, { config }), ''].join('\n')
  if (existing !== null) return `${existing.replace(/\s*$/, '')}\n\n${section}`
  return [
    `# ${plan.dir}（隔离区）`,
    '',
    '这里放的是 code-audit 判定为没人用、并且实删验证通过的文件。先隔离观察，确认没有影响后再统一删除。',
    '',
    '- 每个文件开头的注释记录了原路径、引入提交和引用历史',
    '- 需要恢复时，用 git mv 移回原路径（见下表的原路径），并在这里登记',
    '- 业务代码不要 import 这个目录里的文件',
    '',
    section
  ].join('\n')
}
