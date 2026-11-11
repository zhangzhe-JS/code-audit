/**
 * 接口维度的汇总报告：合并多个项目的 api 结果，按接口给出结论和风险分级，输出 Markdown 和 CSV（给后端）
 *
 * 结论（越不敢删的越优先）：
 * - 在用        任何一个项目在用：不能删
 * - C 保留      SDK 内置的接口：SDK 要保持完整
 * - C 高风险    有项目判为 unknown / external / pending / dormant：看不准、构建配置在用、别的分支在用、注释停用
 * - B 需审核    都没人用，但证据不够硬：历史没查、没查到、只按名字匹配；只有测试在用；所在项目的覆盖报告还有没补的规则
 * - A 可删      都没人用，每处定义都查到了失去引用的提交（或从没被调用过），所在项目的规则已补全
 *
 * A 也只是「前端没人用」：外部系统的调用前端看不到，后端删之前仍要看网关 / 访问日志，并且小批量删
 */

import { API_SCHEMA_VERSION, API_STATUSES } from './scan.js'

export const VERDICTS = ['在用', 'C 保留', 'C 高风险', 'B 需审核', 'A 可删']
const RISKY = ['unknown', 'external', 'pending', 'dormant']
const DEAD = ['dead', 'dead-only-ref']

/**
 * 校验一份 code-audit api 的结果，返回错误列表（空数组 = 通过）。任何输入都只返回错误，不抛异常
 * 手工改过、拼错字段或损坏的文件在这里报出来，不会在生成报告的半路出错
 * @param {unknown} r
 * @returns {string[]}
 */
