/**
 * 执行隔离计划：唯一会改动目标项目的地方
 *
 * 只在工作区里做好隔离，不新建分支、不提交——提交交给开发人员：
 * - 移动用 git mv：改名已经暂存好，git 认得出是改名，文件历史接得上
 * - 头注释、相对路径、README 只改文件、不暂存：开发人员看 diff 就知道改了什么
 *   （建议先提交暂存好的改名，再提交其余改动：小文件改了内容又一起提交，可能被 git 当成删了再新建）
 * 任何一步出错：工作区和暂存区回到执行前（执行前要求已跟踪的文件没改动），删掉这次新建的 README 和空目录，
 * 追加过的 README 写回原来的内容（没被 git 跟踪的 README，reset 管不到）
 *
 * 调用前由命令检查：工作区干净、HEAD 就是分析的提交
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, rmdirSync, lstatSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git } from '../history/git.js'
import { renderQuarantineTable } from '../report/quarantine-table.js'
import { makeLocator, rewriteRelativePaths } from './rewrite.js'

/**
 * @typedef {object} ApplyResult
 * @property {{from: string, to: string}[]} moved      移动了哪些（git mv，已暂存）
 * @property {{file: string, line: number, before: string, after: string}[]} rewrites  改了哪些路径
 * @property {string[]} headers   加了头注释的文件
 * @property {{path: string, created: boolean}[]} readmes  新建 / 追加的 README
 */

/**
 * @param {object} opts
 * @param {string} opts.root
 * @param {import('./plan.js').QuarantinePlan} opts.plan
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {string} opts.movedAt
 * @param {string} [opts.branch]  README 里写的分支（当前分支）
 * @param {(msg: string) => void} [opts.log]
 * @returns {ApplyResult}
 */
export function applyPlan({ root, plan, config, movedAt, branch, log = () => {} }) {
  if (plan.moves.length === 0) throw new Error('没有要隔离的文件')
  const createdFiles = []
  /** 追加前的 README：路径 → 原内容 */
  const originals = new Map()
  const createdDirs = []
  const result = { moved: [], rewrites: [], headers: [], readmes: [] }
  try {
    for (const m of plan.moves) {
      assertNoSymlink(root, m.from)
      assertNoSymlink(root, m.to, { allowMissing: true })
    }
    // 移动：git mv，改名暂存好
    for (const m of plan.moves) {
      createdDirs.push(...missingDirs(root, dirname(m.to)))
      mkdirSync(dirname(join(root, m.to)), { recursive: true })
      git(root, ['mv', '--', m.from, m.to])
      result.moved.push({ from: m.from, to: m.to })
    }
    log(`移动 ${result.moved.length} 个文件（git mv，已暂存）`)

    // 头注释、相对路径：按移动后的文件重新算一遍（内容和计划时一样）。只改文件，不暂存
    const files = new Set(git(root, ['ls-files', '-z'], { raw: true }).split('\0').filter(Boolean))
    const moved = new Map(plan.moves.map((m) => [m.from, m.to]))
    // 移动后旧路径已经不在了，但指向它们的写法要按旧路径解析：把旧路径也算进去
    const locate = makeLocator(new Set([...files, ...moved.keys()]), config.extensions)
    for (const m of plan.moves) {
      const p = join(root, m.to)
      const before = utf8Text(readFileSync(p), m.to)
      const r = rewriteRelativePaths({ content: before, from: m.from, to: m.to, moved, aliases: config.aliases, locate })
      let content = r.content
      result.rewrites.push(...r.changes.map((c) => ({ file: m.to, ...c })))
      if (m.header) {
        content = insertHeader(content, m.header)
        result.headers.push(m.to)
      }
      if (content !== before) writeFileSync(p, content, 'utf8')
    }

    // 每个隔离目录的 README
    for (const r of plan.readmes) {
      const readme = join(root, r.path)
      const exists = existsSync(readme)
      assertNoSymlink(root, r.path, { allowMissing: true })
      const before = exists ? readFileSync(readme) : null
      if (exists) originals.set(readme, before)
      else createdFiles.push(readme)
      writeFileSync(readme, readmeBufferContent(before, r, { config, movedAt, branch }))
      result.readmes.push({ path: r.path, created: !exists })
    }
    return result
  } catch (e) {
    rollback(root, { createdFiles, createdDirs, originals })
    throw new Error(`隔离没有完成，已撤回，目标项目和执行前一样：\n${e.message}`)
  }
}

