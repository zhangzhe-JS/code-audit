// 3 个导出，外部只引用了 usedOutside

// 外部没人 import，但被 usedOutside 调用 → internal
export function calledInside() {}

// 被 main.js 引用 → live
export function usedOutside() {
  calledInside()
}

// 外部没人用，文件内也没人调用 → dead
export function unusedExport() {}