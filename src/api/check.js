/**
 * 改之前先看风险：对比两个提交（如合并请求的目标分支和当前分支）的接口，列出变化和要注意的地方
 *
 * - 新增的接口：附上可能重复的已有接口（路径的词差不多、只差一两段），避免同一个接口写两遍
 * - 不再定义的接口 / 从在用变成没人用的接口：别的项目（--index 里的结果）还在用的，提示后端不能删
 * - 从没人用变成在用：提示一下（之前可能被列进可删清单）
 * - 同一个接口在用的定义变成了多处：可能重复写了
 * - 覆盖报告：新出现的没认出的写法（规则要补）
 *
 * 每条带等级：risk（要处理）/ warn（要确认）/ info（知道一下）
 */
import { scanApi } from './scan.js'
import { similarity } from './similar.js'
import { git } from '../history/git.js'

const LIVE = 'live'

/**
 * @param {object} opts
 * @param {object} opts.before  scanApi 的结果（目标分支）
 * @param {object} opts.after   scanApi 的结果（当前分支）
 * @param {object[]} [opts.others] 其他项目的 api 结果（看别的项目还用不用）
 * @param {Map<string, Set<number>>|null} [opts.changed] 这次改动改到的行：文件 → 当前分支里的行号（null = 不看）
 * @returns {{findings: {level: 'risk'|'warn'|'info', kind: string, key: string, detail: string}[], summary: object}}
 */