export function validateApiResult(r) {
  const errors = []
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  const isStr = (v) => typeof v === 'string' && v !== ''
  const isCommit = (c) => isObj(c) && isStr(c.hash) && isStr(c.date) && typeof c.author === 'string' && typeof c.subject === 'string'
  if (!isObj(r)) return ['不是 JSON 对象']
  if (r.kind !== 'api') errors.push(`kind 必须是 "api"（现在是 ${JSON.stringify(r.kind)}）：不是 code-audit api 的结果？`)
  if (r.version !== API_SCHEMA_VERSION) errors.push(`version 必须是 ${API_SCHEMA_VERSION}（现在是 ${JSON.stringify(r.version)}）：用当前版本的 code-audit api 重新生成`)
  if (!isObj(r.project) || !isStr(r.project.name) || !isStr(r.project.rev)) errors.push('project 必须有 name、rev')
  if (!isObj(r.rules) || !Number.isInteger(r.rules.version)) errors.push('rules.version 必须是整数')
  if (r.coverage !== undefined) {
    if (!isObj(r.coverage)) errors.push('coverage 必须是对象')
    else for (const [k, v] of Object.entries(r.coverage)) if (!Array.isArray(v)) errors.push(`coverage.${k} 必须是数组`)
  }
  if (r.historyTraced !== undefined && typeof r.historyTraced !== 'boolean') errors.push('historyTraced 必须是 true / false')
  if (!Array.isArray(r.endpoints)) return [...errors, 'endpoints 必须是数组']
  // 汇总要和清单一致：手工删改了清单却没改汇总，说明文件被动过
  if (!isObj(r.summary) || r.summary.endpoints !== r.endpoints.length) errors.push(`summary.endpoints（${r.summary?.endpoints}）和接口数（${r.endpoints.length}）对不上`)
  else if (isObj(r.summary.byStatus)) {
    const count = {}
    for (const e of r.endpoints) if (isObj(e)) count[e.status] = (count[e.status] ?? 0) + 1
    const keys = new Set([...Object.keys(count), ...Object.keys(r.summary.byStatus)])
    for (const k of keys) if ((count[k] ?? 0) !== (r.summary.byStatus[k] ?? 0)) errors.push(`summary.byStatus.${k}（${r.summary.byStatus[k] ?? 0}）和清单里的个数（${count[k] ?? 0}）对不上`)
  } else errors.push('summary.byStatus 必须是对象')
  const keys = new Set()
  r.endpoints.forEach((e, i) => {
    const at = `endpoints[${i}]${isObj(e) && isStr(e.key) ? `（${e.key}）` : ''}`
    if (!isObj(e)) return errors.push(`${at} 必须是对象`)
    if (!isStr(e.key) || !isStr(e.method) || !isStr(e.path)) errors.push(`${at} 必须有 key、method、path`)
    else if (e.key !== `${e.method} ${e.path}`) errors.push(`${at} 的 key 和 method、path 对不上`)
    if (keys.has(e.key)) errors.push(`${at} 重复`)
    keys.add(e.key)
    if (!API_STATUSES.includes(e.status)) errors.push(`${at}.status 不认识：${JSON.stringify(e.status)}（可用的：${API_STATUSES.join('、')}）`)
    if (!Array.isArray(e.evidence) || !e.evidence.every((x) => isObj(x) && typeof x.detail === 'string')) errors.push(`${at}.evidence 必须是 { detail } 组成的数组`)
    else if (e.evidence.length === 0) errors.push(`${at}.evidence 不能为空：每个结论都要有依据`)
    if (!Array.isArray(e.definitions) || !e.definitions.every((d) => isObj(d) && isStr(d.file) && Number.isInteger(d.line) && isStr(d.fn))) errors.push(`${at}.definitions 必须是 { file, line, fn } 组成的数组`)
    if (!Array.isArray(e.callers) || !e.callers.every((c) => isObj(c) && isStr(c.from))) errors.push(`${at}.callers 必须是 { from } 组成的数组`)
    if (e.sdk !== undefined && !(isObj(e.sdk) && isStr(e.sdk.package))) errors.push(`${at}.sdk 必须有 package`)
    // 结论之间要对得上（不只是格式）
    const defs = Array.isArray(e.definitions) ? e.definitions : []
    const states = defs.map((d) => d?.state)
    if (defs.some((d) => isObj(d) && d.state !== undefined && !API_STATUSES.includes(d.state) && d.state !== 'internal')) errors.push(`${at}.definitions 里有不认识的 state`)
    if (['dead', 'dead-only-ref', 'test-only', 'pending', 'dormant', 'unknown'].includes(e.status)) {
      if (defs.length === 0) errors.push(`${at} 判为 ${e.status}，却没有任何定义位置`)
      if (states.includes('live')) errors.push(`${at} 判为 ${e.status}，定义里却有在用的`)
    }
    if (e.status === 'live' && !states.includes('live') && !(isObj(e.sdk) && Array.isArray(e.sdk.refs) && e.sdk.refs.length > 0) && !String(e.path).startsWith('//')) {
      errors.push(`${at} 判为在用，却没有在用的定义，也没有被引用的 SDK 功能`)
    }
    if (e.status === 'sdk' && !isObj(e.sdk)) errors.push(`${at} 判为 sdk，却没有 sdk 信息`)
    if (['dead', 'dead-only-ref'].includes(e.status) && r.historyTraced === true && !Object.prototype.hasOwnProperty.call(e, 'history')) {
      errors.push(`${at} 判为没人用、结果标明查过历史，却没有 history 字段（查不到也要写 null）`)
    }
    if (r.historyTraced !== true && e.history !== undefined && e.history !== null) errors.push(`${at} 有历史，但结果没有标明查过历史（historyTraced）`)
    const h = e.history
    if (h !== undefined && h !== null) {
      if (!isObj(h) || !['lost', 'never'].includes(h.type)) errors.push(`${at}.history.type 必须是 lost 或 never`)
      else if (h.type === 'lost' && (!isCommit(h.commit) || !isStr(h.from))) errors.push(`${at}.history（lost）必须有 commit（hash、date、author、subject）和 from`)
      else if (h.type === 'never' && !isCommit(h.introduced)) errors.push(`${at}.history（never）必须有 introduced（hash、date、author、subject）`)
      else if (h.commitFrom !== undefined && !isCommit(h.commitFrom)) errors.push(`${at}.history.commitFrom 格式不对`)
    }
  })
  return errors
}

/**
 * @param {object[]} results 每个项目一份 scanApi 的结果
 * @param {string[]} [names] 每份结果的来源（文件名），报错时用
 */
