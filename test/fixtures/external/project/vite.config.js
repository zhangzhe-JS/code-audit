import path from 'node:path'

export default {
  resolve: {
    alias: {
      // 构建时把某个包替换成 stub：只在这里用到
      heavy: path.resolve(__dirname, 'src/shims/stub.js')
      // old: path.resolve(__dirname, 'src/commented.js')
    }
  },
  // 名字相近的另一个文件，不是 src/similar.js
  define: { file: 'src/similar.config.js' }
}