export function compareApi({ before, after, others = [], changed = null }) {
  const findings = []
  const add = (level, kind, key, detail) => findings.push({ level, kind, key, detail })
  // 解析失败会让接口清单不完整；任何一侧存在时都不能把“消失”解释成安全变更。
  for (const side of [{ name: '基线', result: before }, { name: '当前提交', result: after }]) {
    for (const error of side.result.coverage?.parseErrors ?? []) {
      add('risk', 'coverage-parseErrors', `${side.name}:${error.from ?? 'unknown'}`, `${side.name} ${error.from ?? '未知文件'}解析失败：${error.message ?? '未知错误'}；接口变化结果不完整，不能据此删除接口`)
    }
  }
  const b = new Map(before.endpoints.map((e) => [e.key, e]))
  const a = new Map(after.endpoints.map((e) => [e.key, e]))
  const usedElsewhere = (key) => others.filter((o) => o.project.name !== after.project.name && o.endpoints.some((e) => e.key === key && e.status === LIVE)).map((o) => o.project.name)
  const elsewhereText = (key) => {
    const list = usedElsewhere(key)
    return list.length > 0 ? `别的项目还在用（${list.join('、')}），后端不能删` : others.length > 0 ? '给出的其他项目也没在用' : '没给其他项目的结果（--index），看不出别的项目用不用'
  }
  const menus = (e) => (e.menus?.length ? `，在用的菜单：${e.menus.join('、')}` : '')
  const where = (e) => e.definitions.map((d) => `${d.file}:${d.line}`).join('、')

  // 同一个函数（文件#函数）的接口变了：地址或方法改了。
  // 旧地址别处还在用、新地址以前别处就有，都照样算：调用这个函数的页面现在打的是另一个接口
  const keysOf = (r) => {
    const m = new Map()
    for (const e of r.endpoints) for (const d of e.definitions) {
      const id = `${d.file}#${d.fn}`
      const x = m.get(id) ?? { file: d.file, fn: d.fn, keys: [], live: false, fingerprint: d.fingerprint ?? null }
      if (!x.keys.includes(e.key)) x.keys.push(e.key)
      if (d.state === LIVE) x.live = true
      m.set(id, x)
    }
    return m
  }
  const fnB = keysOf(before)
  const fnA = keysOf(after)
  const explained = new Set()
  const report = (id, then, now, renamedFrom = null) => {
    const gone = then.keys.filter((k) => !now.keys.includes(k))
    const fresh = now.keys.filter((k) => !then.keys.includes(k))
    if (gone.length === 0 || fresh.length === 0) return
    for (const k of gone) if (!a.has(k)) explained.add(k)
    for (const k of fresh) if (!b.has(k)) explained.add(k)
    const brandNew = fresh.filter((k) => !b.has(k))
    // 新地址是这个项目以前没有的、函数又在用（改之前或改之后）：要确认后端有新接口
    const level = brandNew.length > 0 && (now.live || then.live || gone.some((k) => b.get(k)?.status === LIVE)) ? 'risk' : 'warn'
    const newText = brandNew.length > 0 ? '确认后端已经有新接口' : `新地址项目里本来就有（${fresh.map((k) => where(a.get(k))).join('；')}），确认参数、返回和原来一致`
    const oldText = gone.map((k) => (a.has(k) ? `${k} 项目里别处还在用（${where(a.get(k))}）` : `${k} ${elsewhereText(k)}`)).join('；')
    const who = renamedFrom ? `${now.file} 的 ${renamedFrom} 改名成 ${now.fn}（同一个文件里只有它们一个没了、一个新出现，按改名看），` : `${id.replace('#', ' 的 ')} `
    add(level, 'changed-address', fresh[0], `${who}调用的接口从 ${gone.join('、')} 改成了 ${fresh.join('、')}：${newText}；旧接口：${oldText}`)
  }
  for (const [id, now] of fnA) {
    const then = fnB.get(id)
    if (then) report(id, then, now)
  }
  // 函数改了名、同时改了地址：同一个文件里正好一个函数没了、一个函数新出现，并且旧的接口这个项目里没了、新的接口是项目里新的，按改名看
  const byFile = (from, to) => {
    const m = new Map()
    for (const [id, x] of from) if (!to.has(id)) m.set(x.file, [...(m.get(x.file) ?? []), [id, x]])
    return m
  }
  const removedFns = byFile(fnB, fnA)
  const addedFns = byFile(fnA, fnB)
  for (const [file, removed] of removedFns) {
    const added = addedFns.get(file) ?? []
    if (removed.length !== 1 || added.length !== 1) continue
    const [[, then]] = removed
    const [[id, now]] = added
    if (then.keys.some((k) => a.has(k)) || now.keys.some((k) => b.has(k))) continue
    report(id, then, now, then.fn)
  }

  // 跨文件搬迁或多个文件重排：只在指纹双向唯一时配对，避免把相似包装函数误认为同一个。
  const removedAll = [...fnB].filter(([id]) => !fnA.has(id)).map(([, x]) => x)
  const addedAll = [...fnA].filter(([id]) => !fnB.has(id)).map(([, x]) => x)
  const unique = (xs, key) => {
    const m = new Map()
    for (const x of xs) if (x.fingerprint) m.set(x.fingerprint, [...(m.get(x.fingerprint) ?? []), x])
    return new Map([...m].filter(([, v]) => v.length === 1).map(([k, v]) => [k, v[0]]))
  }
  const oldByFingerprint = unique(removedAll)
  const newByFingerprint = unique(addedAll)
  for (const [fingerprint, then] of oldByFingerprint) {
    const now = newByFingerprint.get(fingerprint)
    if (!now || then.file === now.file) continue
    if (then.keys.some(k => a.has(k)) || now.keys.some(k => b.has(k))) continue
    const id = `${now.file}#${now.fn}`
    report(id, then, now, `${then.file}#${then.fn}`)
  }

  // 新增
  for (const [key, e] of a) {
    if (b.has(key) || explained.has(key)) continue
    const similar = [...a.values()]
      .filter((x) => x.key !== key && x.method === e.method && !isNew(x.key))
      .map((x) => ({ key: x.key, score: similarity(x.path, e.path), live: x.status === LIVE }))
      .filter((x) => x.score >= 0.6)
      .sort((x, y) => y.score - x.score)
      .slice(0, 3)
    if (similar.length > 0) add('warn', 'added-similar', key, `新增 ${key}（${where(e)}），和已有的接口很像：${similar.map((x) => `${x.key}${x.live ? '（在用）' : ''}`).join('、')}。确认不是重复写了`)
    else add('info', 'added', key, `新增 ${key}（${where(e)}）`)
    const live = e.definitions.filter((d) => d.state === LIVE)
    if (live.length > 1) add('warn', 'duplicated', key, `新增的 ${key} 有 ${live.length} 处在用的定义：${live.map((d) => `${d.file}:${d.line} ${d.fn}`).join('、')}`)
  }
  function isNew(k) {
    return !b.has(k)
  }

  // 不再定义 / 状态变化 / 多处定义 / 改到了定义
  for (const [key, e] of b) {
    const now = a.get(key)
    if (!now) {
      if (e.sdk || explained.has(key)) continue
      add('info', 'removed', key, `这个项目不再定义 ${key}（之前${e.status === LIVE ? '在用' : `是 ${e.status}`}）；${elsewhereText(key)}`)
      continue
    }
    if (e.status === LIVE && now.status !== LIVE) {
      add('warn', 'became-unused', key, `${key} 在这个项目里变成了 ${now.status}（之前在用），定义还留着（${where(now)}）：要么删掉定义，要么确认；${elsewhereText(key)}`)
    } else if (e.status !== LIVE && now.status === LIVE) {
      add('info', 'became-live', key, `${key} 重新在用了（之前是 ${e.status}）：如果它在可删清单里，要拿掉`)
    }
    const liveBefore = e.definitions.filter((d) => d.state === LIVE).length
    const liveNow = now.definitions.filter((d) => d.state === LIVE)
    if (liveNow.length > 1 && liveNow.length > liveBefore) {
      add('warn', 'duplicated', key, `${key} 现在有 ${liveNow.length} 处在用的定义：${liveNow.map((d) => `${d.file}:${d.line} ${d.fn}`).join('、')}。可能重复写了`)
    }
    if (changed && now.status === LIVE) {
      const touched = now.definitions.filter((d) => d.state === LIVE && changed.get(d.file)?.has(d.line))
      if (touched.length > 0) add('info', 'touched', key, `改到了在用接口 ${key} 的定义（${touched.map((d) => `${d.file}:${d.line}`).join('、')}）${menus(now)}，引用方 ${now.callers.length} 个`)
    }
  }

  // 覆盖报告：新出现的认不出的写法
  const gapKey = (x) => `${x.from}|${x.fn ?? ''}|${x.shape ?? x.rule ?? ''}|${x.text ?? x.raw ?? x.path ?? ''}`
  for (const kind of ['suspects', 'dynamic', 'wrappers', 'unknownMethod']) {
    const old = new Set((before.coverage?.[kind] ?? []).map(gapKey))
    for (const x of after.coverage?.[kind] ?? []) {
      if (old.has(gapKey(x))) continue
      const what = kind === 'suspects' ? `${x.shape} ${x.text}` : kind === 'wrappers' ? `封装函数 ${x.fn}，地址由参数 ${x.param} 传入` : kind === 'unknownMethod' ? `方法算不出：${x.path}` : `地址算不出：${x.raw ?? '整个是变量'}`
      add('warn', `coverage-${kind}`, `${x.from}:${x.line}`, `${x.from}:${x.line} 有规则认不出的写法（${what}）：补规则后结论才准`)
    }
  }
  const order = { risk: 0, warn: 1, info: 2 }
  findings.sort((x, y) => order[x.level] - order[y.level] || x.key.localeCompare(y.key))
  const count = (l) => findings.filter((f) => f.level === l).length
  const otherSources = others.filter((o) => o.project.name !== after.project.name).map((o) => ({ project: o.project.name, rev: o.project.rev, generatedAt: o.generatedAt ?? null }))
  return { findings, summary: { risk: count('risk'), warn: count('warn'), info: count('info'), before: before.project.rev, after: after.project.rev, project: after.project.name, others: otherSources } }
}

