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
 * 校验一份数据是否符合格式
 * @returns {string[]} 错误列表；空数组表示通过
 */
export function validate(data) {
  const errors = []
  if (!isObject(data)) return ['根节点必须是对象']
  if (data.version !== SCHEMA_VERSION) {
    errors.push(`version 必须是 ${SCHEMA_VERSION}，实际是 ${data.version}`)
  }
  if (!isObject(data.project)) {
    errors.push('缺少 project')
  } else if (typeof data.project.root !== 'string') {
    errors.push('project.root 必须是字符串')
  }
  if (!Array.isArray(data.items)) {
    errors.push('items 必须是数组')
    return errors
  }
  const seen = new Set()
  data.items.forEach((item, i) => {
    const at = `items[${i}]`
    if (!isObject(item)) {
      errors.push(`${at} 必须是对象`)
      return
    }
    if (!KINDS.includes(item.kind)) errors.push(`${at}.kind 不合法：${item.kind}`)
    if (!STATUSES.includes(item.status)) errors.push(`${at}.status 不合法：${item.status}`)
    if (typeof item.target !== 'string' || item.target === '') errors.push(`${at}.target 不能为空`)

    if (!Array.isArray(item.evidence) || item.evidence.length === 0) {
      errors.push(`${at}.evidence 至少要有一条证据`)
    } else {
      item.evidence.forEach((ev, j) => {
        if (ev.tag !== undefined && !TAGS.includes(ev.tag)) {
          errors.push(`${at}.evidence[${j}].tag 不合法：${ev.tag}`)
        }
      })
    }
    if (seen.has(item.id)) errors.push(`${at}.id 重复：${item.id}`)
    seen.add(item.id)
  })
  return errors
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