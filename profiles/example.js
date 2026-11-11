/**
 * 项目配置示例
 *
 * 用法：复制成 profiles/<项目名>.js，按项目修改，然后在命令里传 --profile profiles/<项目名>.js
 * profiles/ 下只有这个示例文件入库，真实项目的配置只留在本机
 *
 * 只需要写和默认值不同的项，没写的项使用默认值（见 src/core/config.js）
 */
export default {
  // 源码根目录：项目里 @/ 等别名指向的目录。推 pattern 时会去掉这一段
  // 例：Nuxt 项目可能是 ['app']，monorepo 可能是 ['packages/web/src', 'packages/admin/src']
  sourceRoots: ['src'],

  // 源码文件的扩展名。写了就整个替换默认值（默认 .js .mjs .cjs .jsx .ts .mts .cts .tsx .vue .svelte），要补充时把默认的也写上
  extensions: ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.mts', '.cts', '.tsx', '.vue', '.svelte', '.astro'],

  // 报告里提交号显示几位（4～40）
  shortHashLength: 8,

  // 头注释的标题和结尾提示。默认只写「这是排查记录」，不包含任何流程要求
  // 项目有隔离流程的话，在这里写上自己的约定，比如：
  headerTitle: '[DEPRECATED] 已隔离：观察期后删除',
  headerFooter: ['业务代码禁止 import 本文件；需要恢复时请移回原路径，并更新 src/_deprecated/README.md'],

  // 各扩展名的注释格式（block：/** *\/，html：<!-- -->），只需要写要补充或修改的
  headerStyles: { '.astro': 'html' },

  // 状态的显示文案，只需要写要改的；状态 ID 本身不能改
  statusLabels: { dead: '无引用，可以删除' },

  // ---------- scan 用 ----------

  // 项目入口（必填，没有默认值：猜错会把在用的文件当成没人用）。可以写 glob
  entries: ['src/main.js'],

  // 测试入口：写了就能区分「只有测试用到」的文件；匹配到的测试文件本身不列为候选
  testEntries: ['src/**/*.test.js', 'tests/**/*.spec.ts'],

  // 路径别名 → 目录，照抄构建配置里的 resolve.alias（没有默认值：@ 指向哪里各项目不同）
  aliases: { '@': 'src', '~': 'src' },

  // 不列为候选的文件，比如测试用的 mock、只在构建时用的脚本
  scanIgnore: ['src/mock/**', 'src/tests/**'],

  // 人工确认过、不会加载本地源码的动态加载（路径开头就是变量时，scan 会把范围内的候选都判 unknown）
  // from、expr 照抄 scan 输出里的警告；reason 必填，会写进报告
  reviewedDynamicLoads: [
    { from: 'src/utils/loader.js', expr: 'import(url)', reason: '加载的是 CDN 上的脚本' },
    { from: 'src/layout/Sidebar.vue', expr: '*', reason: '这个文件里的 :is 都是图标组件' } // * 表示这个文件里的所有动态加载
  ],

  // 判断「其他分支在用」时查哪些没合并的分支。默认都查；不会再合回来的老版本线可以排除
  branches: { ignore: ['origin/release/**'], maxAgeDays: 180 },

  // verify 在临时目录里跑的命令（没有默认值），必须能无人值守跑完
  // bundler 可选：基线构建时记下打包器加载过的模块，加载过的候选不删（判 unknown）；可选 vite、webpack、vue-cli
  // 配置文件不在默认位置（vite.config.*）时加 bundlerConfig: 'web/vite.config.ts'
  verify: { build: 'npm run build', test: 'npm test', timeoutSeconds: 1800, bundler: 'vite' },

  // ---------- 菜单归属（api 报告的「使用菜单」）用 ----------
  // 具体菜单只写路由对应的页面入口文件（不写整个目录：放在 A 菜单目录下的共享组件可能是 B 菜单在用）；
  // global: true 的（布局、入口、启动配置）碰到就停、不再往上，只在找不到具体菜单时单独出现。可以让模型读路由和权限树生成，人审核
  menus: [
    { name: '订单管理', files: ['src/views/order/index.vue', 'src/views/order/detail.vue'] },
    { name: '用户管理', files: ['src/views/user/index.vue'] },
    { name: '全局 · 登录鉴权', global: true, files: ['src/views/login/**'] },
    { name: '全局 · 框架加载', global: true, files: ['src/main.js', 'src/App.vue', 'src/layout/**', 'src/router/**'] }
  ],

  // ---------- api（接口维度）用 ----------
  // 请求是怎么发出去的。照着代码写，参数换成占位：url 地址、method 方法、_ 任意参数、... 后面还有参数、* 取 HTTP 方法名
  // 没有默认值：各项目的请求封装不同。可以让模型读请求封装和几份 api 文件后生成，人审核；跑 code-audit api 看覆盖报告，按它补到清零
  api: {
    version: 1, // 改了规则就加 1
    calls: [
      { call: 'request({url, method})', defaultMethod: 'GET' },
      { call: 'http.*(url, ...)' },
      { call: 'upload(url, ...)', method: 'POST' }
    ],
    attrs: [{ tag: 'el-upload', attr: 'action', method: 'POST' }], // 模板里写地址的属性（按项目用的组件库写）
    consts: [{ name: 'UPLOAD_URL', method: 'POST' }], // 写着接口地址的顶层常量
    prefixes: ['/api'], // 去掉的网关前缀
    ignoreCalls: ['showToast'], // 参数像路径、但不是请求的调用
    manual: [{ from: 'src/utils/sse.js', fn: 'openStream', method: 'POST', path: '/stream/chat', reason: '地址在别的函数里拼好再传进来' }],
    reviewedDynamic: [{ from: 'src/utils/image.js', fn: 'loadImage', reason: '地址是后端返回的图片链接' }],
    sdk: [{ method: 'POST', path: '/login', package: '@your/auth-sdk', via: ['createAuth'], note: 'SDK 内部发的登录请求' }],
    examples: [{ raw: '/order/list?page=1', expect: 'GET /order/list' }] // 规则自带的测试，每次扫描先跑
  }
}
