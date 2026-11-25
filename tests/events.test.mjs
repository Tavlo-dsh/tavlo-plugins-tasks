import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { StorageError } from '@deepseek-ai/dsh-storage'
import * as tasksHost from '../index.js'
import { createTaskEvents } from '../task-events.js'
import { createTaskStore } from '../task-store.js'
import { taskDomain } from '../task-schema.js'
import { callTask, emptyList, mountClient, mountHost, mountStorage, waitForState } from './fixtures.mjs'

const PATH = '/api/dsh-plugin-tasks/events'
const limits = { maxTitleLength: 200, maxBriefLength: 20000, maxTasks: 10000 }
const config = { eventBufferBytes: 65536, eventHeartbeatMs: 1000 }
const record = (changes = {}) => ({
  id: '672d121d-c5b7-4588-96b9-feb869b49a57', revision: 1,
  title: '同步任务', stage: 'todo', position: 0,
  createdAt: '2026-11-17T01:00:00.000Z', updatedAt: '2026-11-17T01:00:00.000Z', ...changes,
})
const baseline = (tasks = [], changes = {}) => ({ type: 'snapshot', streamId: 'host-1', sequence: 0, tasks, ...changes })
const change = (task, sequence = 1) => ({ type: 'upsert', streamId: 'host-1', sequence, task })

async function until(predicate) {
  const deadline = Date.now() + 4000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for task events')
    await setImmediate()
  }
}

function clock() {
  let id = 0
  const pending = new Map()
  return {
    pending,
    setTimeout(callback, ms) { pending.set(++id, { callback, ms }); return id },
    clearTimeout(id) { pending.delete(id) },
    fire(ms) {
      const timer = [...pending].find(([, timer]) => timer.ms === ms)
      assert(timer, `Expected a ${ms}ms timer`)
      pending.delete(timer[0])
      timer[1].callback()
    },
  }
}

function streamTransport() {
  const connections = []
  return {
    connections,
    fetch(url, init) {
      assert.equal(url, 'api/dsh-plugin-tasks/events')
      assert.equal(init.credentials, 'same-origin')
      let controller
      let ended = false
      const end = () => { if (!ended) { ended = true; controller.close() } }
      const body = new ReadableStream({ start(value) { controller = value }, cancel() { ended = true } })
      init.signal.addEventListener('abort', end, { once: true })
      const connection = {
        signal: init.signal, end,
        send(event) { controller.enqueue(new TextEncoder().encode('event: tasks\ndata: ' + JSON.stringify(event) + '\n\n')) },
        bytes(bytes) { controller.enqueue(bytes) },
      }
      connections.push(connection)
      return Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } }))
    },
  }
}

test('attachment events rebase drafts but never change pending or uncertain save payloads', async t => {
  const transport = streamTransport()
  let rejectSave
  const client = await mountClient(t, { call(_channel, _endpoint, { operation }) {
    if (operation === 'update') return new Promise((_resolve, reject) => { rejectSave = reject })
    return Promise.resolve(emptyList())
  } }, { fetch: transport.fetch })
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  client.tasks.openDetails(record().id)
  client.tasks.editDetails('brief', 'Local text')
  transport.connections[0].send(change(record({ revision: 2, imageCount: 1 })))
  await until(() => client.tasks.getSnapshot().editor.revision === 2)
  const saving = client.tasks.saveDetails()
  const payload = JSON.stringify(client.tasks.getSnapshot().editor.retryInput)
  transport.connections[0].send(change(record({ revision: 3, imageCount: 2 }), 2))
  await until(() => client.tasks.getSnapshot().tasks[0].revision === 3)
  assert.equal(client.tasks.getSnapshot().editor.revision, 2)
  assert.equal(JSON.stringify(client.tasks.getSnapshot().editor.retryInput), payload)
  rejectSave(new Error('Lost acknowledgement'))
  await saving
  transport.connections[0].send(change(record({ revision: 4, imageCount: 3 }), 3))
  await until(() => client.tasks.getSnapshot().tasks[0].revision === 4)
  assert.equal(JSON.stringify(client.tasks.getSnapshot().editor.retryInput), payload)
  assert.equal(client.tasks.getSnapshot().editor.brief, 'Local text')
})

