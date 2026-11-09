/**
 * 批量查询 git 历史：读一份候选清单，逐个文件查历史，组装成符合 schema 的完整数据（Report）
 *
 * 候选清单可以人工写，也可以由 scan 生成。状态一律是 unknown：还没有经过规则判定，不替规则下结论
 * 证据：scan 生成的候选自带证据（如「从入口走不到」），原样保留；人工写的没有证据，写「人工列入候选」
 *
 * 任何一个文件查询失败，整批都失败并列出所有错误，不输出缺了几项的半成品
 */
import { resolveCommit } from './git.js'
import { traceHistory } from './index.js'
import { DEFAULT_CONFIG } from '../core/config.js'
import { SCHEMA_VERSION, TAGS, validate } from '../core/schema.js'
import { TOOL } from '../core/tool.js'

/** 人工列入的候选，在证据里统一写成这条 */
export const MANUAL_EVIDENCE = Object.freeze({
  rule: 'manual-candidate',
  detail: '人工列入候选，尚未经过规则判定'
})

/**
 * @typedef {object} Candidates 候选清单
 * @property {string} project      项目名，写进报告标题
 * @property {string} [rev]        候选清单是按哪个提交分析的（完整提交号，scan 会写）；history 默认查这个提交
 * @property {string[]} [entries]  项目入口，相对仓库根目录；只用于记录，不影响历史查询
 * @property {{file: string, pattern?: string, notes?: string[], evidence?: {rule: string, detail: string, tag?: string}[]}[]} files
 *           要查的文件，可以是空数组（scan 没找到候选时）；evidence 由 scan 填，人工写时不用写
 */

const TOP_KEYS = ['project', 'rev', 'entries', 'files']
const FILE_KEYS = ['file', 'pattern', 'notes', 'evidence']
const EVIDENCE_KEYS = ['rule', 'detail', 'tag']

/**
 * 校验候选清单，返回错误列表；空数组表示通过
 * 拼错的字段名也算错误：比如把 notes 写成 note，备注会被悄悄丢掉
 * @returns {string[]}
 */
export function validateCandidates(data) {
  if (!isPlainObject(data)) return ['候选清单必须是对象']

  const errors = []
  for (const key of Object.keys(data)) {
    if (!TOP_KEYS.includes(key)) errors.push(`不认识的字段：${key}（可用的字段：${TOP_KEYS.join('、')}）`)
  }
  if (!isNonEmptyString(data.project)) errors.push('project 必须是非空字符串（项目名）')
  if (data.rev !== undefined && !(typeof data.rev === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(data.rev))) {
    errors.push('rev 必须是完整提交号（40 或 64 位小写十六进制）')
  }
  if (data.entries !== undefined && !(Array.isArray(data.entries) && data.entries.every(isRelativePath))) {
    errors.push('entries 必须是相对路径组成的数组')
  }
  // 空数组合法：scan 没找到候选也是一种结果，照样能交给 history、report 走完流程
  if (!Array.isArray(data.files)) {
    errors.push('files 必须是数组')
    return errors
  }

  const seen = new Set()
  data.files.forEach((f, i) => {
    const at = `files[${i}]`
    if (!isPlainObject(f)) return errors.push(`${at} 必须是对象，如 { "file": "src/a.js" }`)
    for (const key of Object.keys(f)) {
      if (!FILE_KEYS.includes(key)) errors.push(`${at} 不认识的字段：${key}（可用的字段：${FILE_KEYS.join('、')}）`)
    }
    if (!isRelativePath(f.file)) {
      errors.push(`${at}.file 必须是相对仓库根目录的路径：${f.file}`)
    } else if (seen.has(f.file)) {
      errors.push(`${at}.file 重复：${f.file}`)
    } else {
      seen.add(f.file)
    }
    if (f.pattern !== undefined && !isNonEmptyString(f.pattern)) errors.push(`${at}.pattern 必须是非空字符串`)
    if (f.notes !== undefined && !(Array.isArray(f.notes) && f.notes.every(isNonEmptyString))) {
      errors.push(`${at}.notes 必须是非空字符串组成的数组`)
    }
    if (f.evidence !== undefined) {
      if (!Array.isArray(f.evidence) || f.evidence.length === 0) {
        errors.push(`${at}.evidence 必须是非空数组；没有证据时不要写这一项`)
      } else {
        f.evidence.forEach((ev, j) => {
          const eat = `${at}.evidence[${j}]`
          if (!isPlainObject(ev)) return errors.push(`${eat} 必须是对象，如 { "rule": "...", "detail": "..." }`)
          for (const key of Object.keys(ev)) {
            if (!EVIDENCE_KEYS.includes(key)) errors.push(`${eat} 不认识的字段：${key}（可用的字段：${EVIDENCE_KEYS.join('、')}）`)
          }
          if (!isNonEmptyString(ev.rule)) errors.push(`${eat}.rule 必须是非空字符串`)
          if (!isNonEmptyString(ev.detail)) errors.push(`${eat}.detail 必须是非空字符串`)
          if (ev.tag !== undefined && !TAGS.includes(ev.tag)) errors.push(`${eat}.tag 不合法：${ev.tag}`)
        })
      }
    }
  })
  return errors
}

