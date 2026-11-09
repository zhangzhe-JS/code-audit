import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRepo } from './helpers/repo.js'
import { cloneDir, createWorkspace } from '../src/verify/workspace.js'
import { runCommand, stripAnsi, tail } from '../src/verify/run-command.js'
import { runSteps } from '../src/verify/baseline.js'
import { suggestScripts } from '../src/commands/verify.js'
import { resolveConfig } from '../src/core/config.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-verify-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 带 node_modules 的小项目：根目录和一个子包各一份，node_modules 里有 pnpm 那样的相对软链接 */
function projectRepo() {
  const repo = createRepo()
  repo.write('package.json', JSON.stringify({ name: 'demo', scripts: { build: 'node build.js', 'build:ci': 'node build.js --ci', test: 'node test.js', lint: 'x' } }))
  repo.write('build.js', "require('fs').writeFileSync('dist.txt', 'ok')\n")
  repo.write('src/main.js', "import './a.js'\n")
  repo.write('src/a.js', '')
  repo.write('packages/ui/package.json', '{"name":"ui"}')
  repo.write('.gitignore', 'node_modules\ndist.txt\n')
  repo.commit('init')
  repo.write('node_modules/.pnpm/lib@1/node_modules/lib/index.js', 'module.exports = 1\n')
  symlinkSync('.pnpm/lib@1/node_modules/lib', join(repo.root, 'node_modules/lib'))
  repo.write('packages/ui/node_modules/x/index.js', '')
  repo.write('src/uncommitted.js', '') // 工作区没提交的文件不导出
  return repo
}

// ---------- 工作目录 ----------

test('createWorkspace：导出提交里的全部文件，克隆每个 package.json 旁边的 node_modules；原项目不变', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const statusBefore = repo.run(['status', '--porcelain'])
  const ws = createWorkspace({ root: repo.root })
  t.after(() => ws.cleanup())

  assert.equal(ws.commit, repo.run(['rev-parse', 'HEAD']))
  assert.equal(ws.files, 6)
  assert.ok(existsSync(join(ws.dir, 'src/main.js')))
  assert.equal(existsSync(join(ws.dir, 'src/uncommitted.js')), false)
  assert.deepEqual(ws.deps.map((d) => d.dir), ['', 'packages/ui'])
  // 软链接原样保留（相对路径），指向的是工作目录里的拷贝，不是原项目
  const link = join(ws.dir, 'node_modules/lib')
  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(readlinkSync(link), '.pnpm/lib@1/node_modules/lib')
  assert.equal(readFileSync(join(link, 'index.js'), 'utf8'), 'module.exports = 1\n')
  // 往工作目录的 node_modules 里写，不影响原项目
  writeFileSync(join(ws.dir, 'node_modules/.cache'), 'x')
  assert.equal(existsSync(join(repo.root, 'node_modules/.cache')), false)
  assert.equal(repo.run(['status', '--porcelain']), statusBefore)

  const parent = dirname(ws.dir)
  ws.cleanup()
  assert.equal(existsSync(parent), false)
})

test('createWorkspace：node_modules 本身是软链接时，克隆它指向的目录', (t) => {
  const repo = createRepo()
  const store = tempDir(t)
  t.after(() => repo.cleanup())
  repo.write('package.json', '{}')
  repo.commit('init')
  mkdirSync(join(store, 'm'))
  writeFileSync(join(store, 'm/f.js'), 'real')
  symlinkSync(join(store, 'm'), join(repo.root, 'node_modules'))
  const ws = createWorkspace({ root: repo.root })
  t.after(() => ws.cleanup())
  assert.equal(lstatSync(join(ws.dir, 'node_modules')).isSymbolicLink(), false)
  assert.equal(readFileSync(join(ws.dir, 'node_modules/f.js'), 'utf8'), 'real')
})

test('createWorkspace：克隆失败时清掉临时目录', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  let dst
  assert.throws(
    () =>
      createWorkspace({
        root: repo.root,
        copyDir: (_src, d) => {
          dst = d
          throw new Error('磁盘满了')
        }
      }),
    /磁盘满了/
  )
  assert.equal(existsSync(dirname(dirname(dst))), false)
})

test('cloneDir：复制目录，软链接原样保留', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'src/sub'), { recursive: true })
  writeFileSync(join(dir, 'src/sub/a.txt'), 'a')
  symlinkSync('sub/a.txt', join(dir, 'src/link'))
  const method = cloneDir(join(dir, 'src'), join(dir, 'dst'))
  assert.ok(['clone', 'copy'].includes(method))
  assert.equal(readFileSync(join(dir, 'dst/sub/a.txt'), 'utf8'), 'a')
  assert.equal(readlinkSync(join(dir, 'dst/link')), 'sub/a.txt')
})

// ---------- 跑命令 ----------

test('runCommand：成功、失败、输出合在一起去掉颜色；设了 CI=1', async (t) => {
  const dir = tempDir(t)
  const ok = await runCommand('node -e "console.log(\'\\x1b[32mhi\\x1b[0m\', process.env.CI); console.error(\'warn\')"', { cwd: dir, timeoutSeconds: 30 })
  assert.equal(ok.ok, true)
  assert.equal(ok.exitCode, 0)
  assert.match(ok.output, /^hi 1$/m)
  assert.match(ok.output, /warn/)
  const bad = await runCommand('node -e "process.exit(3)"', { cwd: dir, timeoutSeconds: 30 })
  assert.deepEqual([bad.ok, bad.exitCode, bad.timedOut], [false, 3, false])
})