test('a detail save changes one task once, regardless of whether the RPC or SSE arrives first', async t => {
  for (const streamFirst of [false, true]) await t.test(streamFirst ? 'SSE first' : 'RPC first', async t => {
    const transport = streamTransport(), initial = record(), other = record({ id: 'other' })
    let finishUpdate
    const client = await mountClient(t, { call(_channel, _endpoint, { operation, input }) {
      if (operation !== 'update') return Promise.resolve(emptyList())
      return new Promise(resolve => { finishUpdate = task => resolve({ ok: true, value: {
        task, mutation: { requestId: input.requestId },
      }, streamId: 'host-1', sequence: 1 }) })
    } }, { fetch: transport.fetch })
    const stream = transport.connections[0]
    stream.send(baseline([initial, other]))
    await until(() => client.tasks.getSnapshot().sync === 'live')
    const getTasks = () => client.tasks.getSnapshot().tasks
    const before = getTasks()
    const projections = new Set([before])
    client.tasks.subscribe(() => projections.add(getTasks()))
    client.tasks.openDetails(initial.id)
    client.tasks.editDetails('title', 'Revised locally')
    const saving = client.tasks.saveDetails(), task = { ...initial, title: 'Revised locally', revision: 2 }
    assert.equal(getTasks(), before)
    if (streamFirst) {
      stream.send(change(task))
      await until(() => getTasks()[0].revision === 2)
    }
    finishUpdate(task)
    await saving
    assert.equal(client.tasks.getSnapshot().editor, undefined)
    assert.equal(getTasks()[1], before[1])
    assert.equal(getTasks()[0].title, task.title)
    if (!streamFirst) stream.send(change(task))
    stream.send(change({ ...other, title: 'Next event', revision: 2 }, 2))
    await until(() => getTasks()[1].revision === 2)
    assert.equal(projections.size, 3, 'initial, one edit, then the unrelated follow-up event')
  })
})

test('title updates leave existing comment-only matches visible while the same search refreshes', async t => {
  const transport = streamTransport(), timers = clock(), initial = record({ commentCount: 1 })
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation }) {
    return operation === 'comment-matches' ? { ok: true, value: { matches: { [initial.id]: 'comment hit' } } } : emptyList()
  } }, { fetch: transport.fetch, timers })
  const stream = transport.connections[0]
  stream.send(baseline([initial]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  client.tasks.setQuery('comment hit')
  timers.fire(180)
  await until(() => client.tasks.getSnapshot().matches?.[initial.id])
  const matches = client.tasks.getSnapshot().matches
  stream.send(change({ ...initial, title: 'Remote title', revision: 2 }))
  await until(() => client.tasks.getSnapshot().tasks[0].revision === 2)
  assert.equal(client.tasks.getSnapshot().matches, matches)
  assert(client.render().some(node => node.props?.className === 'dsh-tasks-card-brief dsh-tasks-match-snippet'))
  client.tasks.setQuery('different')
  assert.equal(client.tasks.getSnapshot().matches, undefined)
})

test('a late upload response cannot erase a newer remote text conflict received by SSE', async t => {
  const transport = streamTransport()
  let finishUpload
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: (url, init) => init.method === 'POST'
    ? new Promise(resolve => { finishUpload = resolve }) : transport.fetch(url, init) })
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  client.tasks.openDetails(record().id)
  client.tasks.editDetails('brief', 'Keep local text')
  client.tasks.queueImages(record().id, [{ type: 'image/png', size: 5, name: 'local.png' }], { mediaTypes: ['image/png'], maxImageBytes: 10, maxImages: 10 })
  transport.connections[0].send(change(record({ revision: 2, imageCount: 1 })))
  await until(() => client.tasks.getSnapshot().editor.revision === 2)
  transport.connections[0].send(change(record({ revision: 3, imageCount: 1, title: 'Remote title' }), 2))
  await until(() => client.tasks.getSnapshot().tasks[0].revision === 3)
  finishUpload({ json: async () => ({ ok: true, value: { task: record({ revision: 2, imageCount: 1 }) }, streamId: 'host-1', sequence: 1 }) })
  await until(() => client.tasks.getSnapshot().imageJobs[record().id].length === 0)
  assert.equal(client.tasks.getSnapshot().tasks[0].title, 'Remote title')
  assert.equal(client.tasks.getSnapshot().editor.revision, 2)
  assert.equal(client.tasks.getSnapshot().editor.brief, 'Keep local text')
})

test('due chart scopes dates to unfinished matching tasks and its chip clears only the date', async t => {
  const transport = streamTransport()
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, fullscreen: true })
  const columns = ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage }))
  const rows = [-1, 0, 1, 2, 7, 8, null, 1].map((days, index) => {
    const date = new Date()
    date.setDate(date.getDate() + days)
    return record({ id: String(index), dueDate: days == null ? undefined : date.toLocaleDateString('sv-SE'), priority: index === 4 ? 'P1' : 'P0', stage: index === 7 ? 'done' : 'todo' })
  })
  transport.connections[0].send(baseline(rows, { board: { columns, revision: 1 } }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  const periods = () => client.render().filter(node => node.props?.['data-period'])
  const counts = () => client.render().filter(node => node.props?.className === 'dsh-tasks-due-count').map(node => node.props.children)
  const visible = () => client.render().filter(node => node.type === 'article').map(node => node.props['data-task-id'])
  assert.deepEqual(counts(), [1, 1, 1, 2])
  periods()[3].props.onClick()
  assert.deepEqual(visible(), ['3', '4'])
  client.tasks.setFilter('priority', 'P0')
  assert.deepEqual(counts(), [1, 1, 1, 1])
  periods()[2].props.onClick()
  assert.deepEqual(visible(), ['2'])
  client.render().find(node => node.props?.className === 'dsh-tasks-due-chip').props.onClick()
  assert.equal(client.tasks.getSnapshot().filters.priority, 'P0')
  assert.equal(visible().length, 7)
  transport.connections[0].send(change({ ...rows[6], priority: 'P2', revision: 2 }))
  await until(() => client.tasks.getSnapshot().tasks.some(task => task.priority === 'P2'))
  client.tasks.setFilter('priority', 'P2')
  assert(client.render().includes('当前未完成任务均未设截止日期。'))
  assert.equal(periods().length, 0)
})

