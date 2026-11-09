import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, symlinkSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildOutputs } from '../src/report/outputs.js'
import { assertOutsideRepo, assertEmptyDir, writeDirSafely, writeFileSafely, realPath } from '../src/core/output.js'
import { resolveConfig } from '../src/core/config.js'

const bin = fileURLToPath(new URL('../bin/code-audit.js', import.meta.url))
const cli = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8' })
const full = () => JSON.parse(readFileSync(new URL('./samples/full.json', import.meta.url), 'utf8'))

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'code-audit-out-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** 把一份数据写进临时目录，project.root 指向另一个临时目录（模拟被分析的仓库） */
function writeInput(t, report = full()) {
  const dir = tempDir(t)
  report.project.root = join(dir, 'repo')
  mkdirSync(report.project.root)
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report))
  return { dir, input: join(dir, 'report.json'), repoRoot: report.project.root }
}

// ---------- buildOutputs ----------

test('buildOutputs：报告、清单，以及每个有历史的文件一份头注释', () => {
  const { files, skipped } = buildOutputs(full())
  assert.deepEqual(files.map((f) => f.path), ['report.md', 'quarantine-table.md', 'headers/src/utils/math.js.txt'])
  assert.match(files[0].content, /^# 排查报告：demo\n/)
  assert.match(files[1].content, /^\| 文件 \|/)
  assert.match(files[2].content, /^\/\*\*\n \* \[code-audit\] 文件排查记录\n/)
  for (const f of files) assert.ok(f.content.endsWith('\n'), `${f.path} 应以换行结尾`)
  // 另外两项没有历史，跳过并说明原因
  assert.deepEqual(skipped.map((s) => s.id), ['export:src/utils/file.js#toBlob', 'file:src/utils/check.js'])
  assert.match(skipped[0].reason, /没有 git 历史/)
})

test('buildOutputs：不能写注释的文件类型跳过并说明原因，不影响其他输出', () => {
  const r = full()
  const json = structuredClone(r.items[2])
  json.id = 'file:src/utils/data.json'
  json.target = 'src/utils/data.json'
  json.history.paths = ['src/utils/data.json']
  r.items.push(json)
  r.items.sort((a, b) => (a.id < b.id ? -1 : 1)) // schema 要求按 id 排序
  const { files, skipped } = buildOutputs(r)
  assert.ok(files.some((f) => f.path === 'headers/src/utils/math.js.txt'))
  assert.match(skipped.find((s) => s.id === 'file:src/utils/data.json').reason, /不支持为 \.json 文件生成头注释/)
})

test('buildOutputs：路径带 .. 的数据在校验时就被拒绝，不会把文件写到输出目录外面', () => {
  const r = full()
  r.items[2].id = 'file:src/../../etc/evil.js'
  r.items[2].target = 'src/../../etc/evil.js'
  delete r.items[2].history.paths
  assert.throws(() => buildOutputs(r), /target 必须是相对路径/)
})

test('buildOutputs：移入日期、分支、配置都传给头注释', () => {
  const config = resolveConfig({ headerTitle: '@deprecated' })
  const { files } = buildOutputs(full(), { config, movedAt: '2026-11-05', branch: 'dev' })
  const header = files.find((f) => f.path.startsWith('headers/')).content
  assert.match(header, / \* @deprecated\n/)
  assert.match(header, / \* 移入：2026-11-05（分支 dev）\n/)
})

test('buildOutputs：数据不符合格式时报错，不生成任何文件', () => {
  const r = full()
  r.items[0].status = 'unused'
  assert.throws(() => buildOutputs(r), /无法生成/)
})

// ---------- 输出位置检查 ----------

test('assertOutsideRepo：仓库本身和仓库里面都不行，仓库外面可以', () => {
  assert.throws(() => assertOutsideRepo('/repo', '/repo'), /在被分析的仓库里/)
  assert.throws(() => assertOutsideRepo('/repo/reports/x', '/repo'), /在被分析的仓库里/)
  assert.doesNotThrow(() => assertOutsideRepo('/repo-reports', '/repo')) // 只是名字以 repo 开头
  assert.doesNotThrow(() => assertOutsideRepo('/other/reports', '/repo'))
})

test('assertEmptyDir：不存在或为空可以；有文件、或者是文件都不行', (t) => {
  const dir = tempDir(t)
  assert.doesNotThrow(() => assertEmptyDir(join(dir, 'none')))
  assert.doesNotThrow(() => assertEmptyDir(dir))
  writeFileSync(join(dir, 'a.txt'), 'x')
  assert.throws(() => assertEmptyDir(dir), /输出目录不为空/)
  assert.throws(() => assertEmptyDir(join(dir, 'a.txt')), /不是目录/)
})

// ---------- report 命令 ----------

test('report 命令：生成三样东西，并列出跳过的项', (t) => {
  const { dir, input } = writeInput(t)
  const out = join(dir, 'out')

  const r = cli('report', '--in', input, '--out', out, '--moved-at', '2026-11-05')
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /头注释 1 个/)
  assert.match(r.stdout, /跳过 2 个/)
  assert.deepEqual(readdirSync(out).sort(), ['headers', 'quarantine-table.md', 'report.md'])
  assert.match(readFileSync(join(out, 'headers/src/utils/math.js.txt'), 'utf8'), /移入：2026-11-05/)
})