/**
 * 两个提交之间改到的行：文件 → 当前分支里的行号
 */
export function changedLines(root, base, head) {
  const diff = git(root, ['diff', '-U0', '--no-color', '--no-renames', base, head], { raw: true })
  const out = new Map()
  let file = null
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      file = line === '+++ /dev/null' ? null : line.slice(6)
      continue
    }
    const m = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m && file) {
      const startLine = Number(m[1])
      const n = m[2] === undefined ? 1 : Number(m[2])
      const set = out.get(file) ?? new Set()
      for (let i = 0; i < n; i++) set.add(startLine + i)
      out.set(file, set)
    }
  }
  return out
}

/**
 * 跑两次 scanApi 再比较
 * @param {object} opts
 * @param {string} opts.root
 * @param {string} opts.project
 * @param {Readonly<import('../core/config.js').Config>} opts.config
 * @param {string} opts.base   目标分支 / 提交
 * @param {string} [opts.head] 当前分支 / 提交，默认 HEAD
 * @param {object[]} [opts.others]
 */
export function checkChange({ root, project, config, base, head = 'HEAD', others = [], knipDir }) {
  const before = scanApi({ root, project, config, rev: base, knipDir })
  const after = scanApi({ root, project, config, rev: head, knipDir })
  const changed = changedLines(root, before.project.rev, after.project.rev)
  return { ...compareApi({ before, after, others, changed }), before, after }
}

/** 给合并请求 / CI 日志看的 Markdown */
export function checkMarkdown(result) {
  const s = result.summary
  const out = [`## 接口变化检查：${s.project}`, '', `对比 ${s.before.slice(0, 8)} → ${s.after.slice(0, 8)}：要处理 ${s.risk} 条，要确认 ${s.warn} 条，知道一下 ${s.info} 条`, '']
  if (result.findings.length === 0) out.push('没有接口变化。')
  const title = { risk: '要处理', warn: '要确认', info: '知道一下' }
  for (const level of ['risk', 'warn', 'info']) {
    const list = result.findings.filter((f) => f.level === level)
    if (list.length === 0) continue
    out.push(`### ${title[level]}（${list.length}）`, '')
    for (const f of list) out.push(`- ${f.detail}`)
    out.push('')
  }
  const others = s.others ?? []
  out.push(`> 只看前端代码。别的项目在不在用，取决于给了哪些项目的结果：${others.length === 0 ? '没给' : others.map((o) => `${o.project}（提交 ${String(o.rev).slice(0, 8)}${o.generatedAt ? `，生成于 ${o.generatedAt.slice(0, 10)}` : ''}）`).join('、')}。`)
  out.push('> 函数改了名、同时改了地址：同一个文件里正好一个函数没了、一个新出现时按改名提示；对不上的显示成「不再定义」加「新增」。')
  return `${out.join('\n')}\n`
}
