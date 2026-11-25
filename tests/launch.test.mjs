import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
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

async function boundTask(store) {
  const task = value(await store.execute('create', { title: 'Fork source', requestId: randomUUID() })).task
  return value(await store.execute('launch', inputFor(task))).task
}
const forkInput = task => ({ ...inputFor(task), replaceActive: true, forkFromSessionId: task.activeSessionId, content: 'child only' })
const resumeInput = ({ taskId, requestId }) => ({ taskId, requestId })
const taskOf = async (store, taskId) => value(await store.execute('get', { taskId })).task
const expectCode = async (result, code) => assert.equal((await result).error?.code, code)
function forkFixture() {
  const fixture = sessionFixture(), forks = [], prompts = [], children = []
  const prompt = fixture.controller.prompt
  fixture.controller.prompt = async input => { prompts.push(structuredClone(input)); return prompt(input) }
  fixture.controller.fork = async input => {
    forks.push({ ...input })
    const sessionId = 'session-' + randomUUID()
    fixture.rows.set(sessionId, structuredClone(fixture.rows.get(input.sessionId)))
    children.push(sessionId)
    return { sessionId }
  }
  return { ...fixture, forks, prompts, children }
}

test('archived active source forks natively twice; only children receive the new prompt and actual workspace wins', async t => {
  const fx = forkFixture(), { store, ctx } = await storageStore(t, fx)
  const parent = await boundTask(store), snapshot = structuredClone(fx.rows.get(parent.activeSessionId))
  const archived = [parent.activeSessionId], workspaceId = randomUUID()
  ctx.provide('workspaceRegistry', { archivedSessionIds: archived, list: () => [{ id: workspaceId, sessionIds: fx.children }] })
  const input = forkInput(parent), events = [], off = await store.watch(event => events.push(event))
  const [first, duplicate, competing] = await Promise.all([store.execute('launch', input), store.execute('launch', input), store.execute('launch', { ...input, requestId: randomUUID() })])
  off()
  const child = value(first).task; assert.deepEqual(value(duplicate), value(first)); assert.equal(competing.error.code, 'tasks/fork-source-changed')
  assert.deepEqual(fx.forks, [{ sessionId: parent.activeSessionId, allowMigration: false }])
  assert.equal(fx.calls.create, 1); assert.equal(child.activeSessionId, fx.children[0]); assert.equal(child.workspaceId, workspaceId)
  assert.deepEqual(fx.prompts.map(row => row.sessionId), [parent.activeSessionId, child.activeSessionId]); assert.deepEqual(fx.rows.get(parent.activeSessionId), snapshot)
  assert.deepEqual(archived, [parent.activeSessionId]); assert.deepEqual(child.previousSessionIds, [parent.activeSessionId])
  const progress = events.filter(event => event.type === 'upsert').map(event => event.task)
  assert.deepEqual(progress.map(task => task.launch.phase), ['forking', 'created', 'sending', 'complete'])
  assert(!Object.hasOwn(progress[0].launch, 'sessionId')); assert(progress.slice(0, -1).every(task => task.activeSessionId === parent.activeSessionId && !task.previousSessionIds.length))
  const grandchild = value(await store.execute('launch', forkInput(child))).task
  assert.deepEqual(grandchild.previousSessionIds, [parent.activeSessionId, child.activeSessionId]); assert.equal(fx.forks[1].sessionId, child.activeSessionId)
  const old = value(await store.execute('launch', input)); assert.equal(old.sessionId, child.activeSessionId); assert.equal(old.task.activeSessionId, grandchild.activeSessionId)
})

