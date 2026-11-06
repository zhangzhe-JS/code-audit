/**
 * 数据格式：所有命令之间传递的 JSON 结构与校验
 *
 * scan 建清单 → history 补历史 → verify 补验证结果 → report 只读不判断
 * 各命令读写同一份 JSON，只填写自己负责的字段
 */

/**
 * 数据格式的版本号
 * 格式有不兼容的改动（如新增必填字段）时加 1，读到旧版本文件时提示重新运行 scan
 */
export const SCHEMA_VERSION = 1

/**
 * 排查对象的类型，对应三个排查维度（执行顺序：先文件，再导出，最后接口）
 * - file   整个文件。删错会导致构建报错，马上能发现
 * - export 文件里导出的某个名字。删错只有构建警告，运行时拿到 undefined
 * - api    一个后端接口（方法 + 路径）。前端无感知，要看后端访问日志
 */
export const KINDS = ['file', 'export', 'api']

/**
 * 排查结论：9 种状态
 *
 * 数组顺序就是优先级：同时满足多种情况时，取排在最前面的那个。
 * 原则是「越不敢删的越优先」，只有排除了前面所有情况，才会落到 dead。
 *
 * 前 5 种的共同点：只看入口的 import 关系像是没人用，但不能动
 * - unknown       无法判定：存在拼接路径的动态 import、window[name] 等写法
 *                 工具宁可承认不知道，也不猜测为 dead
 * - external      在 import 图之外被使用：构建配置、index.html、public、其他项目
 *                 （例：vite-config/resolve.js 里作为别名替换的 fpv-excel-engine-stub.js）
 * - pending       其他分支在用：当前分支没人用，但未合并的分支引用了它
 *                 等那个分支合并或关闭后再判断
 * - dormant       注释停用：引用被注释掉，以后可能恢复
 *                 必须留在原位，不能隔离（例：browser-check.js）
 * - internal      本文件内部在用：外部没人 import，但被文件内在用的函数调用
 *                 不能删，最多去掉 export（例：base64ToBlob）
 *
 * 后 4 种：
 * - live          在用：从入口顺着 import 能找到
 * - test-only     只有单测引用：确认业务是否还需要，要删就连同测试一起删
 * - dead-only-ref 只被死代码引用：引用方本身不可达，跟着引用方一起处理
 *                 （互相引用、但入口走不到的一组文件也属于这种）
 * - dead          死代码：引用已删除，或从未被引用。隔离 → 观察 → 删除
 */
export const STATUSES = [
  'unknown',
  'external',
  'pending',
  'dormant',
  'internal',
  'live',
  'test-only',
  'dead-only-ref',
  'dead'
]

/**
 * 补充说明的标签：写在 evidence 里，不影响状态
 *
 * 判断标准：处理方式和某种已有状态一样，就不新增状态，只加标签说明原因
 * - side-effect    只为副作用引入，不使用任何导出（如注册全局指令、polyfill）
 * - global-mount   通过全局挂载使用（如 Vue.prototype.$log），模板里用 $xxx 访问
 * - dev-only       只在开发环境或 mock 中使用
 * - type-only      只用作 TS 类型（import type），构建后不存在
 * - replaced-by    已被新实现替代（如 pdfjsLib.js 包装层被直接 import pdfjs-dist 取代）
 * - business-check 代码能访问到，但业务入口可能已关闭（路由还在、菜单隐藏），需人工确认
 */
export const TAGS = [
  'side-effect',
  'global-mount',
  'dev-only',
  'type-only',
  'replaced-by',
  'business-check'
]

/**
 * 引用方式（refs[].via），不同方式对应不同状态
 * - static   import x from '...'         → live
 * - reexport export * from '...'         → live
 * - glob     import.meta.glob(...)       → live
 * - dynamic  拼接路径的 import()           → unknown
 * - comment  被注释掉的 import            → dormant
 * - config   构建配置里的别名等             → external
 */
export const VIAS = ['static', 'reexport', 'glob', 'dynamic', 'comment', 'config']


/**报告数据的接口说明书 */

/**
 * @typedef {object} Report 整份数据
 * @property {number} version
 * @property {string} generatedAt  ISO 时间，如 2026-11-05T08:00:00.000Z
 * @property {{name: string, version: string}} tool
 * @property {Project} project
 * @property {Item[]} items  按 id 排序
 */

/**
 * @typedef {object} Project
 * @property {string} name
 * @property {string} root     绝对路径（整份数据里唯一的绝对路径）
 * @property {string} rev      分析时的完整提交号
 * @property {string[]} entries 入口文件，相对 root
 */

/**
 * @typedef {object} Item 一个排查对象
 * @property {string} id   file:路径 / export:路径#名字 / api:方法 路径
 * @property {'file'|'export'|'api'} kind
 * @property {string} target  文件路径（相对 root），或「方法 + 路径」
 * @property {string} [name]  kind 为 export 时的导出名
 * @property {string} status  STATUSES 之一          （scan 填）
 * @property {Evidence[]} evidence 至少一条          （scan 填）
 * @property {Ref[]} refs     所有引用，可以为空      （scan 填）
 * @property {History|null} history  null = 还没跑 history
 * @property {Verify|null} verify    null = 还没跑 verify
 */

