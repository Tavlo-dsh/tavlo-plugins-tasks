import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { StorageError } from '@deepseek-ai/dsh-storage'
import * as tasksHost from '../index.js'
import { callTask, mountHost, readTaskDatabase, writeTaskDatabase } from './fixtures.mjs'

const ref = (id = '1123456789000000123') => ({ provider: 'tapd', connectionId: '22222222-2222-4222-8222-222222222222', scopeId: 'project', objectType: 'story', objectId: id })
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const code = result => { assert.equal(result.ok, false); return result.error.code }

test('a sibling plugin discovers the service, shares HTTP data and reattaches after reload', async t => {
  const host = await mountHost(t)
  const snapshots = []
  let service
  const consumer = host.own(host.ctx.plugin({ apply(ctx) {
    ctx.inject(['taskService'], async branch => {
      service = branch.get('taskService')
      await branch.effect(() => service.watch(event => snapshots.push(event)))
    })
  } }))
  await consumer.await()
  const firstService = service
  assert.equal(service.contractVersion, 1)
  assert((await service.capabilities()).features.externalRefUnique)
  assert((await service.capabilities()).operations.includes('options'))
  const created = ok(await service.execute('create', { requestId: 'sibling-create', title: 'External task', externalRef: ref() })).task
  assert.deepEqual(ok(await callTask(host.rpc, 'get', { taskId: created.id })).task, created)
  assert.equal(snapshots[0].type, 'snapshot')
  assert.equal(snapshots[1].task.externalRef.objectId, ref().objectId)
  await host.plugin.dispose()
  assert.equal(code(await firstService.execute('list', {})), 'tasks/unavailable')
  assert.equal(host.ctx.get('taskService'), undefined)
  const replacement = host.own(host.ctx.plugin(tasksHost))
  await replacement.await()
  // Await the consumer's reactive child activation, not a guessed delay.
  await consumer.await()
  const current = host.ctx.get('taskService')
  assert.equal(ok(await current.execute('get', { taskId: created.id })).task.id, created.id)
  assert(snapshots.filter(event => event.type === 'snapshot').length >= 2)
})

test('concurrent source creation is unique; update conflicts, unbinding and deletion release identity', async t => {
  const host = await mountHost(t)
  const service = host.ctx.get('taskService')
  const results = await Promise.all(['one', 'two'].map(requestId => service.execute('create', { requestId, title: 'Source', externalRef: ref() })))
  assert.equal(results.filter(row => row.ok).length, 1)
  const task = ok(results.find(row => row.ok)).task
  const conflict = results.find(row => !row.ok)
  assert.equal(conflict.error.code, 'tasks/external-conflict')
  assert.deepEqual(conflict.error.details, { taskId: task.id, reason: 'duplicate' })
  assert.deepEqual(ok(await service.execute('list', { externalRef: ref() })).tasks, [task])
  assert.equal(ok(await service.execute('list', { provider: 'other', limit: 10 })).total, 0)
  const rebind = await service.execute('update', { taskId: task.id, requestId: 'rebind', expectedRevision: 1, patch: { externalRef: ref('other') } })
  assert.equal(rebind.error.details.reason, 'rebind-required')
  const unbound = ok(await service.execute('update', { taskId: task.id, requestId: 'unbind', expectedRevision: 1, patch: { externalRef: null } })).task
  assert(!Object.hasOwn(unbound, 'externalRef'))
  const second = ok(await service.execute('create', { requestId: 'after-unbind', title: 'Second', externalRef: ref() })).task
  ok(await service.execute('delete', { taskId: second.id, expectedRevision: second.revision }))
  ok(await service.execute('create', { requestId: 'after-delete', title: 'Third', externalRef: ref() }))
  assert.equal(code(await service.execute('update', { taskId: second.id, requestId: 'deleted-update', expectedRevision: second.revision, patch: { title: 'Revive' } })), 'tasks/deleted')
  assert.equal(code(await service.execute('get', { taskId: second.id })), 'tasks/not-found')
})

test('update replay is durable, returns current task, preserves bindings and original create intent', async t => {
  const workspaceId = randomUUID()
  const host = await mountHost(t, { workspaces: () => [{ id: workspaceId, title: 'Workspace', path: '/work' }] })
  const initial = { requestId: 'initial', title: 'Initial title', brief: 'Initial description', workspaceId, externalRef: ref() }
  const task = ok(await callTask(host.rpc, 'create', initial)).task
  const update = { taskId: task.id, requestId: 'update-once', expectedRevision: 1, patch: { brief: 'New long description', title: 'Updated title' } }
  const results = await Promise.all(Array.from({ length: 4 }, () => callTask(host.rpc, 'update', update)))
  assert.equal(results.filter(row => !ok(row).mutation.replayed).length, 1)
  assert(results.every(row => row.value.task.revision === 2))
  const later = ok(await callTask(host.rpc, 'set-stage', { taskId: task.id, expectedRevision: 2, stage: 'done' })).task
  assert.equal(later.workspaceId, workspaceId)
  assert.equal(later.position, task.position)
  assert.equal(later.createdAt, task.createdAt)
  assert.deepEqual(ok(await callTask(host.rpc, 'create', initial)).task, later)
  await host.shutdown()
  const next = await mountHost(t, { storageRoot: host.storageRoot, config: { maxTitleLength: 1, maxBriefLength: 1, maxUpdatesPerTask: 1 } })
  const replay = ok(await callTask(next.rpc, 'update', { ...update, patch: { title: update.patch.title, brief: update.patch.brief } }))
  assert.deepEqual(replay, { task: later, mutation: { requestId: update.requestId, appliedRevision: 2, replayed: true } })
  assert.equal(code(await callTask(next.rpc, 'update', { ...update, expectedRevision: 3 })), 'tasks/request-conflict')
  assert.equal(code(await callTask(next.rpc, 'update', { ...update, patch: { title: 'X' } })), 'tasks/request-conflict')
  assert.equal(code(await callTask(next.rpc, 'update', { ...update, requestId: 'new', expectedRevision: 3, patch: { title: 'X' } })), 'tasks/limit-reached')
  assert(!JSON.stringify(replay).includes('_updates'))
})

