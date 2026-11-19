import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { StorageError } from '@deepseek-ai/dsh-storage'
import * as tasksHost from '../index.js'
import { taskDomain } from '../task-schema.js'
import { createTaskStore } from '../task-store.js'
import { callTask, mountHost, mountStorage, RPC_PATH, readTaskDatabase, writeTaskDatabase } from './fixtures.mjs'

const limits = { maxTitleLength: 200, maxBriefLength: 20000, maxTasks: 10000 }
const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const errorCode = result => { assert.equal(result.ok, false); return result.error.code }

/** Intercept one public backend method while retaining real JSON durability. */
function interceptPut(unit, put) {
  return new Proxy(unit, {
    get(target, key) {
      if (key === 'putRecord') return (...args) => put(() => target.putRecord(...args))
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
}

test('HTTP creation and stage changes survive closing and a fresh Host', async t => {
  const first = await mountHost(t)
  const { task } = success(await callTask(first.rpc, 'create', {
    requestId: 'durable-create', title: '  持久任务  ', brief: '跨会话保存',
  }))
  assert.equal(task.title, '持久任务')
  assert.equal(task.stage, 'todo')
  assert.equal(task.revision, 1)
  assert.equal(task.position, 0)
  assert(!Object.hasOwn(task, '_create'))
  const changed = success(await callTask(first.rpc, 'set-stage', {
    taskId: task.id, expectedRevision: 1, stage: 'doing',
  })).task
  assert.equal(changed.revision, 2)
  assert.equal(changed.stage, 'doing')
  assert.equal(changed.createdAt, task.createdAt)
  assert.deepEqual(success(await callTask(first.rpc, 'list', {})).tasks, [changed])
  const disk = readTaskDatabase(first.storageRoot)
  assert.equal(disk.unit.version, 8)
  assert.equal(disk.tables.tasks[task.id]._create.requestId, 'durable-create')
  await first.shutdown()

  const second = await mountHost(t, { storageRoot: first.storageRoot })
  assert.deepEqual(success(await callTask(second.rpc, 'list', {})).tasks, [changed])
  // Rebuild the request index from disk, returning the current existing task.
  assert.deepEqual(success(await callTask(second.rpc, 'create', {
    requestId: 'durable-create', title: '持久任务', brief: '跨会话保存',
  })).task, changed)
  await second.shutdown()
})

test('concurrent creation retries produce one record and changed input conflicts', async t => {
  const host = await mountHost(t)
  const input = { requestId: 'same-request', title: 'Only once' }
  const results = await Promise.all(Array.from({ length: 8 }, () => callTask(host.rpc, 'create', input)))
  const ids = new Set(results.map(result => success(result).task.id))
  assert.equal(ids.size, 1)
  const retry = success(await callTask(host.rpc, 'create', { ...input, brief: '' })).task
  assert.equal(retry.id, [...ids][0])
  assert.equal(errorCode(await callTask(host.rpc, 'create', { ...input, title: 'Different' })), 'tasks/request-conflict')
  const next = success(await callTask(host.rpc, 'create', { requestId: 'next-request', title: 'Second' })).task
  assert.equal(next.position, 1)
  assert.equal(success(await callTask(host.rpc, 'list', {})).tasks.length, 2)
})

test('two updates with the same revision commit exactly one change', async t => {
  const host = await mountHost(t)
  const task = success(await callTask(host.rpc, 'create', { requestId: 'cas', title: 'Concurrent' })).task
  const results = await Promise.all(['doing', 'done'].map(stage => callTask(host.rpc, 'set-stage', {
    taskId: task.id, expectedRevision: 1, stage,
  })))
  assert.equal(results.filter(result => result.ok).length, 1)
  const conflict = results.find(result => !result.ok)
  assert.equal(conflict.error.code, 'tasks/revision-conflict')
  assert.equal(conflict.error.details.currentRevision, 2)
  const stored = success(await callTask(host.rpc, 'list', {})).tasks[0]
  assert.deepEqual(stored, results.find(result => result.ok).value.task)
  assert.equal(stored.revision, 2)
  assert.equal(errorCode(await callTask(host.rpc, 'set-stage', {
    taskId: randomUUID(), expectedRevision: 1, stage: 'done',
  })), 'tasks/not-found')
})

test('new task ordering follows valid fractional positions restored from disk', async t => {
  const first = await mountHost(t)
  const task = success(await callTask(first.rpc, 'create', { requestId: 'position', title: 'Existing' })).task
  await first.shutdown()
  const document = readTaskDatabase(first.storageRoot)
  document.tables.tasks[task.id].position = 0.5
  writeTaskDatabase(first.storageRoot, document)
  const host = await mountHost(t, { storageRoot: first.storageRoot })
  const next = success(await callTask(host.rpc, 'create', { requestId: 'position-next', title: 'Next' })).task
  assert.equal(next.position, 1)
  assert.deepEqual(success(await callTask(host.rpc, 'list', {})).tasks.map(task => task.position), [0.5, 1])
  await host.shutdown()
})

test('input limits and unknown fields reject before writing; retries work at capacity', async t => {
  const host = await mountHost(t, { config: { maxTitleLength: 4, maxBriefLength: 3, maxTasks: 1 } })
  const input = { requestId: 'limited', title: 'Good' }
  for (const invalid of [
    { title: 'Good' }, { ...input, title: '   ' }, { ...input, title: '12345' },
    { ...input, brief: '1234' }, { ...input, id: randomUUID() }, { ...input, stage: 'other' },
    { ...input, revision: 9 }, { ...input, createdAt: new Date().toISOString() },
  ]) {
    assert.equal(errorCode(await callTask(host.rpc, 'create', invalid)), 'tasks/bad-request')
  }
  assert.equal(success(await callTask(host.rpc, 'list', {})).tasks.length, 0)
  const task = success(await callTask(host.rpc, 'create', input)).task
  assert.equal(errorCode(await callTask(host.rpc, 'create', { requestId: 'overflow', title: 'Next' })), 'tasks/limit-reached')
  assert.equal(success(await callTask(host.rpc, 'create', input)).task.id, task.id)
  for (const invalid of [
    { taskId: task.id, expectedRevision: 1, stage: 'cancelled' },
    { taskId: task.id, expectedRevision: 0, stage: 'doing' },
    { taskId: task.id, expectedRevision: 1, stage: 'doing', title: 'Edit' },
  ]) {
    assert.equal(errorCode(await callTask(host.rpc, 'set-stage', invalid)), 'tasks/bad-request')
  }
  await host.shutdown()
  const reopened = await mountHost(t, { storageRoot: host.storageRoot, config: { maxTitleLength: 1, maxTasks: 1 } })
  assert.equal(success(await callTask(reopened.rpc, 'list', {})).tasks[0].title, 'Good')
  assert.equal(success(await callTask(reopened.rpc, 'create', input)).task.id, task.id)
  assert.equal(success(await callTask(reopened.rpc, 'set-stage', {
    taskId: task.id, expectedRevision: 1, stage: 'done',
  })).task.stage, 'done')
  await reopened.shutdown()
})

test('backend failure leaves both memory and disk unchanged and allows retry', async t => {
  let failWrites = true
  const host = await mountHost(t, { wrapUnit: unit => interceptPut(unit, write => {
    if (failWrites) throw new Error('test disk failure')
    return write()
  }) })
  const input = { requestId: 'retry-write', title: 'Durable only' }
  assert.equal(errorCode(await callTask(host.rpc, 'create', input)), 'tasks/persistence-failed')
  assert.deepEqual(success(await callTask(host.rpc, 'list', {})).tasks, [])
  assert.deepEqual(readTaskDatabase(host.storageRoot).tables.tasks, {})
  failWrites = false
  const task = success(await callTask(host.rpc, 'create', input)).task
  const before = readTaskDatabase(host.storageRoot)
  failWrites = true
  assert.equal(errorCode(await callTask(host.rpc, 'set-stage', {
    taskId: task.id, expectedRevision: 1, stage: 'doing',
  })), 'tasks/persistence-failed')
  assert.deepEqual(success(await callTask(host.rpc, 'list', {})).tasks, [task])
  assert.deepEqual(readTaskDatabase(host.storageRoot), before)
  failWrites = false
  assert.equal(success(await callTask(host.rpc, 'set-stage', {
    taskId: task.id, expectedRevision: 1, stage: 'doing',
  })).task.revision, 2)
})

test('uncertain commit quarantines reads; reopening recovers the creation request', async t => {
  const host = await mountHost(t, { wrapUnit: unit => interceptPut(unit, async write => {
    await write()
    throw new StorageError('unknown-state', 'test lost commit acknowledgement')
  }) })
  const input = { requestId: 'uncertain', title: 'Unknown result' }
  assert.equal(errorCode(await callTask(host.rpc, 'create', input)), 'tasks/persistence-unknown')
  assert.equal(errorCode(await callTask(host.rpc, 'list', {})), 'tasks/persistence-unknown')
  assert.equal(errorCode(await callTask(host.rpc, 'create', input)), 'tasks/persistence-unknown')
  await host.shutdown()
  const recovered = await mountHost(t, { storageRoot: host.storageRoot })
  const task = success(await callTask(recovered.rpc, 'create', input)).task
  assert.deepEqual(success(await callTask(recovered.rpc, 'list', {})).tasks, [task])
  await recovered.shutdown()
})

test('invalid durable records prevent Host activation and remain untouched', async t => {
  const first = await mountHost(t)
  const task = success(await callTask(first.rpc, 'create', { requestId: 'corrupt', title: 'Saved' })).task
  const original = readTaskDatabase(first.storageRoot)
  await first.shutdown()
  const document = structuredClone(original)
  document.tables.tasks[task.id].stage = 'foreign-stage'
  writeTaskDatabase(first.storageRoot, document)
  const host = await mountHost(t, { storageRoot: first.storageRoot, activate: false })
  const failed = host.own(host.ctx.plugin(tasksHost))
  await assert.rejects(failed.await(), { code: 'invalid-record' })
  assert.equal((await host.fetchAuthenticated(RPC_PATH, { method: 'POST' })).status, 404)
  assert.deepEqual(readTaskDatabase(first.storageRoot), document)
  await failed.dispose()
  writeTaskDatabase(first.storageRoot, original)
  const repaired = host.own(host.ctx.plugin(tasksHost))
  await repaired.await()
  assert.equal(success(await callTask(host.rpc, 'list', {})).tasks[0].id, task.id)
  await host.shutdown()
})

test('inconsistent keys and duplicate request ids fail activation and release the domain', async t => {
  for (const duplicateRequest of [false, true]) {
    await t.test(duplicateRequest ? 'duplicate request' : 'key/id mismatch', async t => {
      const first = await mountHost(t)
      const task = success(await callTask(first.rpc, 'create', { requestId: 'integrity', title: 'Saved' })).task
      const original = readTaskDatabase(first.storageRoot)
      await first.shutdown()
      const document = structuredClone(original)
      const key = randomUUID()
      const record = structuredClone(document.tables.tasks[task.id])
      if (duplicateRequest) record.id = key
      document.tables.tasks[key] = record
      writeTaskDatabase(first.storageRoot, document)
      const host = await mountHost(t, { storageRoot: first.storageRoot, activate: false })
      const failed = host.own(host.ctx.plugin(tasksHost))
      await assert.rejects(failed.await(), /inconsistent record identity|duplicate creation request/)
      assert.deepEqual(readTaskDatabase(first.storageRoot), document)
      await failed.dispose()
      writeTaskDatabase(first.storageRoot, original)
      const repaired = host.own(host.ctx.plugin(tasksHost))
      await repaired.await()
      assert.equal(success(await callTask(host.rpc, 'list', {})).tasks.length, 1)
      await host.shutdown()
    })
  }
})

test('store close drains accepted operations and rejects new operations', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let writes = 0
  const storage = await mountStorage(t, { wrapUnit: unit => interceptPut(unit, async write => {
    if (++writes === 1) { entered.resolve(); await release.promise }
    await write()
  }) })
  const domain = await storage.ctx.get('storageDomain').open(taskDomain)
  const store = createTaskStore(domain, limits)
  t.after(() => store.close())
  const first = store.execute('create', { requestId: 'drain-one', title: 'First' })
  await entered.promise
  const second = store.execute('create', { requestId: 'drain-two', title: 'Second' })
  const closing = store.close()
  assert.equal(store.close(), closing)
  try {
    assert.equal(errorCode(await store.execute('list', {})), 'tasks/unavailable')
  } finally {
    release.resolve()
  }
  success(await first)
  success(await second)
  await closing
  const reopened = await storage.ctx.get('storageDomain').open(taskDomain)
  assert.equal(reopened.table('tasks').size, 2)
  await reopened.close()
})

test('cancellation before a queued operation runs does not create its task', async t => {
  const entered = Promise.withResolvers()
  const release = Promise.withResolvers()
  let writes = 0
  const storage = await mountStorage(t, { wrapUnit: unit => interceptPut(unit, async write => {
    if (++writes === 1) { entered.resolve(); await release.promise }
    await write()
  }) })
  const domain = await storage.ctx.get('storageDomain').open(taskDomain)
  const store = createTaskStore(domain, limits)
  t.after(() => store.close())
  const first = store.execute('create', { requestId: 'active', title: 'Active' })
  await entered.promise
  const abort = new AbortController()
  const cancelled = store.execute('create', { requestId: 'cancelled', title: 'Cancelled' }, abort.signal)
  abort.abort()
  release.resolve()
  success(await first)
  assert.equal(errorCode(await cancelled), 'gateway/cancelled')
  assert.equal(success(await store.execute('list', {})).tasks.length, 1)
  await store.close()
})