test('done-range controls appear only for truncated columns and expand independently', async t => {
  const transport = streamTransport(), columns = ['small', 'first', 'second'].map(id => ({ id, stage: 'done', name: id }))
  const rows = columns.flatMap((column, index) => Array.from({ length: index ? 11 : 3 }, (_, i) =>
    record({ id: `${column.id}-${i}`, stage: 'done', columnId: column.id })))
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch })
  transport.connections[0].send(baseline(rows, { board: { columns, revision: 1 } }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  const ranges = () => client.render().filter(node => node.props?.className === 'dsh-tasks-done-range')
  const articles = () => client.render().filter(node => node.type === 'article')
  assert.equal(ranges().length, 2)
  assert.equal(articles().length, 11)
  ranges()[0].props.onClick()
  assert.equal(articles().length, 18)
  assert.deepEqual(ranges().map(node => node.props['aria-pressed']), [true, false])
  client.tasks.setQuery('同步任务')
  assert.equal(ranges().length, 0)
  assert.equal(articles().length, 25)
  client.tasks.setQuery('')
  assert.equal(articles().length, 18)
})

test('insights render regardless of fullscreen and count only known completion times', async t => {
  for (const fullscreen of [false, true]) {
    const transport = streamTransport()
    const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, fullscreen })
    const now = Date.now()
    const rows = [record({ id: 'a', stage: 'done', createdAt: new Date(now - 129600000).toISOString(), completedAt: new Date(now).toISOString() }),
      record({ id: 'b', stage: 'done' }), record({ id: 'c', stage: 'doing' })]
    transport.connections[0].send(baseline(rows, { board: { columns: [], revision: 1 } }))
    await until(() => client.tasks.getSnapshot().sync === 'live')
    const view = client.render()
    assert(view.some(node => node.props?.className === 'dsh-tasks-insights'))
    assert.equal(view.find(node => node.type === 'progress').props.value, 67)
    assert.deepEqual(view.filter(node => node.props?.className === 'dsh-tasks-metric').map(node => node.props.children[1].props.children), [0, 1, 1, '1.5 天'])
  }
})

test('overview counts custom and grouped columns within the selected workspace', async t => {
  const transport = streamTransport()
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch })
  const columns = ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage }))
  columns.push(...Array.from({ length: 4 }, (_, index) => ({ id: `custom-${index}`, name: `自定义 ${index}`, stage: 'doing' })))
  const tasks = [record({ id: 'a', workspaceId: 'one', stage: 'doing', columnId: 'custom-0' }),
    record({ id: 'b', workspaceId: 'two', stage: 'doing', columnId: 'custom-0' }),
    record({ id: 'c', workspaceId: 'one', stage: 'doing', columnId: 'custom-3' })]
  transport.connections[0].send(baseline(tasks, { board: { revision: 1, columns } }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  const counts = () => Object.fromEntries(client.render().find(node => node.props?.className === 'dsh-tasks-column-mix')
    .props.children.map(row => [row.props.children[0].props.children, row.props.children[2].props.children]))
  assert.equal(counts()['进行中'], 0)
  assert.equal(counts()['自定义 0'], 2)
  assert.equal(counts()['其余列 · 2'], 1)
  client.tasks.setWorkspaceFilter('two')
  assert.equal(counts()['自定义 0'], 1)
  assert.equal(counts()['其余列 · 2'], 0)
})