test('no-op updates persist receipts without increasing revision or publishing changes', async t => {
  const host = await mountHost(t)
  const service = host.ctx.get('taskService')
  const task = ok(await service.execute('create', { requestId: 'create', title: 'Same' })).task
  const events = []
  const controller = new AbortController()
  await service.watch(event => events.push(event), controller.signal)
  const input = { taskId: task.id, requestId: 'noop', expectedRevision: 1, patch: { title: ' Same ', brief: '' } }
  const result = ok(await service.execute('update', input))
  assert.deepEqual(result.task, task)
  assert.equal(result.mutation.appliedRevision, 1)
  assert.equal(events.length, 1)
  assert.equal(readTaskDatabase(host.storageRoot).tables.tasks[task.id]._updates.length, 1)
  assert(ok(await service.execute('update', input)).mutation.replayed)
  controller.abort()
  ok(await service.execute('update', { ...input, requestId: 'changed', patch: { title: 'Changed' } }))
  assert.equal(events.length, 1)
})

test('updates reject stale revisions, private fields, empty patches and malformed sources', async t => {
  const host = await mountHost(t)
  const task = ok(await callTask(host.rpc, 'create', { requestId: 'validation', title: 'Task' })).task
  const input = { taskId: task.id, requestId: 'edit', expectedRevision: 1 }
  for (const patch of [{}, { title: '  ' }, { revision: 9 }, { workspaceId: 'not-a-uuid' }, { stage: 'done' }, { _updates: [] },
    { externalRef: { ...ref(), objectId: 123 } }, { externalRef: { ...ref(), url: 'javascript:alert(1)' } },
    { externalRef: { ...ref(), url: 'https://user:password@example.org/' } }]) {
    assert.equal(code(await callTask(host.rpc, 'update', { ...input, patch })), 'tasks/bad-request')
  }
  ok(await callTask(host.rpc, 'update', { ...input, patch: { title: 'A' } }))
  const stale = await callTask(host.rpc, 'update', { ...input, requestId: 'stale', patch: { title: 'B' } })
  assert.equal(stale.error.code, 'tasks/revision-conflict')
  assert.equal(stale.error.details.currentRevision, 2)
})

test('failed and uncertain updates do not publish success and recover their receipts after restart', async t => {
  let mode
  const host = await mountHost(t, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (...args) => {
      if (mode === 'failed') throw new Error('disk full')
      await target.putRecord(...args)
      if (mode === 'unknown') throw new StorageError('unknown-state', 'lost acknowledgement')
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const service = host.ctx.get('taskService')
  const task = ok(await service.execute('create', { requestId: 'create', title: 'Before' })).task
  const events = []
  await service.watch(event => events.push(event))
  const update = { taskId: task.id, requestId: 'update', expectedRevision: 1, patch: { title: 'After', externalRef: ref() } }
  mode = 'failed'
  assert.equal(code(await service.execute('update', update)), 'tasks/persistence-failed')
  assert.deepEqual(ok(await service.execute('get', { taskId: task.id })).task, task)
  assert.equal(events.length, 1)
  mode = 'unknown'
  assert.equal(code(await service.execute('update', update)), 'tasks/persistence-unknown')
  assert(!events.some(event => event.type === 'upsert'))
  await host.shutdown()
  const recovered = await mountHost(t, { storageRoot: host.storageRoot })
  const replay = ok(await callTask(recovered.rpc, 'update', update))
  assert.equal(replay.task.revision, 2)
  assert.equal(replay.mutation.replayed, true)
})

test('duplicate external identities in persisted data fail activation without rewriting data', async t => {
  const first = await mountHost(t)
  const task = ok(await callTask(first.rpc, 'create', { requestId: 'create', title: 'Task', externalRef: ref() })).task
  await first.shutdown()
  const disk = readTaskDatabase(first.storageRoot)
  const id = randomUUID()
  disk.tables.tasks[id] = { ...structuredClone(disk.tables.tasks[task.id]), id, _create: { requestId: 'other', title: 'Task', brief: '', externalRef: ref() } }
  writeTaskDatabase(first.storageRoot, disk)
  const next = await mountHost(t, { storageRoot: first.storageRoot, activate: false })
  const broken = next.own(next.ctx.plugin(tasksHost))
  await assert.rejects(broken.await(), /duplicate external source/)
  assert.deepEqual(readTaskDatabase(first.storageRoot), disk)
})