export function buildApiReport(results, names = []) {
  if (results.length === 0) throw new Error('至少要一份 api 结果')
  const problems = results.flatMap((r, i) => {
    const errs = validateApiResult(r)
    return errs.length > 0 ? [`${names[i] ?? `第 ${i + 1} 份结果`}：\n  - ${errs.slice(0, 20).join('\n  - ')}${errs.length > 20 ? `\n  - ……共 ${errs.length} 处` : ''}`] : []
  })
  if (problems.length > 0) throw new Error(`输入的结果格式不对，没有生成报告：\n${problems.join('\n')}`)
  const projects = results.map((r) => r.project.name)
  if (new Set(projects).size !== projects.length) throw new Error(`项目重复：${projects.join('、')}`)
  const gaps = new Map(results.map((r) => [r.project.name, coverageGaps(r)]))
  const merged = new Map()
  for (const r of results) {
    for (const ep of r.endpoints) {
      const m = merged.get(ep.key) ?? { key: ep.key, method: ep.method, path: ep.path, byProject: {} }
      m.byProject[r.project.name] = { ...ep, historyTraced: Boolean(r.historyTraced) }
      merged.set(ep.key, m)
    }
  }
  const rows = [...merged.values()].map((m) => judge(m, gaps))
  rows.sort((a, b) => VERDICTS.indexOf(a.verdict) - VERDICTS.indexOf(b.verdict) || a.path.localeCompare(b.path) || a.method.localeCompare(b.method))
  return { projects: results.map((r) => ({ name: r.project.name, rev: r.project.rev, rules: r.rules.version, historyTraced: Boolean(r.historyTraced), gaps: gaps.get(r.project.name) })), rows }
}

function coverageGaps(r) {
  const c = r.coverage ?? {}
  return ['suspects', 'dynamic', 'wrappers', 'unknownMethod', 'parseErrors'].reduce((n, k) => n + (c[k]?.length ?? 0), 0)
}

function judge(m, gaps) {
  const entries = Object.entries(m.byProject)
  const reasons = []
  let verdict
  const live = entries.filter(([, e]) => e.status === 'live')
  const sdk = entries.filter(([, e]) => e.status === 'sdk')
  const risky = entries.filter(([, e]) => RISKY.includes(e.status))
  if (live.length > 0) {
    verdict = '在用'
    reasons.push(`在用：${live.map(([p]) => p).join('、')}`)
  } else if (m.path.startsWith('//')) {
    // 完整网址：不是自家后端的接口，不管结果文件里写的是什么状态，都不能进可删 / 需审核
    verdict = 'C 高风险'
    reasons.push('写的是完整网址，多半是第三方服务，不是自家后端的接口，不在后端删除范围')
  } else if (sdk.length > 0) {
    verdict = 'C 保留'
    reasons.push(`SDK 内置（${sdk.map(([, e]) => e.sdk?.package).filter(Boolean)[0] ?? 'SDK'}），没有项目引用对应功能，但 SDK 要保持完整`)
  } else if (risky.length > 0) {
    verdict = 'C 高风险'
    for (const [p, e] of risky) reasons.push(`${p}：${e.status}（${e.evidence[0]?.detail ?? ''}）`)
  } else {
    const weak = []
    for (const [p, e] of entries) {
      if (e.status === 'test-only') weak.push(`${p}：只有测试在用`)
      if (!e.historyTraced) weak.push(`${p}：没有查历史（加 --history）`)
      else if (!e.history) weak.push(`${p}：历史没查到`)
      else if (e.history.weak) weak.push(`${p}：失去引用的提交只按名字匹配，没有确认 import 关系`)
    }
    // 没认出的调用可能调的就是它：报告里任何一个项目（不只是定义它的项目）的规则没补全，都不能判可删
    for (const [p, n] of gaps) if (n > 0) weak.push(`${p}：覆盖报告还有 ${n} 处没补的规则，可能有没认出的调用`)
    verdict = weak.length > 0 ? 'B 需审核' : 'A 可删'
    reasons.push(...weak)
    if (verdict === 'A 可删') reasons.push('每个定义它的项目都没人用，历史有明确证据')
  }
  return {
    verdict,
    key: m.key,
    method: m.method,
    path: m.path,
    statuses: Object.fromEntries(entries.map(([p, e]) => [p, e.status])),
    reasons,
    definitions: entries.flatMap(([p, e]) => e.definitions.map((d) => ({ project: p, file: d.file, line: d.line, fn: d.fn }))),
    callers: entries.flatMap(([p, e]) => (e.status === 'live' ? e.callers.map((c) => `${p}:${c.from}`) : [])),
    history: entries.map(([p, e]) => (DEAD.includes(e.status) && e.history ? { project: p, ...e.history } : null)).filter(Boolean)
  }
}

// ---------- 输出 ----------

