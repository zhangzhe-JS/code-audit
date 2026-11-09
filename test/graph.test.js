import { test } from 'node:test'
import assert from 'node:assert/strict'
import { best, propagate } from '../src/rules/graph.js'

const edges = (pairs) => {
  const m = new Map()
  for (const [from, to] of pairs) m.set(to, [...(m.get(to) ?? []), { from, line: 1 }])
  return m
}

test('best：取 STATUSES 里最靠前的；都没有时返回 null', () => {
  assert.equal(best(['dead', 'dormant', 'external']), 'external')
  assert.equal(best([null, undefined, 'test-only']), 'test-only')
  assert.equal(best([null]), null)
})

test('propagate：要保留的状态顺着 import 一路传下去', () => {
  const own = new Map([['stub', 'external'], ['a', null], ['b', null], ['c', null]])
  const r = propagate({ own, importers: edges([['stub', 'a'], ['a', 'b']]) })
  assert.deepEqual(r.get('a'), { status: 'external', from: 'stub', line: 1 })
  assert.deepEqual(r.get('b'), { status: 'external', from: 'a', line: 1 })
  assert.equal(r.has('c'), false)
  assert.equal(r.has('stub'), false)
})

test('propagate：被多个引用方引用时取最不敢删的；互相引用也会停下来', () => {
  const own = new Map([['x', 'dormant'], ['y', 'unknown'], ['t', null], ['p', null], ['q', null]])
  const r = propagate({ own, importers: edges([['x', 't'], ['y', 't'], ['p', 'q'], ['q', 'p'], ['t', 'p']]) })
  assert.equal(r.get('t').status, 'unknown')
  assert.equal(r.get('p').status, 'unknown')
  assert.equal(r.get('q').status, 'unknown')
})

test('propagate：没有要保留的引用方时什么都不传；不在候选里的引用方忽略', () => {
  const own = new Map([['a', null], ['b', null]])
  assert.equal(propagate({ own, importers: edges([['a', 'b'], ['b', 'a']]) }).size, 0)
  assert.equal(propagate({ own: new Map([['a', 'dormant']]), importers: edges([['a', 'zzz']]) }).size, 0)
})