test('runCommand：超时时连同子进程一起结束', async (t) => {
  const dir = tempDir(t)
  const pidFile = join(dir, 'child.pid')
  // shell 再起一个 node 子进程，子进程记下自己的 pid 后一直跑
  const cmd = `node -e "require('fs').writeFileSync('child.pid', String(process.pid)); setInterval(() => {}, 1000)"`
  const r = await runCommand(cmd, { cwd: dir, timeoutSeconds: 1 })
  assert.equal(r.timedOut, true)
  assert.equal(r.ok, false)
  const pid = Number(readFileSync(pidFile, 'utf8'))
  await new Promise((res) => setTimeout(res, 300))
  assert.throws(() => process.kill(pid, 0), /ESRCH/) // 子进程已经不在了
})

test('stripAnsi、tail', () => {
  assert.equal(stripAnsi('\x1b[31mred\x1b[0m\r\nx\ry'), 'red\nx\ny')
  assert.equal(tail('1\n2\n3\n4\n', 2), '3\n4')
})

test('runSteps：按 build、test 的顺序跑配置了的步骤，完整输出写进日志目录', async (t) => {
  const dir = tempDir(t)
  const calls = []
  const run = async (command, opts) => {
    calls.push([command, opts.timeoutSeconds])
    return { command, ok: true, exitCode: 0, timedOut: false, durationMs: 1200, output: `out of ${command}` }
  }
  const verify = resolveConfig({ verify: { test: 'npm test', build: 'npm run build', timeoutSeconds: 60 } }).verify
  const r = await runSteps({ cwd: dir, verify, logDir: join(dir, 'logs'), run })
  assert.deepEqual(calls, [['npm run build', 60], ['npm test', 60]])
  assert.deepEqual(Object.keys(r), ['build', 'test'])
  assert.equal(readFileSync(join(dir, 'logs/test.log'), 'utf8'), 'out of npm test')
  const onlyTest = await runSteps({ cwd: dir, verify: resolveConfig({ verify: { test: 'npm test' } }).verify, run })
  assert.deepEqual(Object.keys(onlyTest), ['test'])
})

// ---------- 配置、命令 ----------

test('verify 配置：默认没有命令、超时 30 分钟；只写一项也行；写错时报错', () => {
  assert.deepEqual(resolveConfig({}).verify, { build: null, test: null, timeoutSeconds: 1800 })
  assert.deepEqual(resolveConfig({ verify: { build: 'npm run build' } }).verify, { build: 'npm run build', test: null, timeoutSeconds: 1800 })
  assert.throws(() => resolveConfig({ verify: { build: '' } }), /verify\.build 必须是命令字符串/)
  assert.throws(() => resolveConfig({ verify: { timeoutSeconds: 5 } }), /timeoutSeconds 必须是不小于 10 的整数/)
  assert.throws(() => resolveConfig({ verify: { lint: 'x' } }), /verify 里不认识的字段：lint/)
  assert.throws(() => resolveConfig({ verify: 'npm run build' }), /verify 必须是对象/)
})

test('suggestScripts：列出 package.json 里像构建、测试的脚本', (t) => {
  const repo = projectRepo()
  t.after(() => repo.cleanup())
  const s = suggestScripts(repo.root, 'HEAD')
  assert.match(s, /- build：node build\.js/)
  assert.match(s, /- build:ci：node build\.js --ci/)
  assert.match(s, /- test：node test\.js/)
  assert.doesNotMatch(s, /- lint/)
})

test('verify 命令：没写命令时报错并列出可用的脚本，不准备临时目录', (t) => {
  const repo = projectRepo()
  const dir = tempDir(t)
  t.after(() => repo.cleanup())
  writeFileSync(join(dir, 'p.js'), 'export default {}\n')
  const r = cli('verify', '--root', repo.root, '--profile', join(dir, 'p.js'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /没有写 verify 的命令/)
  assert.match(r.stderr, /build:ci：node build\.js --ci/)
  assert.doesNotMatch(r.stderr, /准备临时目录/)
})

test('verify 命令：试跑基线，命令在临时目录里跑，原项目不变；失败时退出码为 1 并打印最后几行', (t) => {
  const repo = projectRepo()
  const dir = tempDir(t)
  t.after(() => repo.cleanup())
  writeFileSync(join(dir, 'ok.js'), "export default { verify: { build: 'npm run build' } }\n")
  const ok = cli('verify', '--root', repo.root, '--profile', join(dir, 'ok.js'))
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stderr, /运行 build：npm run build/)
  assert.match(ok.stderr, /基线正常/)
  assert.equal(existsSync(join(repo.root, 'dist.txt')), false) // 构建产物在临时目录里，不在原项目

  writeFileSync(join(dir, 'bad.js'), "export default { verify: { test: 'node -e \"console.log(1); process.exit(2)\"' } }\n")
  const bad = cli('verify', '--root', repo.root, '--profile', join(dir, 'bad.js'), '--keep')
  assert.equal(bad.status, 1)
  assert.match(bad.stderr, /失败，退出码 2/)
  assert.match(bad.stderr, /test 的最后 30 行：\n1/)
  const kept = bad.stderr.match(/临时目录保留在：(\S+)（/)[1]
  t.after(() => rmSync(kept, { recursive: true, force: true }))
  assert.ok(existsSync(join(kept, 'logs/test.log')))
})
