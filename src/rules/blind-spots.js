/**
 * 盲区兜底：静态分析看不准、但又不能排除「在用」的情况，不判死
 *
 * - same-name-tag     在用的模板里有和这个组件同名的标签，又不是那个文件 import 进来的
 *                     （全局注册但没有声明文件、手写注册、别处同名组件）→ unknown
 * - commented-tag     在用的模板的 HTML 注释里有同名标签 → dormant（注释停用）
 * - maybe-auto-import 项目装了自动导入的插件却没有声明文件，在用的代码直接用了它导出的名字、没有 import → unknown
 * - maybe-external    knip 不分析的文件里出现了它的文件名，但路径是拼出来的、算不出来 → unknown
 *
 * 每条证据都写明看到了什么、为什么不能确认；人工看过以后可以按证据处理
 */

/** @returns {import('./index.js').RuleHit | null} */
export function sameNameTagRule(file, { sameNameTags }) {
  const refs = sameNameTags.get(file)
  if (!refs) return null
  return {
    status: 'unknown',
    evidence: refs.map((r) => ({
      rule: 'same-name-tag',
      detail: `${r.from}:${r.line} 的模板里有 ${r.tag}，和这个文件同名，又不是那个文件 import 进来的：可能是全局注册、或别处注册的同名组件，无法确认`
    })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'dynamic' }))
  }
}

/** @returns {import('./index.js').RuleHit | null} */
export function commentedTagRule(file, { commentedTags }) {
  const refs = commentedTags.get(file)
  if (!refs) return null
  return {
    status: 'dormant',
    evidence: refs.map((r) => ({ rule: 'commented-tag', detail: `${r.from}:${r.line} 的模板注释里有同名标签 ${r.tag}（可能是注释停用的组件）` })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'comment' }))
  }
}

/** @returns {import('./index.js').RuleHit | null} */
export function maybeAutoImportRule(file, { bareExports }) {
  const refs = bareExports.get(file)
  if (!refs) return null
  return {
    status: 'unknown',
    evidence: refs.map((r) => ({
      rule: 'maybe-auto-import',
      detail: `项目装了自动导入的插件，但没有声明文件；${r.from}:${r.line} 直接用了它导出的 ${r.name}，没有 import：可能是自动导入，无法确认`
    })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'dynamic' }))
  }
}

/** @returns {import('./index.js').RuleHit | null} */
export function maybeExternalRule(file, { externalMaybe }) {
  const refs = externalMaybe.get(file)
  if (!refs) return null
  return {
    status: 'unknown',
    evidence: refs.map((r) => ({
      rule: 'maybe-external',
      detail: `${r.from}:${r.line} 出现了同名文件名：${r.text}（knip 不分析这个文件，路径可能是拼出来的），无法确认`
    })),
    refs: refs.map((r) => ({ from: r.from, line: r.line, via: 'config' }))
  }
}
