import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { createTaskStore } from '../task-store.js'
import { createTaskSessions } from '../task-sessions.js'
import { taskDomain } from '../task-schema.js'
import { callTask, mountStorage, mountHost, mountClient, waitForState } from './fixtures.mjs'

const limits = { maxTitleLength: 200, maxBriefLength: 20000, maxTasks: 10000 }
const value = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const missing = () => Object.assign(new Error('Missing'), { code: 'session/not-found' })
function sessionFixture() {
  const rows = new Map(), receipts = new Set(), calls = { create: 0, prompt: 0, admitted: 0, select: 0 }
  let rejectModel = false
  const controller = {
    modelCatalog: async () => ({ groups: [{ id: 'test', name: 'Test', models: [{ id: 'local', name: 'Local' }] }], failures: [] }),
    async state({ sessionId }) { if (!rows.has(sessionId)) throw missing(); return rows.get(sessionId) },
    async create({ sessionId }) { calls.create++; rows.set(sessionId, { cursor: 0, running: false, pendingInput: [], queue: [], active: true }); return { sessionId } },
    async selectModel() { calls.select++; if (rejectModel) throw new Error('Unavailable') },
    async prompt({ sessionId, requestId }) {
      calls.prompt++
      if (!receipts.has(requestId)) { calls.admitted++; receipts.add(requestId) }
      rows.get(sessionId).cursor++
      return { accepted: true }
    },
  }
  return { controller, rows, calls, rejectModel: value => { rejectModel = value },
    query: { observeSession: async () => ({ events: [], [Symbol.dispose]() {} }) } }
}
async function storageStore(t, fixture, options = {}) {
  const mounted = await mountStorage(t, options)
  mounted.ctx.provide('sessionController', fixture.controller)
  const sessions = createTaskSessions(mounted.ctx)
  const domain = await mounted.ctx.storageDomain.open(taskDomain)
  const store = createTaskStore(domain, limits, () => {}, { validate: async () => undefined }, sessions)
  t.after(async () => { sessions.close(); await store.close() })
  return { store, ...mounted }
}
const inputFor = task => ({ taskId: task.id, expectedRevision: task.revision, requestId: randomUUID(), content: '执行说明', replaceActive: false })

test('concurrent launch retries create one Session, admit one prompt, bind and preserve manual done', async t => {
  const fixture = sessionFixture(), { store } = await storageStore(t, fixture)
  const task = value(await store.execute('create', { requestId: 'task', title: 'Task', stage: 'done' })).task
  const input = inputFor(task)
  const results = await Promise.all(Array.from({ length: 6 }, () => store.execute('launch', input)))
  const final = value(results[0]).task
  assert.equal(final.activeSessionId, final.launch.sessionId)
  assert.equal(final.stage, 'done')
  assert(results.every(result => value(result).sessionId === final.activeSessionId))
  assert.equal(fixture.calls.create, 1)
  assert.equal(fixture.calls.admitted, 1)
  assert.equal((await store.execute('launch', { ...input, content: 'changed' })).error.code, 'tasks/request-conflict')
  const next = inputFor(final)
  assert.equal((await store.execute('launch', next)).error.code, 'tasks/session-exists')
  fixture.rows.get(final.activeSessionId).running = true
  assert.equal((await store.execute('launch', { ...next, replaceActive: true })).error.code, 'tasks/session-busy')
  fixture.rows.get(final.activeSessionId).running = false
  fixture.rows.get(final.activeSessionId).pendingInput = ['question']
  assert.equal((await store.execute('launch', { ...next, replaceActive: true })).error.code, 'tasks/session-busy')
  fixture.rows.get(final.activeSessionId).pendingInput = []
  fixture.rows.get(final.activeSessionId).queue = [{ id: 'queued' }]
  assert.equal((await store.execute('launch', { ...next, replaceActive: true })).error.code, 'tasks/session-busy')
  fixture.rows.get(final.activeSessionId).queue = []
  const replaced = value(await store.execute('launch', { ...next, replaceActive: true })).task
  assert.deepEqual(replaced.previousSessionIds, [final.activeSessionId])
  assert.notEqual(replaced.activeSessionId, final.activeSessionId)
  assert.equal(value(await store.execute('launch', input)).task.activeSessionId, replaced.activeSessionId)
})

