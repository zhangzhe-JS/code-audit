/**
 * 接口的历史：没人用的接口是什么时候、为什么没人用的
 *
 * 对每个没人用的定义（所在的顶层函数 fn，在文件 file 里）：
 * 1. 失去引用：主线上（first-parent）删掉过 fn 的提交里，找最近的一个——删掉的那一行所在的文件，
 *    在删之前 import 了 file（或者 import 了名字 fn，弱证据），说明是调用方不再调用它了
 * 2. 找不到这样的提交：从来没被调用过，记下 fn 是哪个提交加进 file 的（定义时间）
 *
 * 接口的历史取所有定义里最近一次失去引用的提交；都没被调用过时取最早的定义提交
 * 只看主线：分支上的提交显示为合并进主线的那个提交（和文件维度的 history 一致）
 */
import { posix } from 'node:path'
import { git, COMMIT_FORMAT, parseCommit } from '../history/git.js'
import { IMPORT_SPEC, buildLookup, resolveSpec } from '../collect/path-refs.js'
import { codeOf } from '../collect/source-text.js'
import { MODULE, TEMPLATE } from './extract.js'
import { traceHistory } from '../history/index.js'

const DEAD = new Set(['dead', 'dead-only-ref'])

/**
 * 给扫描结果里没人用的接口补上历史（直接改 result，返回 result）
 * @param {object} opts
 * @param {string} opts.root
 * @param {object} opts.result  scanApi 的结果
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {number} [opts.maxCommits] 每个定义最多看多少个候选提交
 * @param {(done: number, total: number) => void} [opts.progress]
 */
export function traceApiHistory({ root, result, config, maxCommits = 40, progress }) {
  const rev = result.project.rev
  const targets = result.endpoints.filter((e) => DEAD.has(e.status))
  const cache = new Map()
  // 所有要查的函数名一起找候选提交、每个提交的 diff 只取一次：逐个查要把整个历史扫上百遍
  const names = new Set()
  for (const ep of targets) for (const d of ep.definitions) if (DEAD.has(d.state) && !d.deadCallers?.length) names.add(d.fn.split('、')[0])
  const ctx = createContext({ root, rev, config, names: [...names].filter((n) => n !== MODULE && n !== TEMPLATE && n !== 'default') })
  const newer = commitOrder(root, rev)
  targets.forEach((ep, i) => {
    for (const d of ep.definitions) {
      if (!DEAD.has(d.state)) continue
      const fn = d.fn.split('、')[0]
      if (fn === MODULE || fn === TEMPLATE || fn === 'default') continue
      const key = `${d.file}#${fn}`
      if (!cache.has(key)) {
        cache.set(key, d.deadCallers?.length > 0
          ? traceViaDeadCallers({ root, rev, file: d.file, fn, callers: d.deadCallers, config, newer })
          : traceDefinition({ root, rev, file: d.file, fn, config, maxCommits, ctx }))
      }
      d.history = cache.get(key)
    }
    ep.history = summarizeHistory(ep.definitions, newer)
    progress?.(i + 1, targets.length)
  })
  result.historyTraced = true
  return result
}

/**
 * 接口的历史：有定义失去引用 → 取最近的一次；每个定义都确认从没被调用过 → never；
 * 其余（有定义没查、查到上限还没找到、调用方还被死代码引用）→ null，交给人看（报告里降为需审核）
 */
/**
 * 比较两个提交的先后，返回负数表示 a 更新。按主线（first-parent）上的位置比：日期只到天，同一天的多个提交分不出先后；
 * 不在主线上的（理论上不会出现）退回按日期比
 * @returns {(a: {hash: string, date: string}, b: {hash: string, date: string}) => number}
 */
export function commitOrder(root, rev) {
  const pos = new Map(git(root, ['rev-list', '--first-parent', rev]).split('\n').filter(Boolean).map((h, i) => [h, i]))
  return (a, b) => {
    const pa = pos.get(a.hash)
    const pb = pos.get(b.hash)
    if (pa !== undefined && pb !== undefined) return pa - pb
    return b.date.localeCompare(a.date)
  }
}

/** 只按日期比（没有仓库可查时）：同一天的分不出先后 */
const byDate = (a, b) => b.date.localeCompare(a.date)