test('overview lists rank attention, use actual completion timestamps, and respect filter scope', async t => {
  const transport = streamTransport(), sessionId = '12345678-1234-4321-8765-abcdefabcdef'
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch })
  const daysFromNow = days => new Date(Date.now() + days * 86400000).toLocaleDateString('sv-SE')
  const item = (id, attrs) => record({ id, title: id, workspaceId: 'one', ...attrs })
  const tasks = [item('high', { priority: 'P0' }), item('ordinary', { priority: 'P2' }), item('far', { dueDate: daysFromNow(9) }),
    item('soon', { dueDate: daysFromNow(5) }), item('tomorrow', { dueDate: daysFromNow(1) }), item('today', { dueDate: daysFromNow(0) }),
    item('late', { dueDate: daysFromNow(-2) }), item('question', { activeSessionId: sessionId }), item('approval', { activeSessionId: sessionId }),
    item('other-scope', { workspaceId: 'two', priority: 'P1' }),
    item('unknown-completion', { stage: 'done' }), ...Array.from({ length: 6 }, (_, i) => item('done-' + i,
      { stage: 'done', completedAt: `2026-01-01T10:0${i}:00Z`, updatedAt: `2026-02-01T10:0${5 - i}:00Z` }))]
  const statuses = Object.fromEntries(['approval', 'question'].map(status => [status, { sessionId, status }]))
  transport.connections[0].send(baseline(tasks, { statuses, board: { revision: 1, columns: [] } }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  const list = kind => client.render().find(node => node.props?.['data-list'] === kind).props.children[1]
  const rows = kind => list(kind).type === 'ul' ? Array.from(list(kind).props.children, row => row.props.children.props) : []
  const labels = kind => rows(kind).map(row => row['aria-label'].split(' · ')[0])
  assert.deepEqual(labels('attention'), ['approval', 'question', 'late', 'today', 'tomorrow'])
  assert.deepEqual(labels('recent'), ['done-5', 'done-4', 'done-3', 'done-2', 'done-1'])
  assert.equal(rows('recent')[0].children[1].props.children[1].props.dateTime, '2026-01-01T10:05:00Z')
  client.tasks.setFilter('dueDate', 'nextWeek')
  assert.deepEqual(labels('attention'), ['soon'])
  assert.equal(labels('recent').length, 5, 'A due-date filter does not hide completion history')
  rows('attention')[0].onClick()
  assert.equal(client.tasks.getSnapshot().detailId, 'soon')
  client.tasks.clearFilters()
  client.tasks.setWorkspaceFilter('two')
  assert.deepEqual(labels('attention'), ['other-scope'])
  assert.equal(rows('attention')[0]['aria-label'], 'other-scope · 高优先级 · P1')
  assert.equal(list('recent').props.children, '暂无带完成时间的任务。')
})

test('activity keeps earlier pages while merging new events and ignores results for a closed task', async t => {
  const transport = streamTransport(), requests = []
  const task = record()
  const client = await mountClient(t, { call(_channel, _endpoint, { operation, input }) {
    if (operation === 'list') return emptyList()
    assert.equal(operation, 'history')
    return new Promise(resolve => requests.push({ input, resolve }))
  } }, { fetch: transport.fetch })
  const { tasks } = client
  const reply = (index, newest, oldest, before) => requests[index].resolve({ ok: true, value: {
    events: Array.from({ length: newest - oldest + 1 }, (_, offset) => ({ id: newest - offset })), before,
  } })
  const ids = () => Array.from(tasks.getSnapshot().activity.events, event => event.id)
  await until(() => transport.connections.length === 1)
  const connection = transport.connections[0]
  connection.send(baseline([task], { board: { columns: [], revision: 1 } }))
  await until(() => tasks.getSnapshot().board)
  tasks.openDetails(task.id)
  assert.equal(requests.length, 0)
  const first = tasks.loadHistory()
  await until(() => requests.length === 1)
  reply(0, 55, 31, 31)
  await first
  const older = tasks.loadHistory(true)
  await until(() => requests.length === 2)
  assert.equal(requests[1].input.before, 31)
  connection.send(change(record({ revision: 2 })))
  await until(() => tasks.getSnapshot().tasks[0].revision === 2)
  assert.equal(requests.length, 2)
  reply(1, 30, 6, 6)
  await older
  await until(() => requests.length === 3)
  assert.equal(ids().at(-1), 6)
  reply(2, 81, 57, 57)
  await until(() => requests.length === 4)
  assert.equal(requests[3].input.before, 57)
  reply(3, 56, 32, 32)
  await until(() => !tasks.getSnapshot().activity.loading)
  assert.deepEqual(ids(), Array.from({ length: 76 }, (_, index) => 81 - index))
  assert.equal(tasks.getSnapshot().activity.before, 6)
  const failed = tasks.loadHistory(true)
  await until(() => requests.length === 5)
  requests[4].resolve({ ok: false })
  await failed
  assert.equal(tasks.getSnapshot().activity.error, 'older')
  assert.equal(ids().at(-1), 6)
  const retry = tasks.loadHistory(true)
  await until(() => requests.length === 6)
  assert.equal(requests[5].input.before, 6)
  tasks.closeDetails()
  tasks.openDetails(task.id)
  reply(5, 5, 1)
  await retry
  assert.equal(tasks.getSnapshot().activity, undefined)
})

async function openReader(t, host) {
  const abort = new AbortController()
  t.after(() => abort.abort())
  const response = await host.fetchAuthenticated(PATH, { signal: abort.signal })
  assert.equal(response.status, 200)
  assert(response.headers.get('content-type').startsWith('text/event-stream'))
  assert.equal(response.headers.get('x-accel-buffering'), 'no')
  const reader = response.body.getReader()
  t.after(async () => { try { await reader.cancel() } catch (error) { /* HTTP disconnect already released the stream. */ } })
  let text = ''
  const decoder = new TextDecoder()
  return async () => {
    while (true) {
      const end = text.indexOf('\n\n')
      if (end >= 0) {
        const frame = text.slice(0, end)
        text = text.slice(end + 2)
        const data = frame.split('\n').find(line => line.startsWith('data: '))
        if (data) return JSON.parse(data.slice(6))
      } else {
        const chunk = await reader.read()
        assert(!chunk.done, 'Expected another task event')
        text += decoder.decode(chunk.value, { stream: true })
      }
    }
  }
}

