/**
 * 项目配置示例
 *
 * 用法：复制成 profiles/<项目名>.js，按项目修改，然后在命令里传 --profile profiles/<项目名>.js
 * profiles/ 下只有这个示例文件入库，真实项目的配置只留在本机
 *
 * 只需要写和默认值不同的项，没写的项使用默认值（见 src/core/config.js）
 */
import { DEFAULT_CONFIG } from '../src/core/config.js'

export default {
  // 源码根目录：项目里 @/ 等别名指向的目录。推 pattern 时会去掉这一段
  // 例：Nuxt 项目可能是 ['app']，monorepo 可能是 ['packages/web/src', 'packages/admin/src']
  sourceRoots: ['src'],

  // 只在这些扩展名的文件里找引用方；在默认列表基础上补充时，用展开写法
  extensions: [...DEFAULT_CONFIG.extensions, '.astro', '.mdx'],

  // 报告里提交号显示几位（4～40）
  shortHashLength: 8,

  // 头注释的标题和结尾提示。默认只写「这是排查记录」，不包含任何流程要求
  // 项目有隔离流程的话，在这里写上自己的约定，比如：
  headerTitle: '[DEPRECATED] 已隔离：观察期后删除',
  headerFooter: ['业务代码禁止 import 本文件；需要恢复时请移回原路径，并更新 src/_deprecated/README.md'],

  // 各扩展名的注释格式（block：/** *\/，html：<!-- -->），只需要写要补充或修改的
  headerStyles: { '.astro': 'html' },

  // 状态的显示文案，只需要写要改的；状态 ID 本身不能改
  statusLabels: { dead: '无引用，可以删除' }
}
