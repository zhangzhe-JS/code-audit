/**
 * 输出文件的公共检查和写入：命令写文件都要经过这里
 *
 * 原则「默认只读」：分析时不往目标仓库里加任何文件。
 * - 输出位置按真实路径判断（展开符号链接），落在被分析的仓库里直接报错
 * - 不覆盖、不删除已有文件
 * - 先写到临时位置，全部写完再一次性改名：中途出错不会留下写了一半的结果
 */
import { resolve, relative, isAbsolute, dirname, basename, join } from 'node:path'
import {
  readFileSync, readdirSync, statSync, lstatSync, realpathSync,
  mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync, rmdirSync, linkSync, unlinkSync
} from 'node:fs'

/**
 * 输出位置不能在被分析的仓库里面（包括仓库根目录本身）
 * 两边都换成真实路径再比较：仓库外的路径如果是指向仓库里的符号链接，也会被拦下
 * @param {string} outPath 输出文件或目录（可以还不存在）
 * @param {string} repoRoot 被分析的仓库根目录
 */
export function assertOutsideRepo(outPath, repoRoot) {
  const realRoot = realPath(repoRoot)
  const realOut = realPath(outPath)
  const rel = relative(realRoot, realOut)
  const inside = rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  if (inside) {
    const via = realOut === resolve(outPath) ? '' : `（经符号链接实际指向 ${realOut}）`
    throw new Error(
      `输出位置在被分析的仓库里：${resolve(outPath)}${via}\n` +
      `工具默认只读，不往目标仓库写文件，请把输出放到仓库外面（仓库：${realRoot}）`
    )
  }
}

/**
 * 路径对应的真实位置：展开所有符号链接
 * 路径还不存在时，找到最近一级存在的父目录，解析它的真实路径，再接上后面不存在的部分
 * 遇到失效的符号链接（指向的东西不存在）直接报错：无法确定写进去的文件会落在哪里
 * @param {string} p
 */
export function realPath(p) {
  let current = resolve(p)
  const missing = []
  while (!pathExists(current)) {
    missing.unshift(basename(current))
    const parent = dirname(current)
    if (parent === current) break // 到根目录了
    current = parent
  }
  try {
    return join(realpathSync(current), ...missing)
  } catch {
    throw new Error(`路径里有失效的符号链接，无法确定实际位置：${current}`)
  }
}

/** 路径上是否已经有东西（包括失效的符号链接：existsSync 会把它当成不存在） */
export function pathExists(p) {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

/**
 * 输出目录必须不存在或为空：不覆盖、不删除已有文件，避免和上一次的结果混在一起
 * @param {string} dir
 */
export function assertEmptyDir(dir) {
  if (!pathExists(dir)) return
  let isDir = false
  try {
    isDir = statSync(dir).isDirectory()
  } catch {
    // 失效的符号链接：statSync 会失败
  }
  if (!isDir) throw new Error(`输出位置已存在，但不是目录：${resolve(dir)}`)
  if (readdirSync(dir).length > 0) {
    throw new Error(`输出目录不为空：${resolve(dir)}\n请换一个目录，或先自己清空它（工具不会删除已有文件）`)
  }
}

/**
 * 写一个文件：先写到同目录下的临时文件，再用硬链接放到目标位置
 * 硬链接在目标已存在时会失败，所以即使检查之后才有人建了同名文件，也不会被覆盖
 * @param {string} file
 * @param {string} content
 */
export function writeFileSafely(file, content) {
  const target = resolve(file)
  mkdirSync(dirname(target), { recursive: true })
  const tmp = join(dirname(target), `.${basename(target)}.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, content, { flag: 'wx' })
  try {
    linkSync(tmp, target)
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error(`输出文件已存在：${target}（工具不覆盖已有文件，请换一个文件名）`)
    throw e
  } finally {
    unlinkSync(tmp)
  }
}

/**
 * 写一整个目录：先在同级的临时目录里写完所有文件，再改名成输出目录
 * 中途出错时只删除工具自己建的临时目录，输出目录保持原样（不存在或为空）
 * @param {string} dir 输出目录：必须不存在或为空（调用前用 assertEmptyDir 检查）
 * @param {{path: string, content: string}[]} files path 是相对输出目录的路径
 */
export function writeDirSafely(dir, files) {
  const target = resolve(dir)
  mkdirSync(dirname(target), { recursive: true })
  // 临时目录和输出目录在同一个父目录下：同一个磁盘，改名是一次性完成的
  const tmp = mkdtempSync(join(dirname(target), `.${basename(target)}.tmp-`))
  try {
    for (const f of files) {
      const p = join(tmp, f.path)
      mkdirSync(dirname(p), { recursive: true })
      writeFileSync(p, f.content)
    }
    // 输出目录已存在时只可能是空目录；rmdir 只能删空目录，不为空时系统会拒绝，不会误删文件
    if (pathExists(target)) rmdirSync(target)
    renameSync(tmp, target)
  } catch (e) {
    rmSync(tmp, { recursive: true, force: true })
    throw e
  }
}

/**
 * 读取并解析 JSON 文件，出错时带上文件路径
 * @param {string} file
 */
export function readJson(file) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (e) {
    throw new Error(`读不到文件：${resolve(file)}（${e.code ?? e.message}）`)
  }
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new Error(`不是合法的 JSON：${resolve(file)}（${e.message}）`)
  }
}