test('external updates have identical public records in Host, RPC, SSE and the shipped Client', async t => {
  const host = await mountHost(t)
  const service = host.ctx.get('taskService')
  const externalRef = { provider: 'tapd', connectionId: '22222222-2222-4222-8222-222222222222', scopeId: 'project', objectType: 'story', objectId: '1123456789000000123' }
  const next = await openReader(t, host)
  assert.equal((await next()).type, 'snapshot')
  const client = await mountClient(t, host.rpc, { fetch: host.fetchAuthenticated })
  await waitForState(client.tasks, 'ready')
  const created = await service.execute('create', { requestId: 'external-stream', title: 'External', externalRef })
  assert(created.ok)
  assert.deepEqual((await next()).task, created.value.task)
  const updated = await callTask(host.rpc, 'update', { taskId: created.value.task.id, requestId: 'stream-update', expectedRevision: 1,
    patch: { title: 'Updated externally', externalRef: { ...externalRef, url: 'https://example.org/item' } } })
  assert(updated.ok)
  const event = await next()
  assert.deepEqual(event.task, updated.value.task)
  assert(!JSON.stringify(event).includes('_updates'))
  await until(() => client.tasks.getSnapshot().tasks[0]?.revision === 2)
  assert.equal(client.tasks.getSnapshot().tasks[0].title, 'Updated externally')
  const unbound = await service.execute('update', { taskId: created.value.task.id, requestId: 'stream-unbind', expectedRevision: 2, patch: { externalRef: null } })
  assert(unbound.ok)
  assert.deepEqual((await next()).task, unbound.value.task)
  assert(!Object.hasOwn(unbound.value.task, 'externalRef'))
  assert.deepEqual((await callTask(host.rpc, 'get', { taskId: created.value.task.id })).value.task, unbound.value.task)
})

test('real HTTP SSE enforces owner access and emits only committed changes, with restart baselines', async t => {
  const first = await mountHost(t)
  assert.equal((await fetch(first.origin + PATH)).status, 401)
  assert.equal((await first.fetchAuthenticated(PATH, { headers: { origin: 'https://untrusted.example' } })).status, 403)
  assert.equal((await first.fetchAuthenticated(PATH, { method: 'POST' })).status, 404)
  const connection = first.ctx.get('connection')
  const guest = connection.createPeer({ principal: { kind: 'probe-guest' } })
  t.after(() => guest.dispose())
  assert.equal((await connection.createSharedFetchHandler('/api').fetch(new Request(first.origin + PATH), guest)).status, 403)
  const next = await openReader(t, first)
  const initial = await next()
  assert.equal(initial.sequence, 0)
  assert.deepEqual(initial.tasks, [])
  const input = { requestId: 'sse-create', title: '真实流' }
  const task = (await callTask(first.rpc, 'create', input)).value.task
  const created = await next()
  assert.equal(created.sequence, 1)
  assert.deepEqual(created.task, task)
  assert(!JSON.stringify(created).includes('_create'))
  await callTask(first.rpc, 'create', input)
  const moved = (await callTask(first.rpc, 'set-stage', { taskId: task.id, expectedRevision: 1, stage: 'doing' })).value.task
  const updated = await next()
  assert.equal(updated.sequence, 2, 'creation replays do not publish a duplicate change')
  assert.deepEqual(updated.task, moved)
  await first.shutdown()
  const second = await mountHost(t, { storageRoot: first.storageRoot })
  const restored = await (await openReader(t, second))()
  assert.equal(restored.sequence, 0)
  assert.notEqual(restored.streamId, initial.streamId)
  assert.deepEqual(restored.tasks, [moved])
})

