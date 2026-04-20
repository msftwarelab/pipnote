import test from 'node:test'
import assert from 'node:assert/strict'
import { TtlCache } from '../src/utils/ttlCache.ts'

test('TtlCache returns cached value before ttl expiry', async () => {
  const cache = new TtlCache<number>(100)
  let loads = 0
  const loader = async () => {
    loads += 1
    return loads
  }

  const first = await cache.getOrLoad(loader, { now: 0 })
  const second = await cache.getOrLoad(loader, { now: 50 })

  assert.equal(first, 1)
  assert.equal(second, 1)
  assert.equal(loads, 1)
})

test('TtlCache reloads value after ttl expiry', async () => {
  const cache = new TtlCache<number>(100)
  let loads = 0
  const loader = async () => {
    loads += 1
    return loads
  }

  await cache.getOrLoad(loader, { now: 0 })
  const refreshed = await cache.getOrLoad(loader, { now: 101 })

  assert.equal(refreshed, 2)
  assert.equal(loads, 2)
})

test('TtlCache dedupes concurrent in-flight loads', async () => {
  const cache = new TtlCache<number>(1000)
  let loads = 0
  let release: (() => void) | null = null
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })

  const loader = async () => {
    loads += 1
    await gate
    return 42
  }

  const first = cache.getOrLoad(loader, { now: 0 })
  const second = cache.getOrLoad(loader, { now: 0 })
  release?.()
  const [a, b] = await Promise.all([first, second])

  assert.equal(a, 42)
  assert.equal(b, 42)
  assert.equal(loads, 1)
})

test('TtlCache forceRefresh bypasses fresh cache', async () => {
  const cache = new TtlCache<number>(1000)
  let loads = 0
  const loader = async () => {
    loads += 1
    return loads
  }

  await cache.getOrLoad(loader, { now: 0 })
  const forced = await cache.getOrLoad(loader, { now: 1, forceRefresh: true })

  assert.equal(forced, 2)
  assert.equal(loads, 2)
})

test('TtlCache invalidate clears cached value', async () => {
  const cache = new TtlCache<number>(1000)
  let loads = 0
  const loader = async () => {
    loads += 1
    return loads
  }

  await cache.getOrLoad(loader, { now: 0 })
  cache.invalidate()
  const reloaded = await cache.getOrLoad(loader, { now: 10 })

  assert.equal(reloaded, 2)
  assert.equal(loads, 2)
})

