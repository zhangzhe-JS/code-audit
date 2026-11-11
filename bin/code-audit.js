#!/usr/bin/env node


/**
 * desc  --help 显示用的说明。
 * load  命令加载路径
**/
const commands = {
    scan: { desc: '采集 + 判定，输出候选清单 JSON', load: () => import('../src/commands/scan.js') },
    history: { desc: '补充 git 历史：引入、失去引用', load: () => import('../src/commands/history.js') },
    verify: { desc: '在临时目录里实删候选，和构建 / 测试的基线比较', load: () => import('../src/commands/verify.js') },
    report: { desc: '从 JSON 生成报告', load: () => import('../src/commands/report.js') },
    quarantine: { desc: '隔离：移进 _deprecated，加头注释（--apply 只改工作区，不提交）', load: () => import('../src/commands/quarantine.js') },
    api: { desc: '接口维度：列出每个接口（方法 + 路径）在不在用，输出覆盖报告', load: () => import('../src/commands/api.js') },
    'api-report': { desc: '合并多个项目的接口结果，给出 A 可删 / B 需审核 / C 保留或高风险，输出 Markdown 和 CSV', load: () => import('../src/commands/api-report.js') },
    exports: { desc: '导出维度：没人用的导出，判定只去掉 export / 删掉声明等，可查历史', load: () => import('../src/commands/exports.js') },
    'exports-report': { desc: '从 exports 的结果生成 Markdown 和 CSV', load: () => import('../src/commands/exports-report.js') },
    check: { desc: '改之前先看风险：对比两个提交的接口变化（给合并请求、CI 用）', load: () => import('../src/commands/check.js') },
    query: { desc: '在生成好的结果里查：接口影响、相似接口、搜索、文件', load: () => import('../src/commands/query.js') },
    mcp: { desc: 'MCP 服务（stdio）：把查询和变化检查给 AI 编码工具用', load: () => import('../src/commands/mcp.js') },
    context: { desc: '整理生成项目配置的材料，交给任意大模型写 profile（工具不调用模型）', load: () => import('../src/commands/context.js') }
}
/**
 * padEnd(12) 用来把命令名补齐到 12 个字符宽，让说明那一列对齐。
 */
function printHelp() {
    console.log('用法：code-audit <命令> [参数]\n')
    console.log('命令：')
    for (const [name, { desc }] of Object.entries(commands)) {
        console.log(`  ${name.padEnd(12)}${desc}`)
    }
}

// process.argv 是 ['node 的路径', '本文件的路径', 你输入的参数...]
// 所以从下标 2 开始才是输入的内容
// 什么都不输，或 --help	打印帮助
// 报错 + 打印帮助 + 退出码设为 1
// history --file a.js 加载 history.js，调用 run(['--file', 'a.js'])
const [name, ...rest] = process.argv.slice(2)
if (!name || name === '--help' || name === '-h') {
    printHelp()
} else if (!commands[name]) {
    console.error(`未知命令：${name}\n`)
    printHelp()
    process.exitCode = 1
} else {
    const mod = await commands[name].load()
    await mod.run(rest)
}