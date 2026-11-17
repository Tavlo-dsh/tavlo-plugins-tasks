import assert from 'node:assert/strict'
import test from 'node:test'
import { callTask, mountHost, RPC_ENDPOINT, RPC_PATH } from './fixtures.mjs'

test('real HTTP: list, auth, origin, input errors, and channel cleanup', async t => {
  const { ctx, rpc, origin, fetchAuthenticated, plugin } = await mountHost(t)
  assert.deepEqual(await callTask(rpc, 'list', {}), {
    ok: true, value: { tasks: [] },
  })
  assert.equal((await fetch(origin + RPC_PATH, { method: 'POST' })).status, 401)
  assert.equal((await fetchAuthenticated(RPC_PATH, {
    method: 'POST', headers: { origin: 'https://untrusted.example' },
  })).status, 403)

  assert.deepEqual(await callTask(rpc, 'missing', {}), {
    ok: false,
    error: { code: 'tasks/not-found', message: 'Unknown operation', details: { endpoint: 'missing' } },
  })
  for (const payload of [null, [], 'list', 1, { unexpected: true }]) {
    const failure = await callTask(rpc, 'list', payload)
    assert.equal(failure.ok, false)
    assert.equal(failure.error.code, 'tasks/bad-request')
  }
  const invalidEnvelope = await fetchAuthenticated(RPC_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })
  assert.equal((await invalidEnvelope.json()).result.error.code, 'gateway/bad-request')
  const invalidDispatch = await rpc.call('/api', RPC_ENDPOINT, {})
  assert.equal(invalidDispatch.error.code, 'tasks/bad-request')
  const wrongMethod = await fetchAuthenticated(RPC_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'wrong-method', method: 'other', payload: {} }),
  })
  assert.equal((await wrongMethod.json()).result.error.code, 'gateway/bad-request')
  assert.equal((await fetchAuthenticated(RPC_PATH, {
    method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}',
  })).status, 415)
  assert.equal((await fetchAuthenticated(RPC_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  })).status, 400)

  // Mirror the official Gateway's occupied shared RPC interceptor. The exact
  // task route must take precedence, then disappear on plugin disposal.
  let fallbackCalls = 0
  const gateway = ctx.plugin({
    inject: ['connection'],
    apply(ctx) {
      ctx.connection.rpc.intercept('/api', () => true, async () => {
        fallbackCalls++
        return { ok: false, error: { code: 'gateway/not-found', message: 'fallback', details: {} } }
      })
    },
  })
  t.after(() => gateway.dispose())
  await gateway.await()
  assert.equal((await callTask(rpc, 'list', {})).ok, true)
  assert.equal(fallbackCalls, 0)
  await plugin.dispose()
  assert.equal((await callTask(rpc, 'list', {})).error.code, 'gateway/not-found')
  assert.equal(fallbackCalls, 1)
  await gateway.dispose()
  assert.equal((await fetchAuthenticated(RPC_PATH, { method: 'POST' })).status, 404)
})

test('Connection rejects non-owner and task dispatch observes cancellation', async t => {
  const { ctx, origin } = await mountHost(t)
  const connection = ctx.get('connection')
  const guest = connection.createPeer({ principal: { kind: 'probe-guest' } })
  t.after(() => guest.dispose())
  const fetchHandler = connection.createSharedFetchHandler('/api')
  const request = signal => new Request(origin + RPC_PATH, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal,
    body: JSON.stringify({
      type: 'client-request', rpcId: 'policy-test', method: RPC_ENDPOINT,
      payload: { operation: 'list', input: {} },
    }),
  })
  assert.equal((await fetchHandler.fetch(request(), guest)).status, 403)
  const cancelled = new AbortController()
  cancelled.abort()
  const response = await fetchHandler.fetch(request(cancelled.signal), connection.browserPeer)
  assert.equal((await response.json()).result.error.code, 'gateway/cancelled')
})
