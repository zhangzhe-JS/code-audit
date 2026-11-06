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
  shortHashLength: 8
}