/**
 * 撤回：已跟踪的文件和暂存区回到 HEAD（执行前要求已跟踪的文件没改动，不会丢别的改动），
 * 追加过的 README 写回原内容，删掉这次新建的 README 和目录（没被 git 跟踪的文件，reset 不管它们）
 */
function rollback(root, { createdFiles, createdDirs, originals }) {
  try {
    git(root, ['reset', '--hard', 'HEAD'])
    for (const [f, content] of originals) writeFileSync(f, content)
    for (const f of createdFiles) rmSync(f, { force: true })
    for (const d of [...createdDirs].reverse()) {
      const p = join(root, d)
      if (existsSync(p) && readdirSync(p).length === 0) rmdirSync(p)
    }
  } catch (e) {
    throw new Error(`撤回时出错，请手动检查目标项目（git status）：${e.message}`)
  }
}

/** 这个目录及上级里，哪些现在还不存在（撤回时要删掉）；从上往下排 */
function missingDirs(root, dir) {
  const out = []
  let d = dir
  while (d && d !== '.' && !existsSync(join(root, d))) {
    out.unshift(d)
    d = dirname(d)
  }
  return out
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
  if (content.startsWith('---\n')) {
    const end = content.indexOf('\n---', 4)
    if (end >= 0) {
      const after = end + 4
      return `${content.slice(0, after)}\n${header}\n${content.slice(after)}`
    }
  }
  return `${header}\n${content}`
}

/**
 * 一个隔离目录的 README：已经有了就在最后追加这一批；没有就新建
 * 已有的内容一个字不改（可能是人工写的说明、已恢复的记录）
 * @param {string|null} existing
 * @param {{dir: string, moves: import('./plan.js').Move[]}} readme
 */
export function readmeContent(existing, readme, { config, movedAt, branch }) {
  const section = readmeSection(readme, { config, movedAt, branch })
  if (existing !== null) return `${existing}${existing.endsWith('\n') ? '\n' : '\n\n'}${section}`
  return [
    `# ${readme.dir}（隔离区）`,
    '',
    '这里放的是 code-audit 判定为没人用、并且实删验证通过的文件。先隔离观察，确认没有影响后再统一删除。',
    '',
    '- 每个文件开头的注释记录了原路径、引入提交和引用历史',
    '- 需要恢复时，用 git mv 移回原路径（见下表的原路径），并在这里登记',
    '- 确认没有影响后，整个目录一起删掉',
    '- 业务代码不要 import 这个目录里的文件',
    '',
    section
  ].join('\n')
}

function readmeSection(readme, { config, movedAt, branch }) {
  // 清单表格：当前路径是新路径，原路径是最早的路径
  const items = readme.moves.map((m) => ({
    ...m.item,
    id: `file:${m.to}`, // 表格的「文件」列按 id 显示
    target: m.to,
    history: m.item.history ? { ...m.item.history, paths: [m.to, ...(m.item.history.paths ?? [m.from])] } : null
  }))
  return [`## ${movedAt} 隔离（code-audit${branch ? `，分支 ${branch}` : ''}）`, '', renderQuarantineTable(items, { config }), ''].join('\n')
}

function readmeBufferContent(existing, readme, opts) {
  const section = Buffer.from(readmeContent(null, readme, opts), 'utf8')
  if (existing === null) return section
  const separator = existing.length === 0 || existing[existing.length - 1] === 10 ? Buffer.from('\n') : Buffer.from('\n\n')
  return Buffer.concat([existing, separator, Buffer.from(readmeSection(readme, opts), 'utf8')])
}

function utf8Text(buffer, file) {
  const text = buffer.toString('utf8')
  if (!buffer.equals(Buffer.from(text, 'utf8'))) throw new Error(`文件不是可逆 UTF-8，不能安全写入隔离头注释：${file}`)
  return text
}

function assertNoSymlink(root, relativePath, { allowMissing = false } = {}) {
  const parts = relativePath.split('/').filter(Boolean)
  for (let i = 1; i <= parts.length; i++) {
    const p = join(root, ...parts.slice(0, i))
    try {
      if (lstatSync(p).isSymbolicLink()) throw new Error(`隔离路径不能经过符号链接：${relativePath}`)
    } catch (e) {
      if (e.code === 'ENOENT' && allowMissing) continue
      if (e.code === 'ENOENT') break
      throw e
    }
  }
}
