/** Runtime teardown joins the optional native producer independently of pair admission/transport work. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { openFederationRuntime } from '../../lib/federation/runtime.mjs'

test('concurrent runtime close callers join the same asynchronous native shutdown', async () => {
  const entered = Promise.withResolvers(), released = Promise.withResolvers()
  let calls = 0, finished = false
  const runtime = await openFederationRuntime({ role: 'worker', pairs: [], projects: {} }, { backend: {
    async close() { calls++; entered.resolve(); await released.promise; finished = true },
  } })
  try {
    const first = runtime.close()
    await entered.promise
    const second = runtime.close()
    assert.equal(first, second)
    assert.equal(finished, false)
    assert.equal(calls, 1)
    released.resolve()
    await Promise.all([first, second])
    assert.equal(finished, true)
    assert.equal(calls, 1)
  } finally { released.resolve(); await runtime.close() }
})

test('runtime keeps the same terminal native shutdown failure for every close caller', async () => {
  const failure = new Error('native shutdown failed')
  let calls = 0
  const runtime = await openFederationRuntime({ role: 'worker', pairs: [], projects: {} }, { backend: {
    async close() { calls++; throw failure },
  } })
  const first = runtime.close(), second = runtime.close()
  assert.equal(first, second)
  await assert.rejects(first, error => error === failure)
  await assert.rejects(second, error => error === failure)
  assert.equal(calls, 1)
})

test('a legacy synchronous backend close is still joined exactly once', async () => {
  let calls = 0
  const runtime = await openFederationRuntime({ role: 'worker', pairs: [], projects: {} }, { backend: { close() { calls++ } } })
  await runtime.close(); await runtime.close()
  assert.equal(calls, 1)
})