/**
 * @typedef {object} Evidence 一条证据
 * @property {string} rule    哪条规则得出的，如 no-import
 * @property {string} detail  人能看懂的说明
 * @property {string} [tag]   TAGS 之一
 */

/**
 * @typedef {object} Ref 一处引用
 * @property {string} from  引用方文件，相对 root
 * @property {number} line
 * @property {'static'|'reexport'|'glob'|'dynamic'|'comment'|'config'} via  VIAS 之一
 */

/**
 * @typedef {object} Commit
 * @property {string} hash  完整提交号；报告里再截短显示
 * @property {string} date  YYYY-MM-DD，按主线（first-parent）的日期
 * @property {string} author
 * @property {string} subject
 */

/**
 * @typedef {object} History
 * @property {Commit} introduced
 * @property {Commit|null} lostRef  null = 从来没被引用过
 * @property {{commit: Commit, change: 'add'|'remove', from: string}[]} timeline
 */

/**
 * @typedef {object} Verify
 * @property {string} rev
 * @property {{ok: boolean, newWarnings: string[]}} build
 * @property {{newFailures: string[]}} test
 * @property {boolean} passed  删掉以后和基线一致
 */




/**
 * 校验一份数据是否符合上面的类型定义
 * 任何输入都只返回错误列表，不会抛异常
 * @param {Report} data
 * @returns {string[]} 错误列表；空数组表示通过
 */
export function validate(data) {
  const errors = []
  const err = (msg) => errors.push(msg)

  if (!isObject(data)) return ['根节点必须是对象']

  if (data.version !== SCHEMA_VERSION) err(`version 必须是 ${SCHEMA_VERSION}，实际是 ${data.version}`)
  if (!isNonEmptyString(data.generatedAt)) err('generatedAt 必须是非空字符串')

  if (!isObject(data.tool)) {
    err('缺少 tool')
  } else {
    if (!isNonEmptyString(data.tool.name)) err('tool.name 必须是非空字符串')
    if (!isNonEmptyString(data.tool.version)) err('tool.version 必须是非空字符串')
  }

  if (!isObject(data.project)) {
    err('缺少 project')
  } else {
    const p = data.project
    if (!isNonEmptyString(p.name)) err('project.name 必须是非空字符串')
    if (!isNonEmptyString(p.root) || !isAbsolute(p.root)) err('project.root 必须是绝对路径')
    if (!isHash(p.rev)) err(`project.rev 必须是完整提交号：${p.rev}`)
    if (!Array.isArray(p.entries)) {
      err('project.entries 必须是数组')
    } else {
      p.entries.forEach((e, i) => {
        if (!isRelativePath(e)) err(`project.entries[${i}] 必须是相对路径：${e}`)
      })
    }
  }

  if (!Array.isArray(data.items)) {
    err('items 必须是数组')
    return errors
  }

  const seen = new Set()
  let prevId = null
  data.items.forEach((item, i) => {
    const at = `items[${i}]`
    if (!isObject(item)) {
      err(`${at} 必须是对象`)
      return
    }

    validateItem(item, at, err)

    if (typeof item.id === 'string') {
      if (seen.has(item.id)) err(`${at}.id 重复：${item.id}`)
      if (prevId !== null && item.id < prevId) err(`${at} 没有按 id 排序：${item.id} 排在 ${prevId} 后面`)
      seen.add(item.id)
      prevId = item.id
    }
  })

  return errors
}

/** 校验单个排查对象 */
function validateItem(item, at, err) {
  if (!isNonEmptyString(item.id)) err(`${at}.id 必须是非空字符串`)
  if (!KINDS.includes(item.kind)) err(`${at}.kind 不合法：${item.kind}`)
  if (!STATUSES.includes(item.status)) err(`${at}.status 不合法：${item.status}`)
  if (!isNonEmptyString(item.target)) err(`${at}.target 不能为空`)

  // kind、target、name、id 四者必须一致
  if (item.kind === 'export') {
    if (!isNonEmptyString(item.name)) err(`${at}.name：kind 为 export 时必须有导出名`)
  } else if (item.name !== undefined) {
    err(`${at}.name：只有 kind 为 export 时才能有 name`)
  }
  if (isNonEmptyString(item.target)) {
    if (item.kind === 'api') {
      if (!/^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS) \S+$/.test(item.target)) {
        err(`${at}.target：api 的格式应为「方法 路径」，如 GET /api/user：${item.target}`)
      }
    } else if (KINDS.includes(item.kind) && !isRelativePath(item.target)) {
      err(`${at}.target 必须是相对路径：${item.target}`)
    }
  }
  const expectedId = buildId(item)
  if (expectedId && isNonEmptyString(item.id) && item.id !== expectedId) {
    err(`${at}.id 与 kind / target / name 不一致：应为 ${expectedId}，实际是 ${item.id}`)
  }

  if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
    err(`${at}.evidence 至少要有一条证据`)
  } else {
    item.evidence.forEach((ev, j) => validateEvidence(ev, `${at}.evidence[${j}]`, err))
  }

  if (!Array.isArray(item.refs)) {
    err(`${at}.refs 必须是数组`)
  } else {
    item.refs.forEach((ref, j) => validateRef(ref, `${at}.refs[${j}]`, err))
  }

  if (item.history !== null) validateHistory(item.history, `${at}.history`, err)
  if (item.verify !== null) validateVerify(item.verify, `${at}.verify`, err)
}

