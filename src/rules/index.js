/**
 * 规则层：给每个「从入口走不到」的候选判定状态
 *
 * 每条规则看一个文件，命中时给出状态、证据和引用。一个文件可能命中好几条，
 * 取 STATUSES 里排在最前面的状态（越不敢删的越优先）；所有命中的证据和引用都留着，报告里一并列出。
 *
 * 规则还没做完：一条都没命中的文件暂时也是 unknown，并写一条证据说明原因。
 * 等 external、dormant、dead-only-ref 等规则都做完，没命中的才落到 dead。
 */
import { STATUSES } from '../core/schema.js'
import { dynamicLoadRule } from './dynamic-load.js'
import { externalRule } from './external.js'

/** 按优先级从高到低排列；顺序不影响结果（结果按 STATUSES 取），只影响证据的先后 */
const RULES = [dynamicLoadRule, externalRule]

/** 一条规则都没命中时的结论。规则做完以后改成 dead */
export const NOT_JUDGED = Object.freeze({
  status: 'unknown',
  evidence: Object.freeze({
    rule: 'rules-incomplete',
    detail: '规则层还没做完（注释停用、只被死代码引用等尚未判定），暂不下结论'
  })
})

/**
 * @typedef {object} RuleContext
 * @property {import('../collect/dynamic-imports.js').DynamicLoad[]} loads  有范围的动态加载
 * @property {Map<string, import('../collect/external-refs.js').ExternalRef[]>} externalRefs  knip 不分析的文件里写着候选路径的地方
 * @property {Set<string>} candidates  所有候选文件
 */

/**
 * @typedef {object} RuleHit 一条规则的命中结果
 * @property {string} status
 * @property {{rule: string, detail: string, tag?: string}[]} evidence
 * @property {{from: string, line: number, via: string}[]} refs
 */

/**
 * @param {object} opts
 * @param {{file: string, evidence: object[]}[]} opts.files  scan 得出的候选，evidence 是 knip 的结论
 * @param {RuleContext['loads']} opts.loads
 * @param {RuleContext['externalRefs']} [opts.externalRefs]
 * @param {((file: string, ctx: RuleContext) => RuleHit | null)[]} [opts.rules] 测试时可以替换
 * @returns {{file: string, status: string, evidence: object[], refs: object[]}[]}
 */
export function judge({ files, loads, externalRefs = new Map(), rules = RULES }) {
  const ctx = { loads, externalRefs, candidates: new Set(files.map((f) => f.file)) }
  return files.map(({ file, evidence }) => {
    const hits = rules.map((rule) => rule(file, ctx)).filter(Boolean)
    if (hits.length === 0) {
      return { file, status: NOT_JUDGED.status, evidence: [...evidence, { ...NOT_JUDGED.evidence }], refs: [] }
    }
    const status = hits.map((h) => h.status).sort((a, b) => STATUSES.indexOf(a) - STATUSES.indexOf(b))[0]
    return {
      file,
      status,
      evidence: [...evidence, ...hits.flatMap((h) => h.evidence)],
      refs: hits.flatMap((h) => h.refs)
    }
  })
}
