import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { Service } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import * as tasksHost from '../index.js'
import { callTask, mountHost, readTaskDatabase, writeTaskDatabase } from './fixtures.mjs'

const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
async function code(result, expected) {
  const reply = await result
  assert.equal(reply.error?.code, expected, JSON.stringify(reply))
  return reply.error.details
}

function sessionFixture() {
  const sessions = new Set(), prompts = [], admitted = new Map()
  const effects = { attemptsToFail: 0 }
  const controller = {
    async state({ sessionId }) {
      if (!sessions.has(sessionId)) throw Object.assign(new Error('Missing session'), { code: 'session/not-found' })
      return { cursor: admitted.size, running: false, pendingInput: [], queue: [] }
    },
    async create({ sessionId }) { sessions.add(sessionId); return { sessionId } },
    async prompt(input) {
      const { sessionId, requestId } = input
      await this.state({ sessionId })
      prompts.push(structuredClone(input))
      if (effects.attemptsToFail) { effects.attemptsToFail--; throw Object.assign(new Error('Disconnected'), { code: 'session/test' }) }
      const key = `${sessionId}:${requestId}`
      if (!admitted.has(key)) admitted.set(key, structuredClone(input))
      return { accepted: true }
    },
  }
  return { controller, sessions, prompts, admitted, effects }
}

async function fixture(t, native = sessionFixture(), options = {}) {
  const host = await mountHost(t, { sessionController: native.controller, ...options })
  const tools = new Map()
  class ScopedTools extends Service {
    constructor(ctx) { super(ctx, 'tools') }
    register(tool) { return this.ctx.effect(() => { tools.set(tool.name, tool); return () => tools.delete(tool.name) }) }
  }
  await host.own(host.ctx.plugin(ScopedTools)).await()
  const rpc = (name, input) => callTask(host.rpc, name, input)
  const exec = (name, input, sessionId) => tools.get(`tasks_${name}`).execute(input, {
    signal: new AbortController().signal, ...(sessionId ? { agent: { id: sessionId } } : {}),
  })
  return {
    host, tools, rpc, exec, native,
    create: async (input = {}) => ok(await rpc('create', { title: 'Task', requestId: randomUUID(), ...input })).task,
    get: async taskId => ok(await rpc('get', { taskId })).task,
    stage: (task, stage) => rpc('set-stage', { taskId: task.id, stage, expectedRevision: task.revision }),
    update: (task, patch) => rpc('update', { taskId: task.id, patch, expectedRevision: task.revision, requestId: randomUUID() }),
    launch: (task, overrides) => rpc('launch', launchInput(task, overrides)),
    submit: (task, overrides, sessionId = task.activeSessionId) => exec('submit_delivery', submitInput(task, overrides), sessionId),
  }
}
const launchInput = (task, overrides = {}) => ({ taskId: task.id, expectedRevision: task.revision, requestId: randomUUID(), content: 'Do the work', ...overrides })
const submitInput = (task, overrides = {}) => ({ taskId: task.id, requestId: randomUUID(), summary: 'Result', ...overrides })
const reviewInput = (task, decision, feedback) => ({ taskId: task.id, expectedRevision: task.revision, deliveryId: task.delivery.id, requestId: randomUUID(), decision, ...(feedback !== undefined ? { feedback } : {}) })
const continueInput = ({ id, revision, delivery }) => ({ taskId: id, deliveryId: delivery.id, expectedRevision: revision })

function failWrites(check) {
  return unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => {
      if (check()) throw new Error('Injected disk write failure')
      return target.putRecord(...args)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } })
}