test('baseline registration waits for an accepted write and does not miss the next commit', async t => {
  let finish
  const storage = await mountStorage(t, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => new Promise(resolve => { finish = () => resolve(target.putRecord(...args)) })
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const domain = await storage.ctx.storageDomain.open(taskDomain)
  const store = createTaskStore(domain, limits)
  t.after(() => store.close())
  const writing = store.execute('create', { requestId: 'snapshot-race', title: 'Pending commit' })
  await until(() => finish)
  const events = []
  const watching = store.watch(event => events.push(event))
  await setImmediate()
  assert.equal(events.length, 0)
  finish()
  const task = (await writing).value.task
  const unwatch = await watching
  assert.equal(events[0].sequence, 1)
  assert.deepEqual(events[0].tasks, [task])
  const pendingMove = store.execute('set-stage', { taskId: task.id, expectedRevision: 1, stage: 'done' })
  finish = undefined
  await until(() => finish)
  finish()
  await pendingMove
  assert.equal(events[1].sequence, 2)
  assert.equal(events[1].task.stage, 'done')
  unwatch()
})

test('failed durable writes publish no change and the next successful commit retains its sequence', async t => {
  let fail = true
  const storage = await mountStorage(t, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => fail
      ? Promise.reject(new Error('Simulated rejected write')) : target.putRecord(...args)
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const store = createTaskStore(await storage.ctx.storageDomain.open(taskDomain), limits)
  t.after(() => store.close())
  const events = []
  const unwatch = await store.watch(event => events.push(event))
  const input = { requestId: 'failed-write', title: 'Only after commit' }
  assert.equal((await store.execute('create', input)).error.code, 'tasks/persistence-failed')
  assert.equal(events.length, 1)
  fail = false
  assert((await store.execute('create', input)).ok)
  assert.equal(events[1].sequence, 1)
  unwatch()
})

test('an oversized initial snapshot reports the queue limit and leaves no subscription', async () => {
  let removed = 0
  const events = createTaskEvents({ watch: async observer => {
    observer(baseline([record({ brief: 'x'.repeat(70000) })]))
    return () => removed++
  } }, config)
  const response = await events.open(new Request('http://localhost/events'))
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'tasks/events-too-large')
  assert.equal(removed, 1)
  events.close()
})

test('bounded slow consumers, reader cancellation, and unload all release subscriptions', async t => {
  const observers = new Set()
  const events = createTaskEvents({ watch: async observer => {
    observer(baseline())
    observers.add(observer)
    return () => observers.delete(observer)
  } }, config)
  t.after(() => events.close())
  const response = await events.open(new Request('http://localhost/events'))
  for (let index = 0; index < 5; index++) {
    for (const observer of [...observers]) observer(change(record({ brief: 'x'.repeat(40000) }), index + 1))
  }
  assert.equal(observers.size, 0, 'queue overflow detaches the slow consumer')
  const body = await response.text()
  assert(body.length <= config.eventBufferBytes)
  const cancelled = await events.open(new Request('http://localhost/events'))
  assert.equal(observers.size, 1)
  await cancelled.body.cancel()
  assert.equal(observers.size, 0)
  const active = await events.open(new Request('http://localhost/events'))
  events.close()
  assert.equal(observers.size, 0)
  assert((await active.text()).includes('snapshot'))
  assert.equal((await events.open(new Request('http://localhost/events'))).status, 503)
})

test('request abort while subscription readiness is pending cannot leak an observer', async () => {
  let finish
  let removed = 0
  const events = createTaskEvents({ watch: observer => {
    observer(baseline())
    return new Promise(resolve => { finish = () => resolve(() => removed++) })
  } }, config)
  const abort = new AbortController()
  const opening = events.open(new Request('http://localhost/events', { signal: abort.signal }))
  abort.abort()
  finish()
  await (await opening).text()
  assert.equal(removed, 1)
  events.close()
})

test('two shipped Client sources synchronize real HTTP writes through one stream each', async t => {
  const host = await mountHost(t)
  let opens = 0
  const fetchEvents = (url, init) => { opens++; return host.fetchAuthenticated(url, init) }
  const first = await mountClient(t, host.rpc, { fetch: fetchEvents })
  const second = await mountClient(t, host.rpc, { fetch: fetchEvents })
  await until(() => first.tasks.getSnapshot().sync === 'live' && second.tasks.getSnapshot().sync === 'live')
  second.tasks.editForm('title', '保留的草稿')
  second.tasks.setQuery('同步')
  first.tasks.editForm('title', '同步创建')
  await first.tasks.create()
  await until(() => second.tasks.getSnapshot().tasks.length === 1)
  const task = first.tasks.getSnapshot().tasks[0]
  await first.tasks.setStage(task.id, 'doing')
  await until(() => second.tasks.getSnapshot().tasks[0].stage === 'doing')
  assert.equal(second.tasks.getSnapshot().tasks[0].revision, 2)
  const revision = first.tasks.getSnapshot().board.revision
  assert((await first.tasks.editColumns({ expectedRevision: revision, action: 'reorder', columnId: 'stage:doing', before: 'stage:todo' })).ok)
  await until(() => second.tasks.getSnapshot().board.revision === revision + 1)
  assert.deepEqual(Array.from(second.tasks.getSnapshot().board.columns, column => column.id), ['stage:doing', 'stage:todo', 'stage:done'])
  assert.equal(second.tasks.getSnapshot().tasks[0].columnId, 'stage:doing')
  assert.equal(second.tasks.getSnapshot().form.title, '保留的草稿')
  assert.equal(second.tasks.getSnapshot().query, '同步')
  assert(second.render().includes('实时同步已连接'))
  for (let index = 0; index < 6; index++) await callTask(host.rpc, 'create', { requestId: 'many-' + index, title: 'More ' + index })
  await until(() => second.tasks.getSnapshot().tasks.length === 7)
  first.render(); second.render(); first.render()
  assert.equal(opens, 2, 'connection count is independent of tasks and panel renders')
})

test('a delayed RPC list and an earlier baseline cannot overwrite newer committed records', async t => {
  const transport = streamTransport()
  let finishList
  const client = await mountClient(t, { call: async (_channel, _endpoint, payload) => payload.operation === 'list'
    ? new Promise(resolve => { finishList = resolve }) : { ok: true, value: { task: record({ revision: 2, stage: 'doing' }) } } },
  { fetch: transport.fetch })
  transport.connections[0].send(baseline([record()]))
  await waitForState(client.tasks, 'ready')
  transport.connections[0].send(change(record({ revision: 3, stage: 'done' })))
  await until(() => client.tasks.getSnapshot().tasks[0].revision === 3)
  finishList({ ok: true, value: { tasks: [record()] } })
  await setImmediate()
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 3)
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'done')
  const delayed = streamTransport()
  const second = await mountClient(t, { call: async (_channel, _endpoint, payload) => payload.operation === 'list'
    ? { ok: true, value: { tasks: [record()] } } : { ok: true, value: { task: record({ revision: 2, stage: 'doing' }) } } },
  { fetch: delayed.fetch })
  await waitForState(second.tasks, 'ready')
  await second.tasks.setStage(record().id, 'doing')
  delayed.connections[0].send(baseline([record()]))
  await until(() => second.tasks.getSnapshot().sync === 'live')
  assert.equal(second.tasks.getSnapshot().tasks[0].revision, 2)
})

