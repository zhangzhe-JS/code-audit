// 页面：按名字加载，路径里有变量
export const page = (name) => import(`./views/${name}.vue`)

// 语言包：用 + 拼接
export const locale = (lang) => import('./locale/' + lang + '.js')

// 只加载 modules 这一层的 .js
export const modules = require.context('./modules', false, /\.js$/)

// 确定不了目录：已人工确认（见 expected.json 的 config），不圈文件
export const any = (p) => import(p)
