/** scan 写进候选证据的规则名（knip 的结论）。单独放一个文件：规则层也要用，避免和 scan.js 循环引用 */
export const SCAN_RULES = Object.freeze({
  unreachable: 'knip-unreachable',
  testOnly: 'knip-test-only'
})