test('fragmented UTF-8 and CRLF frames parse; gaps reconnect to an authoritative new Host baseline', async t => {
  const transport = streamTransport()
  const timers = clock()
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, timers })
  const bytes = new TextEncoder().encode(': ping\r\n\r\nevent: tasks\r\ndata: ' + JSON.stringify(baseline([record()])) + '\r\n\r\n')
  for (const byte of bytes) transport.connections[0].bytes(new Uint8Array([byte]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  assert.equal(client.tasks.getSnapshot().tasks[0].title, '同步任务')
  transport.connections[0].send(change(record({ revision: 2 }), 2))
  await until(() => client.tasks.getSnapshot().sync === 'offline' && timers.pending.size > 0)
  assert(client.render().includes('实时同步已断开，任务可能不是最新状态；正在自动重连。'))
  timers.fire(1000)
  await until(() => transport.connections.length === 2)
  transport.connections[1].send(baseline([], { streamId: 'host-2' }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  assert.equal(client.tasks.getSnapshot().tasks.length, 0, 'new Host baseline removes old records')
})

test('reconnect backs off to a cap; page lifecycle and disposal stop old connections and retries', async t => {
  const transport = streamTransport()
  const timers = clock()
  const listeners = new Map()
  const browserEvents = { addEventListener: (name, callback) => listeners.set(name, callback), removeEventListener: name => listeners.delete(name) }
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, timers, browserEvents })
  for (const delay of [1000, 2000, 4000, 8000, 15000, 15000]) {
    const index = transport.connections.length - 1
    transport.connections[index].end()
    await until(() => [...timers.pending.values()].some(timer => timer.ms === delay))
    timers.fire(delay)
    await until(() => transport.connections.length === index + 2)
  }
  listeners.get('pagehide')()
  await until(() => timers.pending.size === 0)
  assert(transport.connections.at(-1).signal.aborted)
  listeners.get('pageshow')()
  await until(() => transport.connections.length === 8)
  transport.connections.at(-1).send(baseline())
  await until(() => client.tasks.getSnapshot().sync === 'live')
  const before = client.tasks.getSnapshot()
  await client.plugin.dispose()
  await until(() => timers.pending.size === 0)
  assert.equal(listeners.size, 0)
  assert(transport.connections.at(-1).signal.aborted)
  assert.equal(client.tasks.getSnapshot(), before)
})

test('a silent half-open stream times out and reconnects', async t => {
  const transport = streamTransport()
  const timers = clock()
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, timers })
  transport.connections[0].send(baseline())
  await until(() => client.tasks.getSnapshot().sync === 'live')
  timers.fire(90000)
  await until(() => [...timers.pending.values()].some(timer => timer.ms === 1000))
  assert(transport.connections[0].signal.aborted)
  timers.fire(1000)
  await until(() => transport.connections.length === 2)
  transport.connections[1].send(baseline())
  await until(() => client.tasks.getSnapshot().sync === 'live')
})

test('heartbeats without a baseline cannot keep an uninitialized stream open indefinitely', async t => {
  const transport = streamTransport()
  const timers = clock()
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, timers })
  await waitForState(client.tasks, 'ready')
  transport.connections[0].bytes(new TextEncoder().encode(': heartbeat\n\n'))
  await setImmediate()
  timers.fire(30000)
  await until(() => client.tasks.getSnapshot().sync === 'offline')
  assert(transport.connections[0].signal.aborted)
})

test('a stale list failure cannot replace a newer stream storage-uncertainty notification', async t => {
  const transport = streamTransport()
  let finish
  const client = await mountClient(t, { call: () => new Promise(resolve => { finish = resolve }) }, { fetch: transport.fetch })
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  transport.connections[0].send({ type: 'unavailable', code: 'tasks/persistence-unknown', streamId: 'host-1', sequence: 1 })
  await until(() => client.tasks.getSnapshot().errorCode === 'tasks/persistence-unknown')
  finish({ ok: false, error: { code: 'tasks/load-failed' } })
  await setImmediate()
  assert.equal(client.tasks.getSnapshot().errorCode, 'tasks/persistence-unknown')
  assert.equal(client.tasks.getSnapshot().hasLoaded, false)
})