/** 按 kind 拼出 id；kind 不合法或缺字段时返回 null */
function buildId(item) {
  if (!isNonEmptyString(item.target)) return null
  if (item.kind === 'file') return `file:${item.target}`
  if (item.kind === 'api') return `api:${item.target}`
  if (item.kind === 'export' && isNonEmptyString(item.name)) return `export:${item.target}#${item.name}`
  return null
}

function validateEvidence(ev, at, err) {
  if (!isObject(ev)) return err(`${at} 必须是对象`)
  if (!isNonEmptyString(ev.rule)) err(`${at}.rule 必须是非空字符串`)
  if (!isNonEmptyString(ev.detail)) err(`${at}.detail 必须是非空字符串`)
  if (ev.tag !== undefined && !TAGS.includes(ev.tag)) err(`${at}.tag 不合法：${ev.tag}`)
}

function validateRef(ref, at, err) {
  if (!isObject(ref)) return err(`${at} 必须是对象`)
  if (!isRelativePath(ref.from)) err(`${at}.from 必须是相对路径：${ref.from}`)
  if (!Number.isInteger(ref.line) || ref.line < 1) err(`${at}.line 必须是正整数：${ref.line}`)
  if (!VIAS.includes(ref.via)) err(`${at}.via 不合法：${ref.via}`)
}

function validateCommit(c, at, err) {
  if (!isObject(c)) return err(`${at} 必须是提交对象`)
  if (!isHash(c.hash)) err(`${at}.hash 必须是完整提交号：${c.hash}`)
  if (typeof c.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(c.date)) err(`${at}.date 格式应为 YYYY-MM-DD：${c.date}`)
  if (!isNonEmptyString(c.author)) err(`${at}.author 必须是非空字符串`)
  if (typeof c.subject !== 'string') err(`${at}.subject 必须是字符串`)
}

function validateHistory(h, at, err) {
  if (!isObject(h)) return err(`${at} 必须是对象或 null`)
  validateCommit(h.introduced, `${at}.introduced`, err)
  if (h.lostRef !== null) validateCommit(h.lostRef, `${at}.lostRef`, err)
  if (!Array.isArray(h.timeline)) return err(`${at}.timeline 必须是数组`)
  h.timeline.forEach((e, k) => {
    const eat = `${at}.timeline[${k}]`
    if (!isObject(e)) return err(`${eat} 必须是对象`)
    validateCommit(e.commit, `${eat}.commit`, err)
    if (e.change !== 'add' && e.change !== 'remove') err(`${eat}.change 必须是 add 或 remove：${e.change}`)
    if (!isRelativePath(e.from)) err(`${eat}.from 必须是相对路径：${e.from}`)
  })
}

function validateVerify(v, at, err) {
  if (!isObject(v)) return err(`${at} 必须是对象或 null`)
  if (!isHash(v.rev)) err(`${at}.rev 必须是完整提交号：${v.rev}`)
  if (!isObject(v.build) || typeof v.build.ok !== 'boolean' || !isStringArray(v.build.newWarnings)) {
    err(`${at}.build 应为 { ok: boolean, newWarnings: string[] }`)
  }
  if (!isObject(v.test) || !isStringArray(v.test.newFailures)) {
    err(`${at}.test 应为 { newFailures: string[] }`)
  }
  if (typeof v.passed !== 'boolean') err(`${at}.passed 必须是布尔值`)
}


/**
 * 多种情况同时满足时，按优先级选一个
 * 例：pickStatus(['dead', 'pending']) → 'pending'
 * 一个候选都没有时返回 unknown：没有证据就不下结论
 *  如果要调整优先级，只需要调整 STATUSES 数组里的顺序
 */
export function pickStatus(candidates) {
  for (const s of STATUSES) {
    if (candidates.includes(s)) return s
  }
  return 'unknown'
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v !== ''
}

function isStringArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === 'string')
}

/** 完整提交号：SHA-1 为 40 位，SHA-256 仓库为 64 位 */
function isHash(v) {
  return typeof v === 'string' && /^([0-9a-f]{40}|[0-9a-f]{64})$/.test(v)
}

/** 绝对路径：/ 开头，或 Windows 的盘符开头 */
function isAbsolute(v) {
  return v.startsWith('/') || /^[A-Za-z]:[\\/]/.test(v)
}

/** 相对路径：非空、不是绝对路径、统一用 / 分隔 */
function isRelativePath(v) {
  return isNonEmptyString(v) && !isAbsolute(v) && !v.includes('\\')
}