/**
 * 按候选清单逐个查历史，组装成完整的 Report
 * @param {object} opts
 * @param {string} opts.root               仓库目录（绝对路径）
 * @param {Candidates} opts.candidates     已经通过 validateCandidates 的候选清单
 * @param {string} [opts.rev]              查到哪个提交为止；不传时用候选清单里的 rev，清单里也没有就用 HEAD
 * @param {Readonly<import('../core/config.js').Config>} [opts.config]
 * @param {Date} [opts.now]                生成时间，测试时可以固定
 * @returns {import('../core/schema.js').Report}
 */
export function buildReport({ root, candidates, rev, config = DEFAULT_CONFIG, now = new Date() }) {
  const listErrors = validateCandidates(candidates)
  if (listErrors.length > 0) throw new Error(`候选清单有误：\n- ${listErrors.join('\n- ')}`)

  // 先把 rev 换成完整提交号：报告里记录的是确切的提交，而不是 HEAD 这种会变的名字
  // 候选清单记了分析时的提交：历史也查这个提交，两边看到的是同一份代码
  const fullRev = resolveCommit(root, rev ?? candidates.rev ?? 'HEAD')
  if (candidates.rev !== undefined && fullRev !== candidates.rev) {
    throw new Error(
      `--rev ${rev} 是 ${fullRev}，和候选清单分析的提交 ${candidates.rev} 不一致：` +
        '两边看到的代码不同，结论会对不上。不传 --rev 即可按候选清单的提交查询；要查别的提交，请对那个提交重新 scan'
    )
  }

  const items = []
  const failures = []
  for (const c of candidates.files) {
    try {
      // 用完整提交号查：整批查询期间仓库有新提交，也不会前后不一致
      const { history } = traceHistory({ root, file: c.file, pattern: c.pattern, rev: fullRev, config })
      items.push({
        id: `file:${c.file}`,
        kind: 'file',
        target: c.file,
        status: 'unknown',
        evidence: c.evidence ? c.evidence.map((ev) => ({ ...ev })) : [{ ...MANUAL_EVIDENCE }],
        refs: [],
        history,
        verify: null,
        ...(c.notes ? { notes: [...c.notes] } : {})
      })
    } catch (e) {
      failures.push(`${c.file}：${e.message}`)
    }
  }
  if (failures.length > 0) {
    throw new Error(`有 ${failures.length} 个文件查询失败，没有生成结果：\n- ${failures.join('\n- ')}`)
  }

  // schema 约定 items 按 id 排序：两次结果可以直接 diff 对比
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))

  const report = {
    version: SCHEMA_VERSION,
    generatedAt: now.toISOString(),
    tool: { ...TOOL },
    project: {
      name: candidates.project,
      root,
      rev: fullRev,
      entries: [...(candidates.entries ?? [])]
    },
    items
  }

  // 自己生成的数据也要校验：有问题说明是工具的 bug，宁可报错也不输出
  const errors = validate(report)
  if (errors.length > 0) throw new Error(`生成的数据不符合格式（工具内部错误）：\n- ${errors.join('\n- ')}`)
  return report
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== ''
}

/** 和 schema 的规则一致：相对路径，用 / 分隔，不含 .. 这一级 */
function isRelativePath(v) {
  return (
    isNonEmptyString(v) &&
    !v.startsWith('/') &&
    !/^[A-Za-z]:[\\/]/.test(v) &&
    !v.includes('\\') &&
    !v.split('/').includes('..')
  )
}