export function summarizeHistory(defs, newer = byDate) {
  const lost = defs.map((d) => d.history?.lostRef).filter(Boolean).sort((a, b) => newer(a.commit, b.commit))
  if (lost.length > 0) return { type: 'lost', ...lost[0] }
  const dead = defs.filter((d) => DEAD.has(d.state))
  if (dead.length > 0 && dead.every((d) => d.history && d.history.lostRef === null && d.history.introduced && !d.history.unresolved)) {
    const intro = dead.map((d) => d.history.introduced).sort((a, b) => newer(b, a))
    return { type: 'never', introduced: intro[0] }
  }
  return null
}

/**
 * @returns {{lostRef: {commit: object, from: string, text: string, weak: boolean} | null, introduced: object | null}}
 */
export function traceDefinition({ root, rev, file, fn, config, maxCommits = 40, ctx = createContext({ root, rev, config, names: [fn] }) }) {
  const word = new RegExp(`(^|[^\\w$])${escapeRe(fn)}([^\\w$]|$)`)
  // 定义自身的那一行（function fn、const fn =、fn: …、fn() {、export { fn }）：删掉它不是「不再调用」
  const declaration = new RegExp(`(\\b(function|const|let|var|class)\\s+${escapeRe(fn)}\\b)|(^|[^\\w$.])${escapeRe(fn)}\\s*(:|=(?!=))|^\\s*(async\\s+)?${escapeRe(fn)}\\s*\\([^)]*\\)\\s*\\{|export\\s*\\{[^}]*\\b${escapeRe(fn)}\\b`)
  let weak = null
  let seen = 0
  let capped = false
  let stillUsedBy = null
  for (const c of ctx.commits) {
    const files = ctx.removed(c)
    if (!files.some((f) => f.removed.some((l) => word.test(l)))) continue
    if (++seen > maxCommits) {
      capped = true
      break
    }
    // 删掉的行之后文件里还引用着它（只是改了这一行，比如加了个参数）：不算失去引用
    // 同一个文件：除了定义行还出现这个名字；别的文件：还 import 着定义所在的模块并且用到这个名字
    const stillRefers = (path) => {
      const after = readAt(root, c, path)
      if (after === null) return false
      const code = codeOf(path, after)
      const uses = code.split('\n').some((l) => word.test(l) && !declaration.test(l) && !/^\s*import\b/.test(l))
      if (path === file) return uses
      return uses && importsTarget({ code, from: path, file, fn, aliases: config.aliases }) !== null
    }
    for (const { path, removed } of files) {
      if (path === file) {
        // 同一个文件里删掉的调用（本文件内部在用的函数不再调用它）
        const own = removed.find((l) => word.test(l) && !declaration.test(l))
        if (own && !stillRefers(path)) return { lostRef: withBranch(root, { commit: commitInfo(root, c), from: path, text: own.trim().slice(0, 200), weak: false }, fn), introduced: null }
        continue
      }
      const hit = removed.find((l) => word.test(l))
      if (!hit) continue
      if (stillRefers(path)) {
        stillUsedBy ??= path
        continue
      }
      const before = readAt(root, `${c}^1`, path)
      if (before === null) continue
      const imp = importsTarget({ code: codeOf(path, before), from: path, file, fn, aliases: config.aliases })
      if (imp === 'module') return { lostRef: withBranch(root, { commit: commitInfo(root, c), from: path, text: hit.trim().slice(0, 200), weak: false }, fn), introduced: null }
      if (imp === 'name' && !weak) weak = withBranch(root, { commit: commitInfo(root, c), from: path, text: hit.trim().slice(0, 200), weak: true }, fn)
    }
  }
  if (weak) return { lostRef: weak, introduced: null }
  // 看了上限个候选提交还没找到：不能说「从没被调用」，只能说没查到
  if (capped) return { lostRef: null, introduced: null, unresolved: `看了 ${maxCommits} 个改动过 ${fn} 的提交还没找到` }
  // 有文件改过调用、之后一直还引用着它（比如引用方自己走不到、没被认出来）：不是「从没被调用」
  if (stillUsedBy) return { lostRef: null, introduced: null, unresolved: `${stillUsedBy} 改过对它的调用，之后一直还引用着` }
  const introduced = findDefined(root, rev, file, fn)
  if (!introduced) return { lostRef: null, introduced: null, unresolved: `没找到在 ${file} 里声明 ${fn} 的提交` }
  return { lostRef: null, introduced }
}