test('report 命令：输出目录在被分析的仓库里时报错，什么都不写', (t) => {
  const { input, repoRoot } = writeInput(t)
  const r = cli('report', '--in', input, '--out', join(repoRoot, 'reports'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /输出位置在被分析的仓库里/)
  assert.equal(existsSync(join(repoRoot, 'reports')), false)
})

test('report 命令：输出目录不为空时报错，不覆盖已有文件', (t) => {
  const { dir, input } = writeInput(t)
  const out = join(dir, 'out')
  mkdirSync(out)
  writeFileSync(join(out, 'report.md'), '旧报告')

  const r = cli('report', '--in', input, '--out', out)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /输出目录不为空/)
  assert.equal(readFileSync(join(out, 'report.md'), 'utf8'), '旧报告')
})

test('report 命令：数据不符合格式时报错，不创建输出目录', (t) => {
  const r0 = full()
  r0.items[0].status = 'unused'
  const { dir, input } = writeInput(t, r0)
  const out = join(dir, 'out')

  const r = cli('report', '--in', input, '--out', out)
  assert.equal(r.status, 1)
  assert.match(r.stderr, /status 不合法/)
  assert.equal(existsSync(out), false)
})

test('report 命令：参数缺失或格式不对时报错', (t) => {
  const { input } = writeInput(t)
  for (const [args, re] of [
    [[], /缺少 --in/],
    [['--in', input], /缺少 --out/],
    [['--in', input, '--out', '/tmp/x', '--moved-at', '2026-02-30'], /--moved-at 格式/],
    [['--in', input, '--out', '/tmp/x', '--moved-at', '20261105'], /--moved-at 格式/],
    [['--in', input, '--out', '/tmp/x', '--branch', 'dev'], /要和 --moved-at 一起用/]
  ]) {
    const r = cli('report', ...args)
    assert.equal(r.status, 1, args.join(' '))
    assert.match(r.stderr, re, args.join(' '))
  }
})

// ---------- 符号链接：按真实路径判断 ----------

test('assertOutsideRepo：仓库外的符号链接指向仓库里时也拦下（链接本身、链接下还不存在的子目录）', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'repo/inner'), { recursive: true })
  symlinkSync(join(dir, 'repo/inner'), join(dir, 'link'))
  symlinkSync(join(dir, 'repo'), join(dir, 'repo-link'))

  assert.throws(() => assertOutsideRepo(join(dir, 'link'), join(dir, 'repo')), /经符号链接实际指向/)
  assert.throws(() => assertOutsideRepo(join(dir, 'link/new/deep'), join(dir, 'repo')), /在被分析的仓库里/)
  // 仓库根目录本身通过链接给出时，也按真实路径比较
  assert.throws(() => assertOutsideRepo(join(dir, 'repo/out'), join(dir, 'repo-link')), /在被分析的仓库里/)
  assert.doesNotThrow(() => assertOutsideRepo(join(dir, 'out'), join(dir, 'repo-link')))
})

test('realPath：路径还不存在时，按最近一级存在的父目录解析；失效的符号链接报错', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'real'))
  symlinkSync(join(dir, 'real'), join(dir, 'link'))
  symlinkSync(join(dir, 'nowhere'), join(dir, 'broken'))

  assert.equal(realPath(join(dir, 'link/a/b')), join(realPath(dir), 'real/a/b'))
  assert.throws(() => realPath(join(dir, 'broken/x')), /失效的符号链接/)
})