for (const condition of ['running', 'pendingInput', 'queue', 'unreadable']) test(`blank replacement preflight rejects ${condition} without creating or prompting`, async t => {
  const fx = sessionFixture(), { store } = await storageStore(t, fx), parent = await boundTask(store)
  const before = { ...fx.calls }
  const state = fx.rows.get(parent.activeSessionId)
  if (condition === 'running') state.running = true
  if (condition === 'pendingInput') state.pendingInput = ['question']
  if (condition === 'queue') state.queue = [{ id: 'queued' }]
  if (condition === 'unreadable') fx.controller.state = async () => { throw new Error('State unavailable') }
  await expectCode(store.execute('launch', { ...inputFor(parent), replaceActive: true }),
    condition === 'unreadable' ? 'tasks/launch-failed' : 'tasks/session-busy')
  assert.deepEqual(fx.calls, before)
  assert.deepEqual(await taskOf(store, parent.id), parent)
})

test('fork preflight rejects stale, foreign, missing, busy or unsupported sources without a receipt', async t => {
  const fx = forkFixture(), { store } = await storageStore(t, fx), parent = await boundTask(store), input = forkInput(parent)
  const attempt = overrides => store.execute('launch', { ...input, ...overrides })
  await expectCode(attempt({ expectedRevision: 1 }), 'tasks/revision-conflict')
  await expectCode(attempt({ replaceActive: false }), 'tasks/session-exists')
  await expectCode(attempt({ forkFromSessionId: randomUUID() }), 'tasks/fork-source-changed')
  await expectCode(attempt({ workspaceId: randomUUID() }), 'tasks/bad-request')
  await expectCode(attempt({ agentPreset: 'override' }), 'tasks/bad-request')
  await expectCode(attempt({ taskId: 'session-' + parent.id }), 'tasks/bad-request')
  fx.rows.get(parent.activeSessionId).running = true
  await expectCode(attempt(), 'tasks/session-busy'); fx.rows.delete(parent.activeSessionId)
  await expectCode(attempt(), 'tasks/fork-unavailable'); delete fx.controller.fork
  await expectCode(attempt(), 'tasks/fork-unavailable'); assert.equal(fx.forks.length, 0)
  assert.deepEqual(await taskOf(store, parent.id), parent)
})

for (const code of ['session/fork-unavailable', 'session/migration-required', 'session/not-found']) {
  test(`known fork refusal ${code} releases task without writing a child to history`, async t => {
    const fx = forkFixture(), { store } = await storageStore(t, fx), parent = await boundTask(store), input = forkInput(parent); let calls = 0
    fx.controller.fork = async () => { calls++; throw Object.assign(new Error(), { code }) }
    await expectCode(store.execute('launch', input), 'tasks/fork-unavailable')
    const task = await taskOf(store, parent.id); assert.equal(task.launch.phase, 'abandoned'); assert(!task.launch.sessionId)
    assert.deepEqual(task.previousSessionIds, parent.previousSessionIds); assert.equal(task.activeSessionId, parent.activeSessionId)
    await expectCode(store.execute('launch', input), 'tasks/launch-abandoned'); assert.equal(calls, 1); assert.equal(fx.prompts.length, 1)
    value(await store.execute('launch', { ...inputFor(task), replaceActive: true }))
  })
}