test('model failure retains the created Session and recovery survives reopening the domain', async t => {
  const fixture = sessionFixture(), first = await storageStore(t, fixture)
  const task = value(await first.store.execute('create', { requestId: 'task', title: 'Task' })).task
  const input = { ...inputFor(task), model: { provider: 'test', model: 'local' } }
  fixture.rejectModel(true)
  assert.equal((await first.store.execute('launch', input)).error.code, 'tasks/launch-failed')
  const pending = value(await first.store.execute('list', {})).tasks[0]
  assert.equal(pending.activeSessionId, undefined)
  assert.equal(pending.launch.phase, 'created')
  await first.store.close()
  const second = await storageStore(t, fixture, { storageRoot: first.storageRoot })
  fixture.rejectModel(false)
  const recovered = value(await second.store.execute('resume-launch', { taskId: task.id, requestId: input.requestId })).task
  assert.equal(recovered.activeSessionId, pending.launch.sessionId)
  assert.equal(recovered.stage, 'doing')
  assert.equal(fixture.calls.create, 1)
  assert.equal(fixture.calls.admitted, 1)
})

test('failure of the final binding write replays prompt identity without duplicate admission', async t => {
  const fixture = sessionFixture()
  let fail = true
  const { store } = await storageStore(t, fixture, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => {
      if (fixture.calls.admitted && fail) { fail = false; throw new Error('Disk unavailable') }
      return target.putRecord(...args)
    }
    const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item
  } }) })
  const task = value(await store.execute('create', { requestId: 'task', title: 'Task' })).task
  const input = inputFor(task)
  assert.equal((await store.execute('launch', input)).error.code, 'tasks/persistence-failed')
  assert.equal(value(await store.execute('list', {})).tasks[0].launch.phase, 'sending')
  const sending = value(await store.execute('list', {})).tasks[0]
  assert.equal((await store.execute('abandon-launch', { taskId: task.id, requestId: input.requestId, expectedRevision: sending.revision })).error.code, 'tasks/launch-pending')
  const recovered = value(await store.execute('resume-launch', { taskId: task.id, requestId: input.requestId })).task
  assert.equal(recovered.launch.phase, 'complete')
  assert.equal(fixture.calls.create, 1)
  assert.equal(fixture.calls.prompt, 2)
  assert.equal(fixture.calls.admitted, 1)
})

test('prepared receipt recovers a Session created before its progress write failed', async t => {
  const fixture = sessionFixture()
  let fail = true
  const { store } = await storageStore(t, fixture, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => {
      if (fixture.calls.create && fail) { fail = false; throw new Error('Progress write failed') }
      return target.putRecord(...args)
    }
    const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item
  } }) })
  const task = value(await store.execute('create', { requestId: 'task', title: 'Task' })).task
  const input = inputFor(task)
  assert.equal((await store.execute('launch', input)).ok, false)
  assert.equal(value(await store.execute('list', {})).tasks[0].launch.phase, 'prepared')
  value(await store.execute('launch', input))
  assert.equal(fixture.calls.create, 1)
})

test('an uncertain launch commit quarantines retries until reopening, then recovers the same Session', async t => {
  const fixture = sessionFixture()
  let fail = true
  const first = await storageStore(t, fixture, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (...args) => {
      await target.putRecord(...args)
      if (fixture.calls.admitted && fail) { fail = false; throw new StorageError('unknown-state', 'Lost binding acknowledgement') }
    }
    const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item
  } }) })
  const task = value(await first.store.execute('create', { requestId: 'task', title: 'Task' })).task
  const input = inputFor(task)
  assert.equal((await first.store.execute('launch', input)).error.code, 'tasks/persistence-unknown')
  assert.equal((await first.store.execute('launch', input)).error.code, 'tasks/persistence-unknown')
  assert.equal((await first.store.execute('resume-launch', { taskId: task.id, requestId: input.requestId })).error.code, 'tasks/persistence-unknown')
  await first.store.close()
  const second = await storageStore(t, fixture, { storageRoot: first.storageRoot })
  assert.equal(value(await second.store.execute('launch', input)).task.launch.phase, 'complete')
  assert.equal(fixture.calls.create, 1)
  assert.equal(fixture.calls.admitted, 1)
})

test('an undelivered launch can end while retaining history; old retries never admit its prompt', async t => {
  const fixture = sessionFixture(), { store } = await storageStore(t, fixture)
  const task = value(await store.execute('create', { requestId: 'task', title: 'Task' })).task
  fixture.rejectModel(true)
  const input = { ...inputFor(task), model: { provider: 'test', model: 'local' } }
  assert.equal((await store.execute('launch', input)).ok, false)
  const pending = value(await store.execute('list', {})).tasks[0]
  const endInput = { taskId: task.id, requestId: input.requestId, expectedRevision: pending.revision }
  const ended = value(await store.execute('abandon-launch', endInput)).task
  assert.equal(ended.launch.phase, 'abandoned')
  assert.deepEqual(ended.previousSessionIds, [pending.launch.sessionId])
  assert.equal(value(await store.execute('abandon-launch', endInput)).task.revision, ended.revision)
  assert.equal((await store.execute('launch', input)).error.code, 'tasks/launch-abandoned')
  assert.equal(fixture.calls.admitted, 0)
  const next = value(await store.execute('launch', inputFor(ended))).task
  assert.notEqual(next.activeSessionId, pending.launch.sessionId)
  assert.deepEqual(next.previousSessionIds, [pending.launch.sessionId])
})

