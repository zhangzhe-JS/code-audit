// 路径的开头就是变量：确定不了目录，只能按结尾 .vue 圈
export const open = (name) => import(name + '.vue')