for (const failure of ['lost-reply', 'invalid-result', 'parent-id', 'untrusted-detail', 'child-write', 'marker-ack']) {
  test(`fork with no durable target (${failure}) never retries, guesses or sends after restart`, async t => {
    const fx = forkFixture(), native = fx.controller.fork
    let armed = false
    fx.controller.fork = async input => {
      const child = await native(input)
      if (failure === 'lost-reply') throw new Error('Disconnected')
      if (failure === 'invalid-result') return { sessionId: 'session-invalid' }
      if (failure === 'parent-id') return { sessionId: input.sessionId }
      if (failure === 'untrusted-detail') throw Object.assign(new Error(), { code: 'gateway/internal', details: child })
      return child
    }
    const first = await storageStore(t, fx, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
      if (key === 'putRecord') return async (...args) => {
        if (armed && failure === 'child-write' && fx.forks.length) throw new Error('Disk full')
        await target.putRecord(...args)
        if (armed && failure === 'marker-ack') throw new StorageError('unknown-state', 'Lost marker acknowledgement')
      }
      const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item
    } }) })
    const parent = await boundTask(first.store), input = forkInput(parent); armed = true
    await expectCode(first.store.execute('launch', input), failure === 'marker-ack' ? 'tasks/persistence-unknown' : 'tasks/fork-unknown')
    await first.store.close(); const { store } = await storageStore(t, fx, { storageRoot: first.storageRoot })
    const task = await taskOf(store, parent.id); assert.equal(task.launch.phase, 'forking'); assert(!Object.hasOwn(task.launch, 'sessionId'))
    await expectCode(store.execute('launch', input), 'tasks/fork-unknown'); await expectCode(store.execute('resume-launch', resumeInput(input)), 'tasks/fork-unknown')
    await expectCode(store.execute('launch', forkInput(task)), 'tasks/launch-pending'); await expectCode(store.execute('launch', { ...input, content: 'changed' }), 'tasks/request-conflict')
    const ended = value(await store.execute('abandon-launch', { ...resumeInput(input), expectedRevision: task.revision })).task
    assert.deepEqual(ended.previousSessionIds, parent.previousSessionIds); assert.equal(ended.activeSessionId, parent.activeSessionId); assert(!ended.launch.sessionId)
    await expectCode(store.execute('launch', input), 'tasks/launch-abandoned'); assert.equal(fx.prompts.length, 1); assert.equal(fx.calls.create, 1)
    assert.equal(fx.forks.length, failure === 'marker-ack' ? 0 : 1)
  })
}

test('attachment failure saves the real child, repairs only its workspace, and replays prompt admission after binding write failure', async t => {
  const fx = forkFixture(), native = fx.controller.fork, workspaceId = randomUUID(), attached = []
  fx.controller.fork = async input => { const child = await native(input); throw Object.assign(new Error(), { code: 'session/workspace-attach-failed', details: { ...child, workspaceId } }) }
  const first = await storageStore(t, fx), parent = await boundTask(first.store), input = forkInput(parent)
  await expectCode(first.store.execute('launch', input), 'tasks/fork-attach-failed')
  const pending = await taskOf(first.store, parent.id); assert.equal(pending.launch.sessionId, fx.children[0]); assert.equal(pending.launch.phase, 'created'); assert(!Object.hasOwn(pending.launch, 'attachWorkspaceId'))
  await first.store.close(); let fail = true
  const { store, ctx } = await storageStore(t, fx, { storageRoot: first.storageRoot, wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => { if (fx.calls.admitted === 2 && fail) { fail = false; throw new Error('Disk full') }; return target.putRecord(...args) }
    const item = Reflect.get(target, key); return typeof item === 'function' ? item.bind(target) : item
  } }) })
  const resume = () => store.execute('resume-launch', resumeInput(input))
  await expectCode(resume(), 'tasks/fork-attach-failed'); assert.equal(fx.prompts.length, 1)
  const workspace = { id: workspaceId, sessionIds: attached, attachSession: async id => attached.push(id) }
  ctx.provide('workspaceRegistry', { list: () => [workspace], get: id => id === workspaceId && workspace })
  await expectCode(resume(), 'tasks/persistence-failed'); const sending = await taskOf(store, parent.id)
  assert.equal(sending.launch.phase, 'sending'); assert.equal(sending.activeSessionId, parent.activeSessionId)
  assert.equal(value(await resume()).task.workspaceId, workspaceId); assert.deepEqual(attached, fx.children)
  assert.deepEqual(fx.prompts[1], fx.prompts[2]); assert.equal(fx.prompts[1].sessionId, fx.children[0]); assert.equal(fx.calls.admitted, 2); assert.equal(fx.forks.length, 1)
})

