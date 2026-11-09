#!/usr/bin/env node


/**
 * desc  --help 显示用的说明。
 * load  命令加载路径
**/
const commands = {
    scan: { desc: '采集 + 判定，输出候选清单 JSON', load: () => import('../src/commands/scan.js') },
    history: { desc: '补充 git 历史：引入、失去引用', load: () => import('../src/commands/history.js') },
    verify: { desc: '在临时目录里实删验证（现在支持试跑基线）', load: () => import('../src/commands/verify.js') },
    report: { desc: '从 JSON 生成报告', load: () => import('../src/commands/report.js') },
    quarantine: { desc: '隔离：移进隔离区，加头注释（--apply 时会改动目标项目）', load: () => import('../src/commands/quarantine.js') }
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