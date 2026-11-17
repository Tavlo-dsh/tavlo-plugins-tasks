import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { callTask, mountClient, mountHost, waitForState } from './fixtures.mjs'

const create = (host, requestId = 'delete-test') => callTask(host.rpc, 'create', { requestId, title: '任务正文将被移除', brief: '任务描述' }).then(result => {
  assert(result.ok); return result.value.task
})
const input = task => ({ taskId: task.id, expectedRevision: task.revision })
async function until(predicate) {
  const deadline = Date.now() + 4000
  while (!predicate()) { if (Date.now() > deadline) throw new Error('Timed out'); await setImmediate() }
}

test('delete removes task content durably, is replayable, releases capacity and never revives old creation requests', async t => {
  const first = await mountHost(t, { config: { maxTasks: 1 } })
  const task = await create(first)
  assert((await callTask(first.rpc, 'delete', input(task))).ok)
  assert.deepEqual((await callTask(first.rpc, 'list', {})).value.tasks, [])
  const disk = JSON.parse(await readFile(join(first.storageRoot, 'tasks.json'), 'utf8'))
  assert.equal(disk.unit.version, 4)
  assert.deepEqual(Object.keys(disk.tables.tasks[task.id]).sort(), ['_deleted', 'id'])
  assert(!JSON.stringify(disk).includes(task.title))
  assert((await callTask(first.rpc, 'delete', input(task))).ok)
  await create(first, 'next-task')
  await first.shutdown()
  const next = await mountHost(t, { storageRoot: first.storageRoot })
  assert.equal((await callTask(next.rpc, 'list', {})).value.tasks.length, 1)
  assert((await callTask(next.rpc, 'delete', input(task))).ok)
  assert.equal((await callTask(next.rpc, 'create', { requestId: 'delete-test', title: task.title, brief: task.brief })).error.code, 'tasks/deleted')
  assert.equal((await callTask(next.rpc, 'set-stage', { ...input(task), stage: 'doing' })).error.code, 'tasks/not-found')
  assert.equal((await callTask(next.rpc, 'launch', { ...input(task), requestId: 'late-launch', content: '不能再启动' })).error.code, 'tasks/not-found')
})

test('delete validates inputs, rejects stale revisions and serializes competing changes', async t => {
  const host = await mountHost(t)
  const task = await create(host)
  for (const invalid of [{ taskId: task.id }, { ...input(task), expectedRevision: 0 }, { ...input(task), extra: true }]) {
    assert.equal((await callTask(host.rpc, 'delete', invalid)).error.code, 'tasks/bad-request')
  }
  const results = await Promise.all([
    callTask(host.rpc, 'set-stage', { ...input(task), stage: 'done' }),
    callTask(host.rpc, 'delete', input(task)),
  ])
  assert.equal(results.filter(result => result.ok).length, 1)
  assert(['tasks/revision-conflict', 'tasks/not-found'].includes(results.find(result => !result.ok).error.code))
})