const STATUS_TEXT = { live: '在用', dead: '没人用', 'dead-only-ref': '没人用（只被死代码引用）', 'test-only': '只有测试用', sdk: 'SDK 保留', pending: '其他分支在用', unknown: '无法判定', external: '构建配置等在用', dormant: '注释停用' }

function historyText(h) {
  if (!h) return ''
  if (h.type === 'never') return `从没被调用；定义于 ${h.introduced.date} ${h.introduced.hash.slice(0, 8)} ${h.introduced.author}：${h.introduced.subject}`
  const c = h.commitFrom ?? h.commit
  return `${c.date} ${c.hash.slice(0, 8)} ${c.author}：${c.subject}（${h.from}${h.via === 'dead-caller' ? ' 失去入口' : ' 删掉调用'}）`
}

/** CSV（UTF-8 带 BOM，Excel 直接打开不乱码） */
export function toCsv(report) {
  const names = report.projects.map((p) => p.name)
  const header = ['结论', '方法', '路径', ...names, '依据', '定义位置', '在用的引用方', '停用 / 定义提交', '后端处理意见']
  const esc = (v) => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [header.map(esc).join(',')]
  for (const r of report.rows) {
    lines.push([
      r.verdict,
      r.method,
      r.path,
      ...names.map((n) => (r.statuses[n] ? STATUS_TEXT[r.statuses[n]] ?? r.statuses[n] : '—')),
      r.reasons.join('；'),
      r.definitions.map((d) => `${d.project}:${d.file}:${d.line} ${d.fn}`).join('\n'),
      r.callers.slice(0, 10).join('\n') + (r.callers.length > 10 ? `\n…共 ${r.callers.length} 处` : ''),
      r.history.map((h) => `${h.project}：${historyText(h)}`).join('\n'),
      ''
    ].map(esc).join(','))
  }
  return `﻿${lines.join('\r\n')}\r\n`
}

export function toMarkdown(report, { now = new Date() } = {}) {
  const names = report.projects.map((p) => p.name)
  const count = (v) => report.rows.filter((r) => r.verdict === v).length
  const out = []
  out.push('# 接口排查报告', '')
  out.push(`生成时间：${now.toISOString().slice(0, 10)}　工具：code-audit api`, '')
  out.push('| 项目 | 提交 | 规则版本 | 查了历史 | 覆盖报告没补的规则 |', '| --- | --- | --- | --- | --- |')
  for (const p of report.projects) out.push(`| ${p.name} | ${p.rev.slice(0, 8)} | ${p.rules} | ${p.historyTraced ? '是' : '否'} | ${p.gaps} |`)
  out.push('', '## 结论汇总', '', '| 结论 | 接口数 | 含义 |', '| --- | --- | --- |')
  const meaning = {
    在用: '有项目在调用，不能删',
    'C 保留': 'SDK 内置的接口，SDK 要保持完整',
    'C 高风险': '看不准、别的分支在用、构建配置在用或注释停用，先不要动',
    'B 需审核': '都没人用，但证据不够硬，人工核对后再定',
    'A 可删': '前端都没人用，历史有明确证据；后端仍要结合网关日志确认，小批量删'
  }
  for (const v of VERDICTS) out.push(`| ${v} | ${count(v)} | ${meaning[v]} |`)
  out.push('', '> 前端只能看到前端代码里的调用。外部系统、脚本直接调用的接口看不到，后端删除前请结合网关 / 访问日志确认，并按小批量处理。', '')
  for (const v of VERDICTS.slice(1)) {
    const rows = report.rows.filter((r) => r.verdict === v)
    if (rows.length === 0) continue
    out.push(`## ${v}（${rows.length}）`, '')
    out.push(`| 方法 | 路径 | ${names.join(' | ')} | 依据 | 停用 / 定义提交 |`, `| --- | --- | ${names.map(() => '---').join(' | ')} | --- | --- |`)
    for (const r of rows) {
      out.push(`| ${r.method} | \`${r.path}\` | ${names.map((n) => (r.statuses[n] ? STATUS_TEXT[r.statuses[n]] ?? r.statuses[n] : '—')).join(' | ')} | ${cell(r.reasons.join('；'))} | ${cell(r.history.map((h) => `${h.project}：${historyText(h)}`).join('<br>'))} |`)
    }
    out.push('')
  }
  return `${out.join('\n')}\n`
}

function cell(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\n/g, '<br>')
}