test('requirements trim, validate and clear; prerequisites block new launches but not stored receipts', async t => {
  const f = await fixture(t)
  let a = await f.create({ title: 'A' })
  let b = await f.create({ title: 'B', dependencyIds: [a.id.toUpperCase()], acceptanceCriteria: '   Tested output  \n' })
  const c = await f.create({ title: 'C', dependencyIds: [b.id] })
  assert.deepEqual(b.dependencyIds, [a.id]); assert.equal(b.acceptanceCriteria, 'Tested output')
  assert(!Object.hasOwn(a, 'acceptanceCriteria')); assert(!Object.hasOwn(a, 'delivery')); assert(!Object.hasOwn(a, 'dependencyIds'))
  await code(f.update(a, { dependencyIds: [a.id] }), 'tasks/dependency-cycle')
  await code(f.update(a, { dependencyIds: [c.id] }), 'tasks/dependency-cycle')
  await code(f.update(a, { dependencyIds: [b.id, b.id.toUpperCase()] }), 'tasks/bad-request')
  await code(f.update(a, { dependencyIds: Array.from({ length: 21 }, () => randomUUID()) }), 'tasks/bad-request')
  await code(f.update(a, { dependencyIds: ['not a UUID'] }), 'tasks/bad-request')
  await code(f.update(a, { dependencyIds: [randomUUID()] }), 'tasks/dependency-missing')
  await code(f.update(a, { acceptanceCriteria: 'x'.repeat(4001) }), 'tasks/bad-request')
  assert.deepEqual(await code(f.launch(b), 'tasks/dependencies-blocked'), { dependencyIds: [a.id] })
  assert.equal(f.native.prompts.length, 0)
  a = ok(await f.stage(a, 'done')).task
  const launch = launchInput(b, { content: 'x'.repeat(20202) })
  f.native.effects.attemptsToFail = 1
  await code(f.rpc('launch', launch), 'tasks/launch-failed')
  b = await f.get(b.id)
  b = ok(await f.update(b, { acceptanceCriteria: '  New criteria while resume pending ' })).task
  a = ok(await f.stage(a, 'todo')).task
  b = ok(await f.rpc('resume-launch', { taskId: b.id, requestId: launch.requestId })).task
  const [p1, p2] = f.native.prompts
  assert.deepEqual(p1, p2)
  assert(p1.content[0].text.startsWith(launch.content))
  for (const text of [b.id, 'tasks_submit_delivery', 'requestId', 'Tested output', 'do not claim it was submitted']) assert(p1.content[0].text.includes(text))
  assert(!p1.content[0].text.includes('New criteria'))
  assert.equal(ok(await f.rpc('launch', launch)).sessionId, b.activeSessionId)
  ok(await f.rpc('delete', { taskId: a.id, expectedRevision: a.revision }))
  assert.deepEqual(await code(f.launch(b, { replaceActive: true }), 'tasks/dependencies-blocked'), { dependencyIds: [a.id] })
  await code(f.update(c, { dependencyIds: [a.id] }), 'tasks/dependency-missing')
  // Unrelated edits and retaining an existing tombstone reference are allowed.
  b = ok(await f.update(b, { acceptanceCriteria: '  ', dependencyIds: [a.id] })).task
  assert(!Object.hasOwn(b, 'acceptanceCriteria'))
  b = ok(await f.update(b, { dependencyIds: [] })).task
  assert(!Object.hasOwn(b, 'dependencyIds'))
  b = ok(await f.launch(b, { replaceActive: true })).task
  assert.deepEqual(f.native.prompts.at(-1).content, [{ type: 'text', text: 'Do the work' }])
  await f.host.shutdown()
  const reopened = await fixture(t, f.native, { storageRoot: f.host.storageRoot })
  assert.deepEqual(await reopened.get(b.id), b)
  assert.equal(readTaskDatabase(f.host.storageRoot).unit.version, 8)
})