test('failed deletion keeps memory and disk; uncertain commit quarantines until reopen', async t => {
  let failure
  const host = await mountHost(t, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (...args) => {
      if (failure === 'rejected') throw new Error('disk full')
      await target.putRecord(...args)
      if (failure === 'unknown') throw new StorageError('unknown-state', 'commit acknowledgement lost')
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const task = await create(host)
  const before = await readFile(join(host.storageRoot, 'tasks.json'), 'utf8')
  failure = 'rejected'
  assert.equal((await callTask(host.rpc, 'delete', input(task))).error.code, 'tasks/persistence-failed')
  assert.deepEqual((await callTask(host.rpc, 'list', {})).value.tasks, [task])
  assert.equal(await readFile(join(host.storageRoot, 'tasks.json'), 'utf8'), before)
  failure = 'unknown'
  assert.equal((await callTask(host.rpc, 'delete', input(task))).error.code, 'tasks/persistence-unknown')
  assert.equal((await callTask(host.rpc, 'list', {})).error.code, 'tasks/persistence-unknown')
  await host.shutdown()
  const next = await mountHost(t, { storageRoot: host.storageRoot })
  assert.deepEqual((await callTask(next.rpc, 'list', {})).value.tasks, [])
  assert((await callTask(next.rpc, 'delete', input(task))).ok)
})

test('v4 reads v3 tasks, preserves sessions and blocks deleting unresolved launches', async t => {
  const first = await mountHost(t)
  const task = await create(first)
  await first.shutdown()
  const file = join(first.storageRoot, 'tasks.json')
  const disk = JSON.parse(await readFile(file, 'utf8'))
  disk.unit.version = 3
  const sessionId = 'c02685f4-fcca-46b3-b43b-acf80d32efe4'
  const receipt = { input: { ...input(task), requestId: 'saved-launch', content: 'saved', replaceActive: false }, sessionId, phase: 'sending' }
  Object.assign(disk.tables.tasks[task.id], { launch: receipt, _launches: [receipt], activeSessionId: sessionId })
  await writeFile(file, JSON.stringify(disk))
  const next = await mountHost(t, { storageRoot: first.storageRoot })
  assert.equal((await callTask(next.rpc, 'delete', input(task))).error.code, 'tasks/launch-pending')
  await next.shutdown()
  receipt.phase = 'complete'
  await writeFile(file, JSON.stringify(disk))
  let sessionCalls = 0
  const final = await mountHost(t, { storageRoot: first.storageRoot, sessionController: new Proxy({}, { get() { return () => { sessionCalls++ } } }) })
  assert((await callTask(final.rpc, 'delete', input(task))).ok)
  // Status reads may occur during activation; no mutation API is used by deletion.
  assert(sessionCalls <= 1)
})

test('deletion synchronizes two clients, closes stale task dialogs and preserves unrelated drafts', async t => {
  const host = await mountHost(t)
  const task = await create(host)
  let streams = 0
  const fetchEvents = (url, init) => { streams++; return host.fetchAuthenticated(url, init) }
  const first = await mountClient(t, host.rpc, { fetch: fetchEvents })
  const second = await mountClient(t, host.rpc, { fetch: fetchEvents })
  await until(() => first.tasks.getSnapshot().sync === 'live' && second.tasks.getSnapshot().sync === 'live')
  second.tasks.openDetails(task.id)
  second.tasks.editForm('title', '保留草稿')
  first.tasks.openDelete(task.id)
  await first.tasks.deleteTask()
  await until(() => second.tasks.getSnapshot().tasks.length === 0)
  assert.equal(second.tasks.getSnapshot().detailId, undefined)
  assert.equal(second.tasks.getSnapshot().form.title, '保留草稿')
  assert.equal(streams, 2)
})

test('lost delete reply retries the same revision and duplicate clicks are suppressed', async t => {
  const host = await mountHost(t)
  const task = await create(host)
  let finish, deletes = 0
  const inputs = []
  const rpc = { async call(channel, endpoint, payload, signal) {
    if (payload.operation !== 'delete') return host.rpc.call(channel, endpoint, payload, signal)
    deletes++; inputs.push(JSON.stringify(payload.input))
    const result = await host.rpc.call(channel, endpoint, payload, signal)
    if (deletes === 1) return new Promise((_resolve, reject) => { finish = () => reject(new Error('lost reply')) })
    return result
  } }
  const client = await mountClient(t, rpc)
  await waitForState(client.tasks, 'ready')
  client.tasks.openDelete(task.id)
  const pending = client.tasks.deleteTask()
  await until(() => finish)
  await client.tasks.deleteTask()
  client.tasks.closeDelete()
  assert.equal(deletes, 1)
  assert(client.tasks.getSnapshot().deletion.pending)
  assert.equal(client.tasks.getSnapshot().tasks.length, 1)
  finish(); await pending
  assert.equal(client.tasks.getSnapshot().deletion.errorCode, 'tasks/delete-unknown')
  await client.tasks.deleteTask()
  assert.equal(inputs[0], inputs[1])
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
  const before = client.tasks.getSnapshot()
  await client.plugin.dispose()
  client.tasks.openDelete(task.id); await client.tasks.deleteTask()
  assert.equal(client.tasks.getSnapshot(), before)
})

test('disposing a client with deletion pending suppresses its late response', async t => {
  const host = await mountHost(t)
  const task = await create(host)
  let finish
  const client = await mountClient(t, { call(channel, endpoint, payload, signal) {
    if (payload.operation === 'delete') return new Promise(resolve => { finish = resolve })
    return host.rpc.call(channel, endpoint, payload, signal)
  } })
  await waitForState(client.tasks, 'ready')
  client.tasks.openDelete(task.id)
  const pending = client.tasks.deleteTask()
  const before = client.tasks.getSnapshot()
  await client.plugin.dispose()
  finish({ ok: true, value: { taskId: task.id, revision: task.revision + 1 } })
  await pending
  assert.equal(client.tasks.getSnapshot(), before)
})