/**
 * 定义仍被走不到的文件引用：接口是随着这些文件失去入口才没人用的。
 * 用文件维度的 history 查引用方什么时候失去引用，取最近的一个
 */
function traceViaDeadCallers({ root, rev, file, fn, callers, config, newer = byDate }) {
  const found = []
  for (const caller of callers.slice(0, 5)) {
    try {
      const h = traceHistory({ root, file: caller, rev, config }).history
      if (h.lostRef) found.push({ commit: h.lostRef, from: caller, text: `引用方 ${caller} 失去入口（${fn} 的调用还在这个文件里）`, weak: false, via: 'dead-caller' })
    } catch {
      // 查不了历史的引用方（路径不在源码目录等）：跳过，不影响其他引用方
    }
  }
  found.sort((a, b) => newer(a.commit, b.commit))
  if (found.length > 0) return { lostRef: found[0], introduced: null }
  // 引用方也查不到失去入口的提交（比如它自己也只被死代码引用）：不是「从没被调用」，交给人看
  return { lostRef: null, deadCallers: callers, introduced: null, unresolved: `仍被没人用的文件引用（${callers.slice(0, 3).join('、')}），没查到它们失去入口的提交` }
}

/** 失去引用的是合并提交：在合进来的分支上找真正删掉调用的提交 */
function branchCommit(root, c, from, fn) {
  const parents = git(root, ['rev-list', '--parents', '-n', '1', c]).split(' ')
  if (parents.length < 3) return null
  const word = new RegExp(`(^|[^\\w$])${escapeRe(fn)}([^\\w$]|$)`)
  let list = []
  try {
    list = git(root, ['log', `${c}^1..${c}^2`, '--format=%H', '--', from]).split('\n').filter(Boolean)
  } catch {
    return null
  }
  for (const b of list.slice(0, 30)) {
    let diff
    try {
      diff = git(root, ['show', '-U0', '--no-color', '--format=', '--first-parent', b, '--', from], { raw: true })
    } catch {
      continue
    }
    if (diff.split('\n').some((l) => l.startsWith('-') && !l.startsWith('---') && word.test(l))) return commitInfo(root, b)
  }
  return null
}

/**
 * 候选提交（主线上改动过这些名字的，新的在前）和每个提交删掉的行（缓存）
 */
function createContext({ root, rev, config, names }) {
  const pathspecs = config.sourceRoots.flatMap((dir) => config.extensions.map((e) => `:(glob)${dir}/**/*${e}`))
  let commits = []
  if (names.length > 0) {
    // 名字太多时分批，避免正则过长
    const set = new Set()
    for (let i = 0; i < names.length; i += 80) {
      const alt = names.slice(i, i + 80).map(escapeRe).join('|')
      try {
        for (const c of git(root, ['log', rev, '--first-parent', '--format=%H', `-G${wordRegex(`(${alt})`)}`, '--', ...pathspecs]).split('\n')) if (c) set.add(c)
      } catch (e) {
        if (e.status !== 1) throw e
      }
    }
    const order = git(root, ['log', rev, '--first-parent', '--format=%H']).split('\n')
    commits = order.filter((c) => set.has(c))
  }
  const cache = new Map()
  const removed = (c) => {
    if (!cache.has(c)) {
      let diff
      try {
        diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', `${c}^1`, c, '--', ...pathspecs], { raw: true })
      } catch (e) {
        if (/unknown revision|bad revision/.test(e.message)) diff = git(root, ['show', '-U0', '--no-color', '--format=', c, '--', ...pathspecs], { raw: true })
        else throw e
      }
      cache.set(c, removedLines(diff).map((f) => ({ path: f.path, removed: f.removed.map(stripLineComment) })))
    }
    return cache.get(c)
  }
  return { commits, removed }
}

/** 解析 git diff -U0：每个文件删掉的行 */
function removedLines(diff) {
  const out = []
  let cur = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      cur = null
    } else if (line.startsWith('--- ')) {
      continue
    } else if (line.startsWith('+++ ')) {
      const p = line.slice(4)
      cur = p === '/dev/null' ? null : { path: p.replace(/^b\//, '').replace(/\t$/, ''), removed: [] }
      if (cur) out.push(cur)
    } else if (line.startsWith('-') && cur) {
      cur.removed.push(line.slice(1))
    }
  }
  // 整个文件被删掉时没有 +++ b/ 路径：用 --- a/ 那一行补上
  const deleted = [...diff.matchAll(/^--- a\/(.+)\n\+\+\+ \/dev\/null\n((?:@@.*\n|-.*\n)*)/gm)]
  for (const m of deleted) out.push({ path: m[1], removed: m[2].split('\n').filter((l) => l.startsWith('-')).map((l) => l.slice(1)) })
  return out
}