test('submission is native-only, session-scoped, bounded and durably idempotent; owner acceptance closes atomically', async t => {
  const f = await fixture(t)
  const unbound = await f.create({ title: 'Unbound' })
  const configured = await f.create({ acceptanceCriteria: 'Original snapshot' })
  const task = ok(await f.launch(configured)).task
  assert.equal(f.tools.get('tasks_submit_delivery').parameters.properties.sessionId, undefined)
  await code(f.exec('submit_delivery', submitInput(task)), 'tasks/delivery-session-mismatch')
  await code(f.submit(task, {}, randomUUID()), 'tasks/delivery-session-mismatch')
  await code(f.submit(unbound, {}, task.activeSessionId), 'tasks/delivery-session-mismatch')
  await code(f.rpc('submit-delivery', { ...submitInput(task), sessionId: task.activeSessionId }), 'tasks/not-found')
  await code(f.rpc('tasks_submit_delivery', submitInput(task)), 'tasks/not-found')
  await code(f.exec('set_stage', { taskId: task.id, expectedRevision: task.revision, stage: 'done' }, task.activeSessionId), 'tasks/delivery-required')
  const cleared = ok(await f.update(task, { acceptanceCriteria: '' })).task
  await code(f.exec('move', { taskId: task.id, expectedRevision: cleared.revision, columnId: 'stage:done' }), 'tasks/delivery-required')
  for (const input of [
    { sessionId: task.activeSessionId }, { summary: ' ' }, { summary: 'invalid\u0000' }, { verification: 'a'.repeat(4001) },
    ...['javascript:alert(1)', 'file:///tmp/result', 'https://name:pass@example.com', 'http://@example.org', 'https:///example.org', 'https://ex ample.org'].map(url => ({ links: [{ label: 'bad', url }] })),
    { links: Array.from({ length: 11 }, () => ({ label: 'Too many', url: 'https://example.com/' })) },
  ]) await code(f.submit(task, input), 'tasks/bad-request')
  const submit = submitInput(task, { summary: '  Implemented  ', verification: '5 tests passed', remaining: 'None', links: [{ label: ' Report ', url: 'https://example.org/report#results' }] })
  const reports = await Promise.all([f.exec('submit_delivery', submit, task.activeSessionId), f.exec('submit_delivery', submit, task.activeSessionId)])
  const [primary, replay] = reports.map(ok)
  const pending = primary.task
  assert.equal(replay.deliveryId, primary.deliveryId); assert.equal(replay.mutation.replayed, true)
  assert.equal(pending.stage, 'doing'); assert.equal(pending.delivery.status, 'pending'); assert.equal(pending.delivery.criteria, 'Original snapshot')
  assert.equal(pending.delivery.summary, 'Implemented'); assert.deepEqual(pending.delivery.links, [{ label: 'Report', url: 'https://example.org/report#results' }])
  assert(!Object.hasOwn(pending, '_deliveryReceipts'))
  await code(f.exec('submit_delivery', { ...submit, summary: 'Modified' }, task.activeSessionId), 'tasks/request-conflict')
  await code(f.submit(task), 'tasks/delivery-pending')
  await code(f.stage(pending, 'done'), 'tasks/delivery-review-required')
  await code(f.rpc('move', { taskId: task.id, expectedRevision: pending.revision, columnId: 'stage:done' }), 'tasks/delivery-review-required')
  await code(f.launch(pending, { replaceActive: true }), 'tasks/delivery-pending')
  await code(f.rpc('review-delivery', reviewInput(pending, 'return', '   ')), 'tasks/bad-request')
  const accept = reviewInput(pending, 'accept', 'Confirmed')
  await code(f.host.ctx.get('taskService').execute('review-delivery', accept), 'tasks/not-found')
  const connection = f.host.ctx.get('connection')
  const guest = connection.createPeer({ principal: { kind: 'guest' } })
  try {
    const method = 'dsh-plugin-tasks/rpc'
    const response = await connection.createSharedFetchHandler('/api').fetch(new Request(new URL(`/api/${method}`, f.host.origin), {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'guest-review', method, payload: { operation: 'review-delivery', input: accept } }),
    }), guest)
    assert.equal(response.status, 403)
  } finally { await guest.dispose() }
  await code(f.rpc('review-delivery', { ...accept, expectedRevision: pending.revision - 1 }), 'tasks/revision-conflict')
  const mcp = new Client({ name: 'delivery-test', version: '1' })
  await mcp.connect(new StreamableHTTPClientTransport(new URL('/api/dsh-plugin-tasks/mcp', f.host.origin), { fetch: f.host.fetchAuthenticated }))
  try {
    const toolList = (await mcp.listTools()).tools
    assert(toolList.find(tool => tool.name === 'tasks_create').inputSchema.properties.dependencyIds)
    assert(!toolList.some(tool => /delivery/.test(tool.name)))
    assert((await mcp.callTool({ name: 'tasks_submit_delivery', arguments: submit })).isError)
  } finally { await mcp.close() }
  const accepted = ok(await f.rpc('review-delivery', accept)).task
  assert.equal(accepted.stage, 'done'); assert.equal(accepted.columnId, 'stage:done')
  assert.equal(accepted.delivery.status, 'accepted'); assert.equal(accepted.completedAt, accepted.delivery.reviewedAt)
  assert.equal(accepted.revision, pending.revision + 1)
  assert.equal(ok(await f.stage(unbound, 'done')).task.stage, 'done')
  await code(f.submit(accepted), 'tasks/delivery-task-done')
  await f.host.shutdown()
  const reopened = await fixture(t, f.native, { storageRoot: f.host.storageRoot })
  const submissionReplay = ok(await reopened.exec('submit_delivery', submit, task.activeSessionId))
  assert.equal(submissionReplay.deliveryId, primary.deliveryId); assert.deepEqual(submissionReplay.task, accepted)
  assert.equal(ok(await reopened.rpc('review-delivery', accept)).mutation.replayed, true)
  await code(reopened.rpc('review-delivery', { ...accept, feedback: 'Changed' }), 'tasks/request-conflict')
  const activity = ok(await reopened.rpc('history', { taskId: task.id })).events.filter(event => event.kind.startsWith('delivery-'))
  assert.deepEqual(activity.map(({ kind, text, source }) => [kind, text, source]), [
    ['delivery-accepted', 'Confirmed', 'rpc'], ['delivery-submitted', 'Implemented', 'agent'],
  ])
})