test('an old Host mutation response cannot override a new Host baseline', async t => {
  const transport = streamTransport()
  const timers = clock()
  let finish
  const client = await mountClient(t, { call: async (_channel, _endpoint, payload) => payload.operation === 'list'
    ? emptyList() : new Promise(resolve => { finish = resolve }) }, { fetch: transport.fetch, timers })
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  await setImmediate()
  const moving = client.tasks.setStage(record().id, 'done')
  assert(finish)
  transport.connections[0].end()
  await until(() => [...timers.pending.values()].some(timer => timer.ms === 1000))
  timers.fire(1000)
  await until(() => transport.connections.length === 2)
  transport.connections[1].send(baseline([record()], { streamId: 'host-2' }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  finish({ ok: true, value: { task: record({ revision: 2, stage: 'done' }) } })
  await moving
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'todo')
  assert.equal(client.tasks.getSnapshot().stages[record().id].errorCode, 'tasks/stage-unknown')
})

test('uncertain persistence invalidates all live Clients and fresh streams until the store reopens', async t => {
  let fail = false
  const host = await mountHost(t, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return (...args) => fail
      ? Promise.reject(new StorageError('unknown-state', 'Simulated unknown commit')) : target.putRecord(...args)
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  await callTask(host.rpc, 'create', { requestId: 'before-unknown', title: 'Known task' })
  const first = await mountClient(t, host.rpc, { fetch: host.fetchAuthenticated })
  const second = await mountClient(t, host.rpc, { fetch: host.fetchAuthenticated })
  await until(() => first.tasks.getSnapshot().sync === 'live' && second.tasks.getSnapshot().sync === 'live')
  fail = true
  await callTask(host.rpc, 'create', { requestId: 'unknown', title: 'Unknown task' })
  await until(() => first.tasks.getSnapshot().errorCode === 'tasks/persistence-unknown'
    && second.tasks.getSnapshot().errorCode === 'tasks/persistence-unknown')
  assert.equal(first.tasks.getSnapshot().tasks.length, 0)
  assert.equal(second.tasks.getSnapshot().hasLoaded, false)
  const response = await host.fetchAuthenticated(PATH)
  assert.equal(response.status, 503)
  assert.equal((await response.json()).code, 'tasks/persistence-unknown')
  await host.plugin.dispose()
  fail = false
  const enabled = host.ctx.plugin(tasksHost)
  t.after(() => enabled.dispose())
  await enabled.await()
  const fresh = await (await openReader(t, host))()
  assert.equal(fresh.tasks.length, 1)
})

test('same-Host reconnect snapshot removes tasks deleted while offline', async t => {
  const transport = streamTransport(), timers = clock()
  const client = await mountClient(t, { call: async () => emptyList() }, { fetch: transport.fetch, timers })
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  transport.connections[0].end()
  await until(() => [...timers.pending.values()].some(timer => timer.ms === 1000))
  timers.fire(1000)
  await until(() => transport.connections.length === 2)
  transport.connections[1].send(baseline([], { sequence: 2 }))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
})

test('a delayed mutation response cannot resurrect a task after its committed removal', async t => {
  const transport = streamTransport()
  let finish
  const client = await mountClient(t, { call: async (_channel, _endpoint, payload) => payload.operation === 'list'
    ? emptyList() : new Promise(resolve => { finish = resolve }) }, { fetch: transport.fetch })
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  await setImmediate()
  const moving = client.tasks.setStage(record().id, 'done')
  transport.connections[0].send(change(record({ revision: 2, stage: 'done' }), 1))
  transport.connections[0].send({ type: 'remove', streamId: 'host-1', sequence: 2, taskId: record().id, revision: 3 })
  await until(() => client.tasks.getSnapshot().tasks.length === 0)
  finish({ ok: true, value: { task: record({ revision: 2, stage: 'done' }) }, streamId: 'host-1', sequence: 1 })
  await moving
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
})

test('a baseline captured before delete RPC completion cannot revive the deleted card', async t => {
  const transport = streamTransport()
  const client = await mountClient(t, { call: async (_channel, _endpoint, payload) => payload.operation === 'list'
    ? { ok: true, value: { tasks: [record()] } }
    : { ok: true, value: { taskId: record().id, revision: 2 }, streamId: 'host-1', sequence: 1 } }, { fetch: transport.fetch })
  await waitForState(client.tasks, 'ready')
  client.tasks.openDelete(record().id)
  await client.tasks.deleteTask()
  transport.connections[0].send(baseline([record()]))
  await until(() => client.tasks.getSnapshot().sync === 'live')
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
  transport.connections[0].send({ type: 'remove', streamId: 'host-1', sequence: 1, taskId: record().id, revision: 2 })
  await setImmediate()
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
})
