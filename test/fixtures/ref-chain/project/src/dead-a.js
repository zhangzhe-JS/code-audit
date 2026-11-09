// 和 dead-b 互相引用，入口走不到
import { b } from './dead-b.js'
export const a = () => b