test('return saves feedback without sending; continue retries prompt idempotently and resubmission or replacement retires stale evidence', async t => {
  let fail = false
  const f = await fixture(t, sessionFixture(), { wrapUnit: failWrites(() => fail) })
  const task = ok(await f.launch(await f.create())).task
  const first = ok(await f.submit(task)).task
  const moved = ok(await f.stage(first, 'todo')).task
  const returned = ok(await f.rpc('review-delivery', reviewInput(moved, 'return', '  Fix missing coverage  '))).task
  assert.equal(returned.stage, 'doing'); assert.equal(returned.delivery.status, 'returned')
  assert.equal(returned.delivery.feedback, 'Fix missing coverage')
  assert.equal(f.native.prompts.length, 1)
  await code(f.stage(returned, 'done'), 'tasks/delivery-review-required')
  await code(f.rpc('continue-delivery', { ...continueInput(returned), expectedRevision: returned.revision - 1 }), 'tasks/revision-conflict')
  await code(f.rpc('continue-delivery', { ...continueInput(returned), deliveryId: randomUUID() }), 'tasks/delivery-not-returned')
  f.native.effects.attemptsToFail = 1
  await code(f.rpc('continue-delivery', continueInput(returned)), 'tasks/delivery-continue-failed')
  assert.equal((await f.get(task.id)).delivery.continuedAt, undefined)
  fail = true
  await code(f.rpc('continue-delivery', continueInput(returned)), 'tasks/persistence-failed')
  fail = false
  assert.equal(f.native.admitted.size, 2)
  await f.host.shutdown()
  const second = await fixture(t, f.native, { storageRoot: f.host.storageRoot })
  const continued = ok(await second.rpc('continue-delivery', continueInput(returned))).task
  assert(continued.delivery.continuedAt); assert.equal(continued.activeSessionId, task.activeSessionId)
  assert.equal(f.native.sessions.size, 1); assert.equal(f.native.admitted.size, 2)
  const attempts = f.native.prompts.slice(1)
  assert.equal(attempts.length, 3)
  assert(attempts.every(input => JSON.stringify(input) === JSON.stringify(attempts[0])))
  assert(attempts[0].content[0].text.includes(returned.delivery.feedback))
  assert.deepEqual(ok(await second.rpc('continue-delivery', continueInput(returned))).task, continued)
  assert.equal(f.native.prompts.length, 4)
  const resubmitted = ok(await second.submit(continued, { summary: 'Added coverage', verification: '   ' })).task
  assert(!Object.hasOwn(resubmitted.delivery, 'verification'))
  assert.notEqual(resubmitted.delivery.id, first.delivery.id)
  assert.equal(resubmitted.delivery.status, 'pending'); assert.equal(resubmitted.delivery.sessionId, task.activeSessionId)
  const returnedAgain = ok(await second.rpc('review-delivery', reviewInput(resubmitted, 'return', 'Still missing a case'))).task
  f.native.effects.attemptsToFail = 1
  const replace = launchInput(returnedAgain, { replaceActive: true })
  await code(second.rpc('launch', replace), 'tasks/launch-failed')
  const waiting = await second.get(task.id)
  assert.equal(waiting.delivery.id, returnedAgain.delivery.id)
  await code(second.submit(waiting), 'tasks/launch-pending')
  const replaced = ok(await second.rpc('resume-launch', { taskId: task.id, requestId: replace.requestId })).task
  assert.notEqual(replaced.activeSessionId, task.activeSessionId)
  assert(!Object.hasOwn(replaced, 'delivery'))
  await code(second.submit(replaced, {}, task.activeSessionId), 'tasks/delivery-session-mismatch')
  const history = ok(await second.rpc('history', { taskId: task.id })).events.filter(event => event.kind === 'delivery-returned')
  assert.deepEqual(history.map(event => event.text), ['Still missing a case', 'Fix missing coverage'])
  assert.equal(ok(await second.stage(replaced, 'done')).task.stage, 'done')
})