test('connector intake, interrupted user launch, Agent handoff and manual completion share one identity', async context => {
  const fixture = sessionFixture(), host = await mountHost(context, { sessionController: fixture.controller, sessionQuery: fixture.query })
  const service = host.ctx.get('taskService')
  const externalRef = { provider: 'fixture', connectionId: randomUUID(), scopeId: 'project', objectType: 'issue', objectId: '123' }
  const input = { requestId: 'connector-intake', title: 'F5 handoff', externalRef }
  const task = value(await service.execute('create', input)).task
  const launch = { ...inputFor(task), model: { provider: 'test', model: 'local' } }
  fixture.rejectModel(true)
  assert.equal((await callTask(host.rpc, 'launch', launch)).error.code, 'tasks/launch-failed')
  fixture.rejectModel(false)
  const resume = { taskId: task.id, requestId: launch.requestId }
  const bound = value(await callTask(host.rpc, 'resume-launch', resume))
  assert.equal(bound.task.stage, 'doing'); assert.equal(bound.task.activeSessionId, bound.sessionId)
  assert.deepEqual(value(await callTask(host.rpc, 'resume-launch', resume)), bound)
  const agent = new Client({ name: 'f5-consumer', version: '1' })
  try {
    await agent.connect(new StreamableHTTPClientTransport(new URL('/api/dsh-plugin-tasks/mcp', host.origin), { fetch: host.fetchAuthenticated }))
    const comment = await agent.callTool({ name: 'tasks_comment', arguments: { taskId: task.id, requestId: 'agent-handoff', text: 'Ready for review' } })
    assert(!comment.isError)
  } finally { await agent.close() }
  const [current] = value(await service.execute('list', { externalRef })).tasks
  assert.equal(current.stage, 'doing')
  const done = value(await callTask(host.rpc, 'set-stage', { taskId: task.id, expectedRevision: current.revision, stage: 'done' })).task
  assert.equal(done.activeSessionId, bound.sessionId); assert(done.completedAt)
  assert.deepEqual(value(await service.execute('create', input)).task, done)
  const events = value(await service.execute('history', { taskId: task.id })).events
  for (const [kind, source] of [['created', 'service'], ['bound', 'rpc'], ['comment', 'agent'], ['completed', 'rpc']]) {
    assert(events.some(event => event.kind === kind && event.source === source), `${kind}/${source}`)
  }
  assert.equal(fixture.calls.create, 1); assert.equal(fixture.calls.admitted, 1)
})

test('launch commits the selected workspace once, resumes it, and can clear grouping', async t => {
  const fixture = sessionFixture(), { store, ctx } = await storageStore(t, fixture)
  const workspaceId = randomUUID(), otherId = randomUUID(), attached = []
  ctx.provide('workspaceRegistry', { get: id => ({ sessionIds: [], attachSession: async sessionId => attached.push([id, sessionId]) }) })
  const task = value(await store.execute('create', { requestId: 'workspace-task', title: 'Task', workspaceId: otherId })).task
  const input = { ...inputFor(task), workspaceId, model: { provider: 'test', model: 'local' } }
  fixture.rejectModel(true)
  assert.equal((await store.execute('launch', input)).error.code, 'tasks/launch-failed')
  assert.equal(value(await store.execute('get', { taskId: task.id })).task.workspaceId, otherId)
  fixture.rejectModel(false)
  const bound = value(await store.execute('resume-launch', { taskId: task.id, requestId: input.requestId })).task
  assert.equal(bound.workspaceId, workspaceId)
  assert.deepEqual(attached, [[workspaceId, bound.activeSessionId]])
  const changed = value(await store.execute('update', { taskId: task.id, expectedRevision: bound.revision, requestId: 'later-workspace', patch: { workspaceId: otherId } })).task
  assert.equal(value(await store.execute('launch', input)).task.workspaceId, otherId)
  const cleared = value(await store.execute('launch', { ...inputFor(changed), replaceActive: true })).task
  assert.equal(cleared.workspaceId, undefined)
})

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

