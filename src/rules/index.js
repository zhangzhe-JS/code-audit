/**
 * 规则层：给每个「从入口走不到」的候选判定状态
 *
 * 分两步：
 * 1. 逐个文件跑规则（动态加载、图外使用、其他分支在用、注释停用、只有测试用到），命中的给出状态、证据、引用
 * 2. 顺着候选之间的 import 传递（graph.js）：
 *    - 引用方要保留（比如是 external），被它引用的也要保留，状态跟引用方一样
 *    - 引用方全都没人用，判为 dead-only-ref：跟着引用方一起处理
 *
 * 一个文件有多个状态时，取 STATUSES 里排在最前面的（越不敢删的越优先）；证据和引用都留着。
 *
 * 什么都没命中、也没被候选引用的，才是 dead。dead 也写明原因：排除了哪些情况；
 * 落在人工确认过的动态加载范围里的，注明是哪一处、确认的理由。
 */
import { dynamicLoadRule } from './dynamic-load.js'
import { externalRule } from './external.js'
import { dormantRule } from './dormant.js'
import { testOnlyRule } from './test-only.js'
import { pendingRule } from './pending.js'
import { commentedTagRule, maybeAutoImportRule, maybeExternalRule, sameNameTagRule } from './blind-spots.js'
import { best, propagate } from './graph.js'
import { inScope } from '../collect/dynamic-imports.js'

/** 逐个文件跑的规则；顺序只影响证据的先后，状态按 STATUSES 取 */
const RULES = [
  dynamicLoadRule,
  sameNameTagRule,
  maybeAutoImportRule,
  maybeExternalRule,
  externalRule,
  pendingRule,
  dormantRule,
  commentedTagRule,
  testOnlyRule
]

/** dead 的证据：排除了哪些情况 */
export const NO_REF = Object.freeze({
  rule: 'no-ref',
  detail: '没有命中任何需要保留的情况（动态加载、构建配置等图外使用、没合并的分支、注释掉的引用、测试引用、同名标签等盲区兜底），也没有被其他候选引用'
})

/**
 * @typedef {object} RuleContext
 * @property {import('../collect/dynamic-imports.js').DynamicLoad[]} loads  动态加载
 * @property {Map<string, import('../collect/external-refs.js').ExternalRef[]>} externalRefs  knip 不分析的文件里写着候选路径的地方
 * @property {Map<string, import('../collect/comment-refs.js').CommentRef[]>} commentRefs  在用的文件里注释掉的引用
 * @property {Map<string, import('../collect/path-refs.js').ImportRef[]>} testRefs  测试文件里的 import
 * @property {Map<string, import('../collect/branch-refs.js').BranchRef[]>} branchRefs  没合并的分支里的引用
 * @property {Map<string, {from: string, line: number, tag: string}[]>} sameNameTags  兜底：在用的模板里的同名标签
 * @property {Map<string, {from: string, line: number, tag: string}[]>} commentedTags  兜底：模板注释里的同名标签
 * @property {Map<string, {from: string, line: number, name: string}[]>} bareExports  兜底：疑似自动导入
 * @property {Map<string, import('../collect/external-refs.js').ExternalRef[]>} externalMaybe  兜底：拼出来的路径
 * @property {Map<string, string>} knipRules  候选 → knip 证据的规则名
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
 * @param {RuleContext['loads']} [opts.loads]
 * @param {(import('../collect/dynamic-imports.js').DynamicLoad & {reason: string})[]} [opts.reviewedLoads] 人工确认过的动态加载
 * @param {RuleContext['externalRefs']} [opts.externalRefs]
 * @param {RuleContext['commentRefs']} [opts.commentRefs]
 * @param {RuleContext['testRefs']} [opts.testRefs]
 * @param {RuleContext['branchRefs']} [opts.branchRefs]
 * @param {{sameNameTags?: RuleContext['sameNameTags'], commentedTags?: RuleContext['commentedTags'], bareExports?: RuleContext['bareExports'], externalMaybe?: RuleContext['externalMaybe']}} [opts.blindSpots] 盲区兜底
 * @param {Map<string, import('../collect/path-refs.js').ImportRef[]>} [opts.importers]  候选 → 引用它的候选
 * @param {((file: string, ctx: RuleContext) => RuleHit | null)[]} [opts.rules] 测试时可以替换
 * @returns {{file: string, status: string, evidence: object[], refs: object[]}[]}
 */
export function judge({
  files,
  loads = [],
  reviewedLoads = [],
  externalRefs = new Map(),
  commentRefs = new Map(),
  testRefs = new Map(),
  branchRefs = new Map(),
  blindSpots = {},
  importers = new Map(),
  rules = RULES
}) {
  const ctx = {
    loads,
    externalRefs,
    commentRefs,
    testRefs,
    branchRefs,
    sameNameTags: blindSpots.sameNameTags ?? new Map(),
    commentedTags: blindSpots.commentedTags ?? new Map(),
    bareExports: blindSpots.bareExports ?? new Map(),
    externalMaybe: blindSpots.externalMaybe ?? new Map(),
    knipRules: new Map(files.map((f) => [f.file, f.evidence[0]?.rule])),
    candidates: new Set(files.map((f) => f.file))
  }

  // 1. 逐个文件跑规则
  const hits = new Map(files.map(({ file }) => [file, rules.map((rule) => rule(file, ctx)).filter(Boolean)]))
  const own = new Map([...hits].map(([file, hs]) => [file, best(hs.map((h) => h.status))]))

  // 2. 顺着候选之间的 import 传递
  const inherited = propagate({ own, importers })

  return files.map(({ file, evidence }) => {
    const hs = hits.get(file)
    const from = inherited.get(file)
    const status = best([own.get(file), from?.status])
    const result = {
      file,
      status,
      evidence: [...evidence, ...hs.flatMap((h) => h.evidence)],
      refs: hs.flatMap((h) => h.refs)
    }
    const candidateImporters = importers.get(file) ?? []

    if (status !== null) {
      // 状态是从引用方传过来的（比自己命中的更不敢删）：写明跟着谁
      if (from && from.status === status && own.get(file) !== status) {
        result.evidence.push({
          rule: 'inherited',
          detail: `被 ${from.from}:${from.line} 引用，而 ${from.from} 是 ${from.status}：要跟着它保留`
        })
      }
    } else if (candidateImporters.length > 0) {
      result.status = 'dead-only-ref'
      result.evidence.push({
        rule: 'dead-only-ref',
        detail: `只被同样从入口走不到的文件引用：${candidateImporters.map((r) => `${r.from}:${r.line}`).join('、')}`
      })
    } else {
      result.status = 'dead'
      result.evidence.push({ ...NO_REF })
    }
    // 判为可以删的：落在人工确认过的动态加载范围里的，注明是哪一处、为什么放过
    if (result.status === 'dead' || result.status === 'dead-only-ref') {
      for (const l of reviewedLoads.filter((x) => x.from !== file && inScope(file, x.scope))) {
        result.evidence.push({
          rule: 'reviewed-dynamic-load',
          detail: `在 ${l.from}:${l.line} 的 ${l.expr} 的范围里，已人工确认不加载本地源码：${l.reason}`
        })
      }
    }
    // 候选之间的引用也记下来：报告里能看出跟着谁处理
    result.refs.push(...candidateImporters.map((r) => ({ from: r.from, line: r.line, via: 'static' })))
    return result
  })
}