test('lost launch reply survives Client reload and opens the same bound conversation', async t => {
  const fixture = sessionFixture()
  const host = await mountHost(t, { sessionController: fixture.controller, sessionQuery: fixture.query })
  let drop = true
  const transport = async (...args) => {
    const result = await host.rpc.call(...args)
    if (args[2].operation === 'launch' && drop) { drop = false; throw new Error('Lost reply') }
    return result
  }
  const opened = []
  const first = await mountClient(t, { call: transport }, { navigate: id => opened.push(id) })
  await waitForState(first.tasks, 'ready')
  const task = value(await callTask(host.rpc, 'create', { requestId: 'task', title: 'Task', brief: 'Instructions' })).task
  await first.tasks.refresh()
  first.tasks.openLaunch(task.id)
  assert.equal(first.tasks.getSnapshot().launchForm.content, 'Task\n\nInstructions')
  await first.tasks.launchTask()
  assert.equal(first.tasks.getSnapshot().launchForm.errorCode, 'tasks/launch-unknown')
  assert.equal(fixture.calls.admitted, 1)
  await first.plugin.dispose()
  const second = await mountClient(t, { call: transport }, { sessionStorage: first.sessionStorage, navigate: id => opened.push(id) })
  await waitForState(second.tasks, 'ready')
  await second.tasks.launchTask()
  assert.equal(opened.length, 1)
  assert.equal(fixture.calls.create, 1)
  assert.equal(fixture.calls.admitted, 1)
  assert.equal(second.tasks.getSnapshot().launchForm.retryInput, undefined)
})

test('status sampling catches pending-input-only changes, errors, missing sessions, and disposes observers', async t => {
  const fixture = sessionFixture(), { ctx, store } = await storageStore(t, fixture)
  let errorEnd = false, samples = 0
  ctx.provide('sessionQuery', { observeSession: async () => ({ events: errorEnd ? [{ type: 'turn/end', data: { reason: { kind: 'error' } } }] : [], [Symbol.dispose]() {} }) })
  const original = fixture.controller.state
  fixture.controller.state = async input => { samples++; return original(input) }
  const task = value(await store.execute('create', { requestId: 'task', title: 'Task' })).task
  const launched = value(await store.execute('launch', inputFor(task))).task
  const events = []
  const unsubscribe = await store.watch(event => { if (event.type === 'status') events.push(event.status.status) })
  t.after(unsubscribe)
  const sessions = createTaskSessions(ctx)
  const dispose = await sessions.watch(store, 15)
  t.after(() => { dispose(); sessions.close() })
  const wait = async status => {
    for (let i = 0; i < 100 && events.at(-1) !== status; i++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(events.at(-1), status)
  }
  await wait('idle')
  const state = fixture.rows.get(launched.activeSessionId)
  state.running = true; await wait('running')
  state.pendingInput = ['question']; await wait('question')
  state.pendingInput = ['approval', 'question']; await wait('approval')
  state.pendingInput = []; state.running = false; state.cursor++; errorEnd = true; await wait('error')
  ctx.provide('workspaceRegistry', { archivedSessionIds: [launched.activeSessionId] })
  await wait('archived')
  ctx.get('workspaceRegistry').archivedSessionIds.length = 0
  state.cursor++; errorEnd = false; await wait('idle')
  fixture.rows.delete(launched.activeSessionId); await wait('missing')
  dispose(); sessions.close()
  const before = samples
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(samples, before)
})

test('v4 opens v2 records without changing old task fields or creation identity', async t => {
  const fixture = sessionFixture(), first = await storageStore(t, fixture)
  const task = value(await first.store.execute('create', { requestId: 'old', title: 'Old task' })).task
  await first.store.close()
  const path = join(first.storageRoot, 'tasks.json')
  const disk = JSON.parse(await readFile(path, 'utf8')); disk.unit.version = 2
  await writeFile(path, JSON.stringify(disk))
  const second = await storageStore(t, fixture, { storageRoot: first.storageRoot })
  assert.deepEqual(value(await second.store.execute('create', { requestId: 'old', title: 'Old task' })).task, task)
})