test('native doing binds once without a launch; original delivery criteria survive edits, replacement and restart', async t => {
  const f = await fixture(t), creator = `session-${randomUUID()}`, other = `session-${randomUUID()}`
  f.native.sessions.add(creator)
  const input = { title: 'Working now', requestId: 'already-executing', stage: 'doing', acceptanceCriteria: 'Original' }
  let task = ok(await f.exec('create', input, creator)).task
  assert.equal(task.activeSessionId, creator); assert.equal(task.launch, undefined); assert.equal(task._creationSessionId, undefined)
  assert.deepEqual(ok(await f.exec('create', input, other)).task, task)
  assert.deepEqual(ok(await f.rpc('history', { taskId: task.id })).events.map(e => [e.kind, e.sessionId]), [['bound', creator], ['created', undefined]])
  assert.equal(f.native.prompts.length, 0); assert.equal(f.native.sessions.size, 1)
  task = ok(await f.update(task, { acceptanceCriteria: 'New' })).task
  await code(f.submit(task, {}, other), 'tasks/delivery-session-mismatch')
  task = ok(await f.submit(task)).task
  assert.equal(task.delivery.criteria, 'Original')
  await f.host.shutdown()
  const second = await fixture(t, f.native, { storageRoot: f.host.storageRoot })
  assert.deepEqual(await second.get(task.id), task)
  task = ok(await second.rpc('review-delivery', reviewInput(task, 'return', 'Revise'))).task
  task = ok(await second.launch(task, { replaceActive: true })).task
  assert.deepEqual(task.previousSessionIds, [creator]); assert.notEqual(task.activeSessionId, creator)
  await code(second.submit(task, {}, creator), 'tasks/delivery-session-mismatch')
  task = ok(await second.submit(task)).task
  assert.equal(task.delivery.criteria, 'New')
  await second.host.shutdown()
  const third = await fixture(t, f.native, { storageRoot: f.host.storageRoot })
  assert.deepEqual(await third.get(task.id), task)
})

test('persisted cycles and forged delivery-to-session relations fail closed at startup', async t => {
  const f = await fixture(t)
  const a = ok(await f.launch(await f.create())).task
  const pending = ok(await f.submit(a)).task
  const b = await f.create({ dependencyIds: [a.id] })
  await f.host.shutdown()
  const original = readTaskDatabase(f.host.storageRoot)
  for (const issue of ['cycle', 'unknown dependency', 'foreign session']) {
    const disk = structuredClone(original), row = disk.tables.tasks[a.id]
    if (issue === 'cycle') row.dependencyIds = [b.id]
    if (issue === 'unknown dependency') row.dependencyIds = [randomUUID()]
    if (issue === 'foreign session') row.delivery.sessionId = randomUUID()
    writeTaskDatabase(f.host.storageRoot, disk)
    const host = await mountHost(t, { storageRoot: f.host.storageRoot, activate: false })
    await assert.rejects(host.own(host.ctx.plugin(tasksHost)).await(), /cyclic dependencies|inconsistent dependency identity|inconsistent delivery history/u)
    assert.equal(host.ctx.get('taskService'), undefined)
    await host.shutdown()
  }
  writeTaskDatabase(f.host.storageRoot, original)
  const reopened = await fixture(t, f.native, { storageRoot: f.host.storageRoot })
  assert.deepEqual(await reopened.get(a.id), pending)
})
