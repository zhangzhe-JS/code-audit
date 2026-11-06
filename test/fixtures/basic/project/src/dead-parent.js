// 没有任何文件引用，但它引用了 dead-child → dead
import { child } from './dead-child.js'

export function parent() {
  child()
}