test('report 命令：通过符号链接写进仓库会被拦下，仓库里什么都不写', (t) => {
  const { dir, input, repoRoot } = writeInput(t)
  mkdirSync(join(repoRoot, 'inner'))
  symlinkSync(join(repoRoot, 'inner'), join(dir, 'link'))

  const r = cli('report', '--in', input, '--out', join(dir, 'link/out'))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /输出位置在被分析的仓库里/)
  assert.deepEqual(readdirSync(join(repoRoot, 'inner')), [])
})

test('history --out：通过符号链接写进仓库、或输出位置是失效的符号链接，都会被拦下', (t) => {
  const { dir, repoRoot } = writeInput(t)
  symlinkSync(repoRoot, join(dir, 'link'))
  symlinkSync(join(repoRoot, 'nowhere.json'), join(dir, 'broken.json'))
  writeFileSync(join(dir, 'c.json'), JSON.stringify({ project: 'p', files: [{ file: 'src/a.js' }] }))

  const viaLink = cli('history', '--root', repoRoot, '--in', join(dir, 'c.json'), '--out', join(dir, 'link/data.json'))
  assert.equal(viaLink.status, 1)
  assert.match(viaLink.stderr, /输出位置在被分析的仓库里/)

  const broken = cli('history', '--root', repoRoot, '--in', join(dir, 'c.json'), '--out', join(dir, 'broken.json'))
  assert.equal(broken.status, 1)
  assert.match(broken.stderr, /失效的符号链接|输出文件已存在/)
  assert.equal(existsSync(join(repoRoot, 'nowhere.json')), false)
})

// ---------- 先写临时位置，再一次性改名 ----------

test('writeDirSafely：全部写完才出现输出目录；输出目录原本为空也可以', (t) => {
  const dir = tempDir(t)
  writeDirSafely(join(dir, 'out'), [{ path: 'a.md', content: 'a' }, { path: 'x/y/b.txt', content: 'b' }])
  assert.equal(readFileSync(join(dir, 'out/x/y/b.txt'), 'utf8'), 'b')

  mkdirSync(join(dir, 'empty'))
  writeDirSafely(join(dir, 'empty'), [{ path: 'a.md', content: 'a' }])
  assert.equal(readFileSync(join(dir, 'empty/a.md'), 'utf8'), 'a')

  // 不留下临时目录
  assert.deepEqual(readdirSync(dir).sort(), ['empty', 'out'])
})

test('writeDirSafely：中途写失败时不留下半成品，也不留下临时目录', (t) => {
  const dir = tempDir(t)
  // 第二个文件的路径和第一个文件冲突（a.md 是文件，不能再当目录用），写到一半会失败
  assert.throws(() => writeDirSafely(join(dir, 'out'), [{ path: 'a.md', content: 'a' }, { path: 'a.md/b.txt', content: 'b' }]))
  assert.deepEqual(readdirSync(dir), [])
})

test('writeDirSafely：输出目录在写的过程中被放进了文件，不会删掉它', (t) => {
  const dir = tempDir(t)
  mkdirSync(join(dir, 'out'))
  writeFileSync(join(dir, 'out/keep.txt'), '别人的文件')
  assert.throws(() => writeDirSafely(join(dir, 'out'), [{ path: 'a.md', content: 'a' }]))
  assert.equal(readFileSync(join(dir, 'out/keep.txt'), 'utf8'), '别人的文件')
  assert.deepEqual(readdirSync(dir), ['out']) // 临时目录已清理
})

test('writeFileSafely：目标已存在时不覆盖，也不留下临时文件', (t) => {
  const dir = tempDir(t)
  writeFileSafely(join(dir, 'sub/a.json'), '新内容')
  assert.equal(readFileSync(join(dir, 'sub/a.json'), 'utf8'), '新内容')
  assert.throws(() => writeFileSafely(join(dir, 'sub/a.json'), '覆盖'), /输出文件已存在/)
  assert.equal(readFileSync(join(dir, 'sub/a.json'), 'utf8'), '新内容')
  assert.deepEqual(readdirSync(join(dir, 'sub')), ['a.json'])
})

test('report 命令：写盘失败时输出目录保持不存在', (t) => {
  const { dir, input } = writeInput(t)
  const parent = join(dir, 'readonly')
  mkdirSync(parent)
  chmodSync(parent, 0o500) // 父目录不能写：临时目录都建不出来
  const r = cli('report', '--in', input, '--out', join(parent, 'out'))
  chmodSync(parent, 0o700) // 马上恢复，临时目录才能被正常清理

  assert.equal(r.status, 1)
  assert.equal(existsSync(join(parent, 'out')), false)
})