function stripLineComment(l) {
  return l.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '')
}

function readAt(root, commit, path) {
  try {
    return git(root, ['show', `${commit}:${path}`], { raw: true })
  } catch {
    return null
  }
}

/** 文件在删之前有没有 import 定义所在的文件：module = 按路径解析到了；name = 只是 import 了同名的名字 */
function importsTarget({ code, from, file, fn, aliases }) {
  const lookup = buildLookup([file])
  let byName = false
  for (const m of code.matchAll(IMPORT_SPEC)) {
    const spec = m[2] ?? m[4]
    const resolved = resolveSpec(spec, from, aliases)
    if (resolved !== null && lookup.has(resolved)) return 'module'
    // 从 index 重新导出：import { fn } from '@/api'
    if (resolved !== null && lookup.has(posix.join(resolved, posix.basename(file).replace(/\.[^.]+$/, '')))) return 'module'
  }
  const named = new RegExp(`import\\s*\\{[^}]*\\b${escapeRe(fn)}\\b[^}]*\\}\\s*from`)
  if (named.test(code)) byName = true
  return byName ? 'name' : null
}

function withBranch(root, lost, fn) {
  const b = branchCommit(root, lost.commit.hash, lost.from, fn)
  return b ? { ...lost, commitFrom: b } : lost
}

function commitInfo(root, c) {
  return parseCommit(git(root, ['log', '-1', '--date=short', `--format=${COMMIT_FORMAT}`, c]))
}

/**
 * fn 在 file 里被定义的主线提交（定义时间）
 *
 * 不是「名字第一次出现」：注释（// fn 已废弃）、调用（fn()）、字符串里也会出现这个名字。
 * 先按整词找出改动过这个名字的提交（从早到晚），再看这个提交新增的行里有没有它的声明，第一个有的就是定义提交；
 * 都没有时返回 null（没查到），不拿第一次出现名字的提交凑数
 */
export function findDefined(root, rev, file, fn) {
  let commits
  try {
    commits = git(root, ['log', rev, '--first-parent', '--reverse', '--format=%H', `-G${wordPattern(fn)}`, '--', file]).split('\n').filter(Boolean)
  } catch (e) {
    if (e.status === 1) return null
    throw e
  }
  const decl = declarationLine(fn)
  for (const c of commits) {
    let diff
    try {
      diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', `${c}^1`, c, '--', file], { raw: true })
    } catch (e) {
      if (/unknown revision|bad revision/.test(e.message)) diff = git(root, ['show', '-U0', '--no-color', '--format=', c, '--', file], { raw: true })
      else throw e
    }
    const added = diff.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).map((l) => l.slice(1))
    if (added.some((l) => decl.test(codeLine(l)))) return commitInfo(root, c)
  }
  return null
}

/** 声明 fn 的一行：function fn、class fn、const / let / var fn =、fn: function / fn: (…) =>、fn() { 方法简写 */
function declarationLine(fn) {
  const n = escapeRe(fn)
  return new RegExp([
    `\\b(function\\*?|class)\\s+${n}\\b`,
    `\\b(const|let|var)\\s+${n}\\s*(:[^=]*)?=`,
    `(^|[^\\w$.])${n}\\s*:\\s*(async\\s+)?(function\\b|\\(|[\\w$]+\\s*=>)`,
    `^\\s*(async\\s+)?${n}\\s*\\([^)]*\\)\\s*\\{`
  ].join('|'))
}

/** 一行代码去掉注释部分；整行是注释（//、/*、* 开头）时返回空 */
function codeLine(l) {
  if (/^\s*(\/\/|\/\*|\*)/.test(l)) return ''
  return l.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '')
}

/** git -G 用的整词正则（POSIX 扩展正则，没有 \b）：JS 标识符里能出现的字符都不能挨着 */
function wordPattern(fn) {
  return wordRegex(escapeRe(fn))
}

function wordRegex(body) {
  return `(^|[^A-Za-z0-9_$])${body}([^A-Za-z0-9_$]|$)`
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
