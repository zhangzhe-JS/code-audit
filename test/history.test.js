import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRepo } from './helpers/repo.js'
import { findIntroduced } from '../src/history/introduced.js'

test('找到文件最初被加入的提交', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup()) // 测试结束后删除临时仓库，失败了也会执行

  repo.write('src/a.js', 'export const a = 1\n')
  const first = repo.commit('feat: 新增 a', { date: '2024-01-01', author: 'alice' })

  repo.write('src/a.js', 'export const a = 2\n')
  repo.commit('fix: 修改 a', { date: '2024-02-01', author: 'bob' })

  const c = findIntroduced(repo.root, 'src/a.js')
  assert.equal(c.hash, first)
  assert.equal(c.date, '2024-01-01')
  assert.equal(c.author, 'alice')
  assert.equal(c.subject, 'feat: 新增 a')
})

test('文件移动过，仍然找到最初加入的提交，而不是移动的那次', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/a.js', 'export const a = 1\n')
  const first = repo.commit('feat: 新增 a', { date: '2024-01-01' })

  repo.write('src/_deprecated/.keep', '')
  repo.run(['mv', 'src/a.js', 'src/_deprecated/a.js'])
  repo.commit('chore: 隔离 a', { date: '2025-01-01' })

  const c = findIntroduced(repo.root, 'src/_deprecated/a.js')
  assert.equal(c.hash, first)
})

test('文件不存在时返回 null', (t) => {
  const repo = createRepo()
  t.after(() => repo.cleanup())

  repo.write('src/a.js', '1\n')
  repo.commit('init')

  assert.equal(findIntroduced(repo.root, 'src/none.js'), null)
})