test('a card menu restarts a bound task through the confirmation dialog and preserves the old conversation', async t => {
  const fixture = sessionFixture()
  const defaults = { provider: 'test', model: 'local', reasoningEffort: 'high' }
  fixture.controller.modelCatalog = async () => ({ default: defaults, failures: [], groups: [{ id: 'test', name: 'Test', models: [
    { id: 'local', name: 'Local', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
  ] }] })
  const selections = []
  fixture.controller.selectModel = async input => { selections.push(input) }
  const host = await mountHost(t, { sessionController: fixture.controller, sessionQuery: fixture.query })
  const task = value(await callTask(host.rpc, 'create', { title: 'Restart me', brief: 'Instructions', requestId: 'restart-card' })).task
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  const menuItem = () => client.render().find(node => node.type === 'button' && node.props.className === 'dsh-tasks-command'
    && node.props.children?.includes('新开一个对话'))
  assert.equal(menuItem(), undefined)

  const parent = value(await callTask(host.rpc, 'launch', inputFor(task))).task
  await client.tasks.refresh()
  await client.tasks.loadOptions()
  const menu = { open: true, querySelector: () => ({ focus() {} }) }
  const openFromCard = () => menuItem().props.onClick({ currentTarget: { closest: () => menu } })
  openFromCard()
  assert.equal(menu.open, false)
  assert.equal(client.tasks.getSnapshot().launchForm.newConversation, true)
  assert.equal(client.tasks.getSnapshot().launchForm.content, 'Restart me\n\nInstructions')
  client.tasks.closeLaunch()
  assert.equal(fixture.calls.create, 1)
  assert.equal(fixture.calls.admitted, 1)

  openFromCard()
  const rendered = client.render()
  const trigger = rendered.find(node => node.props?.role === 'combobox' && node.props['aria-label'] === '思考强度')
  assert.equal(trigger.type, 'button')
  const effort = rendered.find(node => node.props?.name === 'reasoningEffort')
  assert.equal(effort.props.type, 'hidden')
  assert.equal(effort.props.value, 'high')
  effort.props.onChange({ target: { value: 'low' } })
  await client.tasks.launchTask()
  const restarted = client.tasks.getSnapshot().tasks.find(row => row.id === task.id)
  assert.notEqual(restarted.activeSessionId, parent.activeSessionId)
  assert.deepEqual([...restarted.previousSessionIds], [parent.activeSessionId])
  assert.deepEqual(selections, [{ ...defaults, reasoningEffort: 'low', sessionId: restarted.activeSessionId }])
  assert.equal(fixture.calls.create, 2)
  assert.equal(fixture.calls.admitted, 2)
})

test('recovered launch stays on the board until the user opens its conversation', async t => {
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
  assert.deepEqual(opened, [])
  const bound = second.tasks.getSnapshot().tasks.find(row => row.id === task.id)
  const board = second.render()
  assert(!board.includes('开始任务'))
  assert(board.includes('打开对话'))
  assert(board.includes('标记完成'))
  second.tasks.openSession(bound.activeSessionId)
  assert.deepEqual(opened, [bound.activeSessionId])
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

test('v5 opens v2 records without changing old task fields or creation identity', async t => {
  const fixture = sessionFixture(), first = await storageStore(t, fixture)
  const task = value(await first.store.execute('create', { requestId: 'old', title: 'Old task' })).task
  await first.store.close()
  const path = join(first.storageRoot, 'tasks.json')
  const disk = JSON.parse(await readFile(path, 'utf8')); disk.unit.version = 2
  await writeFile(path, JSON.stringify(disk))
  const second = await storageStore(t, fixture, { storageRoot: first.storageRoot })
  assert.deepEqual(value(await second.store.execute('create', { requestId: 'old', title: 'Old task' })).task, task)
})
