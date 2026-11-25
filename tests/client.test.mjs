import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { runInNewContext } from 'node:vm'
import React from 'react'
import ReactDOM from 'react-dom'
import { callTask, emptyList, memorySessionStorage, mountClient, mountHost, waitForState } from './fixtures.mjs'

test('exported browser bundle activates its factory with only DSH modules', async () => {
  const url = new URL(import.meta.resolve('@tavlo-dsh/dsh-plugin-tasks/client'))
  const modules = new Map([
    ['react', React],
    ['react-dom', ReactDOM],
    ['@deepseek-ai/dsh-client-ui-primitives', { useModalLayer() {} }],
  ])
  let definition
  const window = { __ModuleLoader__: { load({ id, factory }) {
    assert.equal(id, '@tavlo-dsh/dsh-plugin-tasks')
    definition = factory(name => {
      assert(modules.has(name), `Missing DSH module: ${name}`)
      return modules.get(name)
    })
  } } }
  runInNewContext(await readFile(url, 'utf8'), { window }, { filename: url.pathname })
  assert.equal(typeof definition?.apply, 'function')
})

test('shipped browser factory reads the list over real authenticated HTTP', async t => {
  const host = await mountHost(t)
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
  const rendered = client.render()
  assert(rendered.includes('暂无任务。'))
  assert.equal(rendered.find(node => node.type === 'div').props['aria-busy'], false)
  assert(!rendered.some(node => node.props?.className === 'dsh-tasks-retry'))
  assert(!rendered.find(node => node.type === 'button' && node.props['aria-label'] === '新建任务').props.disabled)
})

test('loading state and duplicate refresh share one pending RPC', async t => {
  let calls = 0
  let complete
  const client = await mountClient(t, {
    call(channel, endpoint, payload, signal) {
      calls++
      assert.equal(channel, '/api')
      assert.equal(endpoint, 'dsh-plugin-tasks/rpc')
      assert.equal(payload.operation, 'list')
      assert.equal(Object.keys(payload.input).length, 0)
      assert.equal(signal.aborted, false)
      return new Promise(resolve => { complete = resolve })
    },
  })
  assert.equal(client.tasks.getSnapshot().status, 'loading')
  assert(client.render().includes('正在加载任务…'))
  assert.equal(client.render().find(node => node.type === 'div').props['aria-busy'], true)
  await client.retry()
  assert.equal(calls, 1)
  complete(emptyList())
  await waitForState(client.tasks, 'ready')
})

test('business error shows a retry button which recovers the list', async t => {
  let calls = 0
  const client = await mountClient(t, {
    async call() {
      calls++
      return calls === 1
        ? { ok: false, error: { code: 'tasks/forbidden', message: 'denied', details: {} } }
        : emptyList()
    },
  })
  await waitForState(client.tasks, 'error')
  assert.equal(client.tasks.getSnapshot().errorCode, 'tasks/forbidden')
  const rendered = client.render()
  assert(rendered.some(node => node.props?.role === 'alert'))
  assert(rendered.includes('无法加载任务，请重试。'))
  const retry = rendered.find(node => node.props?.className === 'dsh-tasks-retry')
  assert(retry)
  await retry.props.onClick()
  assert.equal(client.tasks.getSnapshot().status, 'ready')
  assert.equal(calls, 2)
})

test('HTTP failure shows an error and retry recovers after Host re-enables', async t => {
  const host = await mountHost(t)
  await host.plugin.dispose()
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'error')
  assert.equal(client.tasks.getSnapshot().errorCode, 'tasks/load-failed')
  // Mount the actual plugin again, as a profile enable/reload would do.
  const tasksHost = await import('../index.js')
  const enabled = host.ctx.plugin(tasksHost)
  t.after(() => enabled.dispose())
  await enabled.await()
  await client.retry()
  assert.equal(client.tasks.getSnapshot().status, 'ready')
})

test('malformed successful payload cannot be displayed as an empty list', async t => {
  for (const value of [null, {}, { tasks: {} }]) {
    await t.test(JSON.stringify(value), async t => {
      const client = await mountClient(t, { call: async () => ({ ok: true, value }) })
      await waitForState(client.tasks, 'error')
      assert.equal(client.tasks.getSnapshot().errorCode, 'tasks/load-failed')
    })
  }
})

test('uncertain storage reports that the Host plugin must recover before retrying', async t => {
  const client = await mountClient(t, {
    call: async () => ({ ok: false, error: { code: 'tasks/persistence-unknown', message: 'unknown', details: {} } }),
  })
  await waitForState(client.tasks, 'error')
  assert(client.render().includes('任务存储状态不确定，请重新启用任务插件或重启 DSH 后重试。'))
})

test('unloading aborts pending RPC and suppresses late state publication', async t => {
  let signal
  let complete
  let calls = 0
  const client = await mountClient(t, {
    call(_channel, _endpoint, _payload, requestSignal) {
      signal = requestSignal
      calls++
      return new Promise(resolve => { complete = resolve })
    },
  })
  const before = client.tasks.getSnapshot()
  let notifications = 0
  client.tasks.subscribe(() => { notifications++ })
  await client.plugin.dispose()
  assert.equal(signal.aborted, true)
  complete(emptyList())
  await setImmediate()
  assert.equal(client.tasks.getSnapshot(), before)
  assert.equal(notifications, 0)
  await client.retry()
  assert.equal(calls, 1)
})

const nodeWith = (client, className) => client.render().find(node => node.props?.className === className)
const cards = client => client.render().filter(node => node.type === 'article')
const moveButton = (client, stage) => client.render().find(node => node.type === 'button'
  && Array.isArray(node.props.children) && node.props.children.includes('移入 ' + { todo: '待开始', doing: '进行中', done: '已完成' }[stage]))
const menuEvent = () => ({ currentTarget: { closest: () => ({ removeAttribute() {} }) } })
const emptyOptions = () => ({ ok: true, value: {
  workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready', modelFailures: 0,
} })
const record = (overrides = {}) => ({
  id: '672d121d-c5b7-4588-96b9-feb869b49a57', revision: 1,
  title: 'First task', brief: 'Description', stage: 'todo', position: 0,
  createdAt: '2026-11-16T01:00:00.000Z', updatedAt: '2026-11-16T01:00:00.000Z',
  ...overrides,
})

const parentSession = 'session-11111111-1111-4111-8111-111111111111'
const childSession = 'session-22222222-2222-4222-8222-222222222222'
const namedButton = (client, name) => client.render().find(el => el.type === 'button' && el.props.children === name)

test('unknown passive status allows a blank conversation request but never a Fork', async t => {
  const task = record({ activeSessionId: parentSession }), launches = []
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation, input }) {
    if (operation === 'list') return { ok: true, value: { tasks: [task] } }
    if (operation === 'options') return { ok: true, value: { ...emptyOptions().value, canFork: true } }
    assert.equal(operation, 'launch')
    launches.push(input)
    return { ok: false, error: { code: 'tasks/session-busy' } }
  } })
  await waitForState(client.tasks, 'ready')
  client.tasks.openDetails(task.id)
  namedButton(client, '新开一个对话').props.onClick()
  await until(() => client.tasks.getSnapshot().options.status === 'ready')
  const rendered = client.render()
  assert.equal(namedButton(client, '新建并启动')?.props.disabled, false)
  assert(rendered.some(el => el.type === 'textarea' && el.props.name === 'content'))
  assert.equal(rendered.filter(el => el === '原对话状态暂不可用，创建前会重新检查。').length, 1)
  assert(rendered.find(el => el.type === 'input' && el.props.value === 'fork').props.disabled)
  client.tasks.editLaunch('forkFromSessionId', parentSession)
  await client.tasks.launchTask()
  assert.equal(launches.length, 0)
  client.tasks.editLaunch('forkFromSessionId', undefined)
  rendered.find(el => el.type === 'form' && el.props.className === 'dsh-tasks-form').props.onSubmit({ preventDefault() {} })
  await until(() => client.tasks.getSnapshot().launchForm.errorCode === 'tasks/session-busy')
  assert.equal(launches.length, 1)
  assert.equal(launches[0].replaceActive, true)
  assert.equal(launches[0].forkFromSessionId, undefined)
  assert(client.render().includes('已有对话正在执行或等待输入，请打开对话继续。'))
})

for (const status of ['running', 'approval', 'question']) test(`new conversation cannot submit while the source is ${status}`, async t => {
  const task = record({ activeSessionId: parentSession }), launches = []
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation, input }) {
    if (operation === 'list') return { ok: true, value: { tasks: [task] } }
    if (operation === 'options') return emptyOptions()
    launches.push(input)
    throw new Error('Busy conversation must not be submitted')
  } }, { fetch: async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    const baseline = { type: 'snapshot', streamId: 'busy-source', sequence: 0, tasks: [task], statuses: { [task.id]: { sessionId: parentSession, status } } }
    controller.enqueue(new TextEncoder().encode(`event: tasks\ndata: ${JSON.stringify(baseline)}\n\n`))
    signal.addEventListener('abort', () => controller.close(), { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } }) })
  await until(() => client.tasks.getSnapshot().sync === 'live')
  client.tasks.openDetails(task.id)
  namedButton(client, '新开一个对话').props.onClick()
  assert.equal(namedButton(client, '新建并启动')?.props.disabled, true)
  await client.tasks.launchTask()
  assert.deepEqual(launches, [])
})

for (const phase of ['forking', 'created']) test(`lost Fork reply checks the ${phase} receipt before any further action`, async t => {
  let task = record({ activeSessionId: parentSession }), saved, canFork = false
  const operations = []
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation, input }) {
    if (operation === 'list') return { ok: true, value: { tasks: [task] } }
    if (operation === 'options') return { ok: true, value: { ...emptyOptions().value, canFork } }
    operations.push(operation)
    if (operation === 'launch') {
      saved = input
      task = { ...task, revision: 2, launch: { phase, input, ...(phase === 'created' ? { sessionId: childSession } : {}) } }
      throw new Error('Reply lost')
    }
    if (operation === 'get') return { ok: true, value: { task } }
    assert.equal(input.requestId, saved.requestId)
    assert.equal(input.taskId, task.id)
    if (operation === 'resume-launch') return { ok: true, value: { sessionId: childSession, task: { ...task, activeSessionId: childSession, revision: 3, launch: { ...task.launch, phase: 'complete' } } } }
    assert.equal(operation, 'abandon-launch')
    return { ok: true, value: { task: { ...task, revision: 3, launch: { ...task.launch, phase: 'abandoned' } } } }
  } }, { fetch: async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    const baseline = { type: 'snapshot', streamId: 'synthetic', sequence: 0, tasks: [task], statuses: { [task.id]: { sessionId: parentSession, status: 'archived' } } }
    controller.enqueue(new TextEncoder().encode(`event: tasks\ndata: ${JSON.stringify(baseline)}\n\n`))
    signal.addEventListener('abort', () => controller.close(), { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } }) })
  const state = () => client.tasks.getSnapshot()
  await until(() => state().sync === 'live')
  client.tasks.openDetails(task.id)
  namedButton(client, '新开一个对话').props.onClick()
  await until(() => state().options.status === 'ready')
  const radio = value => client.render().find(el => el.type === 'input' && el.props.type === 'radio' && el.props.value === value)
  assert(radio('blank').props.checked)
  assert(radio('fork').props.disabled)
  canFork = true
  await client.tasks.loadOptions()
  assert.equal(radio('fork').props.disabled, false)
  radio('fork').props.onChange(); client.tasks.closeLaunch()
  assert.deepEqual(operations, [])
  client.tasks.openDetails(task.id)
  namedButton(client, '新开一个对话').props.onClick()
  await until(() => state().options.status === 'ready')
  assert(radio('blank').props.checked)
  client.tasks.editLaunch('workspaceId', 'discarded')
  client.tasks.editLaunch('agentPreset', 'discarded')
  radio('fork').props.onChange()
  assert(radio('fork').props.checked)
  assert(!client.render().some(el => ['launchWorkspace', 'agentPreset'].includes(el.props?.name)))
  client.render().find(el => el.type === 'form' && el.props.className === 'dsh-tasks-form').props.onSubmit({ preventDefault() {} })
  await until(() => state().launchForm.checkReceipt)
  client.tasks.editLaunch('content', 'must not replace frozen message')
  assert.equal(state().launchForm.content, saved.content)
  assert.equal(saved.forkFromSessionId, parentSession)
  assert.equal(saved.replaceActive, true)
  assert.equal(saved.expectedRevision, 1)
  assert(!('workspaceId' in saved || 'agentPreset' in saved))
  await client.tasks.launchTask()
  assert.deepEqual(operations, ['launch'])
  await namedButton(client, '查询启动状态').props.onClick()
  assert(radio('fork').props.disabled)
  if (phase === 'forking') {
    assert(!client.render().some(el => el.type === 'button' && el.props.type === 'submit'))
    assert(client.render().includes('可能已创建分支，尚未发送首条消息。结束本次启动不会改变原对话绑定。'))
    assert(!state().tasks[0].launch.sessionId)
    await client.tasks.launchTask()
    await namedButton(client, '结束本次启动').props.onClick()
    assert.equal(state().tasks[0].activeSessionId, parentSession)
    assert.deepEqual(operations, ['launch', 'get', 'abandon-launch'])
  } else {
    await client.tasks.launchTask()
    assert.equal(state().tasks[0].activeSessionId, childSession)
    assert.deepEqual(operations, ['launch', 'get', 'resume-launch'])
  }
  assert.equal(state().launchForm.open, false)
})

test('archived history opens the original only after confirmation and successful restore', async t => {
  const task = record({ activeSessionId: childSession, previousSessionIds: [parentSession] }), calls = []
  const client = await mountClient(t, { async call(_c, _e, { operation }) {
    return operation === 'list' ? { ok: true, value: { tasks: [task] } } : emptyOptions()
  } })
  let succeed, fail
  client.plugin.ctx.provide('workspaces', { list: { getSnapshot: () => ({ archivedSessionIds: [parentSession] }) } })
  client.plugin.ctx.provide('uiWorkspace', { openSession(id) { calls.push(['open', id]) }, unarchiveSession(id) {
    calls.push(['restore', id]); return new Promise((resolve, reject) => { succeed = resolve; fail = reject })
  } })
  await waitForState(client.tasks, 'ready')
  client.tasks.openDetails(task.id)
  const history = () => client.render().find(el => el.type === 'button' && el.props['aria-label'] === '打开对话: ' + parentSession).props.onClick()
  const dialog = () => client.render().find(el => el.type === 'dialog' && el.props.role === 'alertdialog')
  history()
  assert.equal(dialog().props['aria-label'], '恢复已归档的对话？')
  namedButton(client, '取消').props.onClick()
  assert(!dialog()); assert.deepEqual(calls, [])
  history()
  const rejected = namedButton(client, '恢复并打开').props.onClick()
  fail(new Error('Offline')); await rejected
  assert(dialog()); assert.equal(client.tasks.getSnapshot().detailId, task.id)
  assert(client.render().includes('未能恢复对话，未打开原对话。'))
  const accepted = namedButton(client, '恢复并打开').props.onClick()
  await client.tasks.restoreSession(); client.tasks.cancelRestore()
  assert(dialog()); assert.deepEqual(calls, [['restore', parentSession], ['restore', parentSession]])
  succeed(); await accepted
  assert(!dialog()); assert.deepEqual(calls.at(-1), ['open', parentSession])
  client.tasks.openSession(childSession)
  assert(!dialog()); assert.deepEqual(calls.at(-1), ['open', childSession])
})

test('attachment-only refresh advances the edit baseline without discarding input', async t => {
  let task = record()
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation }) {
    return operation === 'list' ? { ok: true, value: { tasks: [task] } } : emptyOptions()
  } })
  await waitForState(client.tasks, 'ready')
  client.tasks.openDetails(task.id)
  client.tasks.editDetails('brief', 'Keep typing')
  task = { ...task, revision: 2, imageCount: 1 }
  await client.tasks.refresh()
  assert.equal(client.tasks.getSnapshot().editor.revision, 2)
  assert.equal(client.tasks.getSnapshot().editor.brief, 'Keep typing')
  task = { ...task, revision: 3, title: 'Changed elsewhere' }
  await client.tasks.refresh()
  assert.equal(client.tasks.getSnapshot().editor.revision, 2)
  assert.equal(client.tasks.getSnapshot().editor.brief, 'Keep typing')
})

test('detail draft recovery keeps its original baseline and clears after an explicit discard', async t => {
  let task = record()
  const rpc = { async call(_channel, _endpoint, { operation }) {
    return operation === 'list' ? { ok: true, value: { tasks: [task] } } : emptyOptions()
  } }
  const storage = memorySessionStorage()
  const first = await mountClient(t, rpc, { sessionStorage: storage })
  await waitForState(first.tasks, 'ready')
  first.tasks.openDetails(task.id)
  first.tasks.editDetails('brief', 'Recovered text')
  await first.plugin.dispose()
  task = { ...task, revision: 2, title: 'Remote title' }
  const next = await mountClient(t, rpc, { sessionStorage: storage })
  await waitForState(next.tasks, 'ready')
  next.tasks.openDetails(task.id)
  assert.equal(next.tasks.getSnapshot().editor.brief, 'Recovered text')
  assert.equal(next.tasks.getSnapshot().editor.revision, 1)
  await next.tasks.reloadDetails()
  next.tasks.closeDetails()
  next.tasks.openDetails(task.id)
  assert.equal(next.tasks.getSnapshot().editor, undefined)
})

test('discard-and-reload never clears edits made while the refresh was in flight', async t => {
  let calls = 0, finish
  const task = record()
  const rpc = { call(_channel, _endpoint, { operation }) {
    if (operation !== 'list') return Promise.resolve(emptyOptions())
    if (++calls === 1) return Promise.resolve({ ok: true, value: { tasks: [task] } })
    return new Promise(resolve => { finish = resolve })
  } }
  const { tasks } = await mountClient(t, rpc)
  await waitForState(tasks, 'ready')
  tasks.openDetails(task.id)
  tasks.editDetails('brief', 'Original local draft')
  const reload = tasks.reloadDetails()
  tasks.editDetails('brief', 'New input during refresh')
  finish({ ok: true, value: { tasks: [{ ...task, revision: 2, title: 'Remote' }] } })
  await reload
  assert.equal(tasks.getSnapshot().editor.brief, 'New input during refresh')
})

test('unknown detail saves survive reload without changing or automatically replaying the request', async t => {
  const host = await mountHost(t)
  const { task } = (await callTask(host.rpc, 'create', { title: 'Original', requestId: 'restore-edit' })).value
  const inputs = []
  const rpc = { async call(...args) {
    const result = await host.rpc.call(...args)
    if (args[2].operation === 'update') {
      inputs.push(JSON.stringify(args[2].input))
      if (inputs.length === 1) throw new Error('Lost reply')
    }
    return result
  } }
  const first = await mountClient(t, rpc)
  await waitForState(first.tasks, 'ready')
  first.tasks.openDetails(task.id)
  first.tasks.editDetails('brief', 'Uncertain save')
  await first.tasks.saveDetails()
  await first.plugin.dispose()
  const next = await mountClient(t, rpc, { sessionStorage: first.sessionStorage })
  await waitForState(next.tasks, 'ready')
  next.tasks.openDetails(task.id)
  assert.equal(inputs.length, 1)
  assert.equal(next.tasks.getSnapshot().editor.pending, false)
  assert(next.tasks.getSnapshot().editor.retryInput)
  await next.tasks.saveDetails()
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0], inputs[1])
  assert.equal(next.tasks.getSnapshot().editor, undefined)
})

test('detail edits survive remote changes and cannot overwrite a newer revision', async t => {
  const host = await mountHost(t)
  const { task } = (await callTask(host.rpc, 'create', { title: 'Original', requestId: 'create-details' })).value
  const { tasks } = await mountClient(t, host.rpc)
  await waitForState(tasks, 'ready')
  tasks.openDetails(task.id)
  tasks.editDetails('title', 'Local draft')
  await callTask(host.rpc, 'update', { taskId: task.id, expectedRevision: 1, requestId: 'remote-edit', patch: { title: 'Remote' } })
  await tasks.saveDetails()
  assert.equal(tasks.getSnapshot().editor.errorCode, 'tasks/revision-conflict')
  await tasks.refresh()
  assert.equal(tasks.getSnapshot().editor.title, 'Local draft')
  await tasks.saveDetails()
  assert.equal(tasks.getSnapshot().tasks[0].title, 'Remote')
  await tasks.reloadDetails()
  assert.equal(tasks.getSnapshot().editor, undefined)
  tasks.editDetails('brief', 'New details')
  await tasks.saveDetails()
  assert.equal(tasks.getSnapshot().tasks[0].brief, 'New details')
  tasks.editDetails('brief', '')
  await tasks.saveDetails()
  assert.equal(tasks.getSnapshot().tasks[0].brief, undefined)
})

test('a lost detail save response retries the identical committed update', async t => {
  const host = await mountHost(t)
  const { task } = (await callTask(host.rpc, 'create', { title: 'Original', requestId: 'new-edit' })).value
  const updates = []
  const { tasks } = await mountClient(t, { async call(...args) {
    const result = await host.rpc.call(...args)
    if (args[2].operation === 'update') {
      updates.push(args[2].input)
      if (updates.length === 1) throw new Error('lost response')
    }
    return result
  } })
  await waitForState(tasks, 'ready')
  tasks.openDetails(task.id)
  tasks.editDetails('title', 'Edited')
  await tasks.saveDetails()
  assert.equal(tasks.getSnapshot().editor.errorCode, 'tasks/edit-unknown')
  tasks.editDetails('title', 'Ignored while retrying')
  await tasks.saveDetails()
  assert.deepEqual(updates[0], updates[1])
  assert.equal(tasks.getSnapshot().editor, undefined)
  assert.equal(tasks.getSnapshot().tasks[0].revision, 2)
  assert.equal(tasks.getSnapshot().tasks[0].title, 'Edited')
})

test('actual board callbacks create, search description/title, move, and refresh persisted cards', async t => {
  const host = await mountHost(t)
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  client.render().find(node => node.type === 'button' && node.props['aria-label'] === '新建任务').props.onClick()
  const title = client.render().find(node => node.type === 'input' && node.props.name === 'title')
  const brief = client.render().find(node => node.type === 'textarea')
  title.props.onChange({ target: { value: '  接入 Payments  ' } })
  brief.props.onChange({ target: { value: '验证回调 Callback' } })
  let prevented = false
  const form = client.render().find(node => node.type === 'form')
  form.props.onSubmit({ preventDefault() { prevented = true } })
  assert(prevented)
  assert(client.tasks.getSnapshot().form.pending)
  assert.equal(cards(client).length, 0, 'no card before persistence succeeds')
  await until(() => !client.tasks.getSnapshot().form.pending)
  assert.equal(cards(client).length, 1)
  assert.equal(client.tasks.getSnapshot().tasks[0].title, '接入 Payments')
  assert.equal(client.tasks.getSnapshot().form.title, '')
  assert(!client.render().some(node => node.type === 'form'))
  const counts = () => client.render().filter(node => node.props?.className === 'dsh-tasks-count').map(node => node.props.children)
  assert.deepEqual(counts(), ['1', '0', '0'])
  const search = client.render().find(node => node.props?.type === 'search')
  search.props.onChange({ target: { value: 'CALLBACK' } })
  assert.equal(cards(client).length, 1)
  assert.deepEqual(counts(), ['1 / 1', '0 / 0', '0 / 0'])
  search.props.onChange({ target: { value: 'payments' } })
  assert.equal(cards(client).length, 1)
  search.props.onChange({ target: { value: 'does not match' } })
  assert.equal(cards(client).length, 0)
  assert(client.render().includes('没有匹配的任务'))
  search.props.onChange({ target: { value: '' } })
  moveButton(client, 'doing').props.onClick(menuEvent())
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'todo', 'no optimistic move')
  assert(moveButton(client, 'doing').props.disabled)
  await until(() => Object.keys(client.tasks.getSnapshot().stages).length === 0)
  assert.deepEqual(counts(), ['0', '1', '0'])
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 2)
  await client.retry()
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'doing')
})

test('pending creation suppresses duplicate submissions and refresh; definite failure preserves editable input', async t => {
  let finish
  const operations = []
  const client = await mountClient(t, {
    call(_channel, _endpoint, { operation }) {
      operations.push(operation)
      return operation === 'list' ? Promise.resolve(emptyList()) : operation === 'options'
        ? Promise.resolve(emptyOptions()) : new Promise(resolve => { finish = resolve })
    },
  })
  await waitForState(client.tasks, 'ready')
  client.tasks.openForm()
  client.tasks.editForm('title', 'Keep this draft')
  client.tasks.editForm('brief', 'And this description')
  const pending = client.tasks.create()
  await client.tasks.create()
  await client.retry()
  client.tasks.editForm('title', 'must not change pending input')
  assert.deepEqual(operations, ['list', 'options', 'create'])
  assert.equal(client.tasks.getSnapshot().form.title, 'Keep this draft')
  assert(client.render().find(node => node.type === 'fieldset').props.disabled)
  finish({ ok: false, error: { code: 'tasks/persistence-failed' } })
  await pending
  assert.equal(cards(client).length, 0)
  assert.equal(client.tasks.getSnapshot().form.title, 'Keep this draft')
  assert.equal(client.tasks.getSnapshot().form.brief, 'And this description')
  assert.equal(client.tasks.getSnapshot().form.retryInput, undefined)
  assert(client.render().includes('创建失败，输入已保留，请重试。'))
  client.tasks.editForm('title', 'Corrected')
  assert.equal(client.tasks.getSnapshot().form.title, 'Corrected')
})

test('lost creation response survives panel/tab reload and retries the identical request without duplicates', async t => {
  const host = await mountHost(t)
  const inputs = []
  let loseResponse = true
  const rpc = {
    async call(channel, endpoint, payload, signal) {
      const result = await host.rpc.call(channel, endpoint, payload, signal)
      if (payload.operation === 'create') {
        inputs.push(JSON.stringify(payload.input))
        if (loseResponse) { loseResponse = false; throw new Error('response lost after commit') }
      }
      return result
    },
  }
  const first = await mountClient(t, rpc)
  await waitForState(first.tasks, 'ready')
  first.tasks.openForm()
  first.tasks.editForm('title', '  Safe retry  ')
  first.tasks.editForm('brief', 'Canonical input')
  await first.tasks.create()
  const original = first.tasks.getSnapshot().form.retryInput
  assert(original?.requestId)
  assert.equal(cards(first).length, 0)
  assert(first.render().includes('创建结果尚未确认。请重试同一请求，避免重复创建；输入已保留。'))
  first.tasks.editForm('title', 'cannot edit uncertain input')
  first.tasks.closeForm()
  first.tasks.openForm()
  assert.equal(first.tasks.getSnapshot().form.title, '  Safe retry  ')
  await first.plugin.dispose()
  const second = await mountClient(t, rpc, { sessionStorage: first.sessionStorage })
  await waitForState(second.tasks, 'ready')
  assert(second.tasks.getSnapshot().form.open)
  assert(second.render().find(node => node.type === 'fieldset').props.disabled)
  await second.tasks.create()
  assert.equal(inputs.length, 2)
  assert.equal(inputs[0], inputs[1])
  assert.equal(cards(second).length, 1)
  assert.equal(second.tasks.getSnapshot().form.retryInput, undefined)
  assert.equal((await callTask(host.rpc, 'list', {})).value.tasks.length, 1)
  const third = await mountClient(t, rpc, { sessionStorage: first.sessionStorage })
  await waitForState(third.tasks, 'ready')
  assert.equal(third.tasks.getSnapshot().form.open, false, 'committed draft removed')
})

test('revision conflict keeps the requested destination, requires refresh, and preserves a creation draft', async t => {
  const host = await mountHost(t)
  const created = (await callTask(host.rpc, 'create', { requestId: 'conflict-fixture', title: 'Shared task' })).value.task
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  client.tasks.openForm()
  client.tasks.editForm('title', 'Unrelated draft')
  await callTask(host.rpc, 'set-stage', { taskId: created.id, expectedRevision: 1, stage: 'doing' })
  await client.tasks.setStage(created.id, 'done')
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 1)
  assert.equal(client.tasks.getSnapshot().stages[created.id].stage, 'done')
  assert(client.render().includes('该任务已被其他操作修改。请刷新后重新选择分类。'))
  assert(moveButton(client, 'done').props.disabled)
  await client.tasks.setStage(created.id, 'done')
  assert.equal((await callTask(host.rpc, 'list', {})).value.tasks[0].revision, 2)
  await client.retry()
  assert.equal(client.tasks.getSnapshot().form.title, 'Unrelated draft')
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'doing')
  assert.equal(Object.keys(client.tasks.getSnapshot().stages).length, 0)
  await client.tasks.setStage(created.id, 'done')
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 3)
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'done')
})

test('unknown stage result blocks blind retries and refresh recovers the committed column', async t => {
  const host = await mountHost(t)
  const task = (await callTask(host.rpc, 'create', { requestId: 'stage-unknown', title: 'Lost stage response' })).value.task
  let mutations = 0
  const client = await mountClient(t, {
    async call(channel, endpoint, payload, signal) {
      const result = await host.rpc.call(channel, endpoint, payload, signal)
      if (payload.operation === 'set-stage') { mutations++; throw new Error('response lost') }
      return result
    },
  })
  await waitForState(client.tasks, 'ready')
  await client.tasks.setStage(task.id, 'done')
  await client.tasks.setStage(task.id, 'doing')
  assert.equal(mutations, 1)
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'todo')
  assert(client.render().includes('分类修改结果尚未确认，请刷新查看已保存的分类。'))
  await client.retry()
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'done')
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 2)
})

test('pending mutation aborts on disposal without late publication and retains the retry payload', async t => {
  let finish
  let signal
  const client = await mountClient(t, {
    call(_channel, _endpoint, payload, requestSignal) {
      if (payload.operation === 'list') return Promise.resolve(emptyList())
      signal = requestSignal
      return new Promise(resolve => { finish = resolve })
    },
  })
  await waitForState(client.tasks, 'ready')
  client.tasks.editForm('title', 'Pending during unload')
  const pending = client.tasks.create()
  const before = client.tasks.getSnapshot()
  let published = 0
  client.tasks.subscribe(() => { published++ })
  await client.plugin.dispose()
  assert(signal.aborted)
  finish({ ok: true, value: { task: record() } })
  await pending
  assert.equal(client.tasks.getSnapshot(), before)
  assert.equal(published, 0)
  const next = await mountClient(t, { call: async () => emptyList() }, { sessionStorage: client.sessionStorage })
  await waitForState(next.tasks, 'ready')
  assert.equal(next.tasks.getSnapshot().form.retryInput.requestId, before.form.retryInput.requestId)
  assert.equal(next.tasks.getSnapshot().form.pending, false)
})

test('malformed records are rejected; malformed creation success is uncertain, never a fake card', async t => {
  for (const tasks of [[record({ revision: 0 })], [record({ stage: 'other' })], [record(), record()]]) {
    const client = await mountClient(t, { call: async () => ({ ok: true, value: { tasks } }) })
    await waitForState(client.tasks, 'error')
    assert.equal(cards(client).length, 0)
  }
  const client = await mountClient(t, {
    call: async (_channel, _endpoint, payload) => payload.operation === 'list'
      ? emptyList() : { ok: true, value: { task: {} } },
  })
  await waitForState(client.tasks, 'ready')
  client.tasks.editForm('title', 'Do not trust malformed result')
  await client.tasks.create()
  assert.equal(cards(client).length, 0)
  assert(client.tasks.getSnapshot().form.retryInput)
  assert.equal(client.tasks.getSnapshot().form.errorCode, 'tasks/create-unknown')
})

test('uncertain persistence during mutation hides stale records and retains the creation identity', async t => {
  const client = await mountClient(t, {
    call: async (_channel, _endpoint, payload) => payload.operation === 'list'
      ? { ok: true, value: { tasks: [record()] } }
      : { ok: false, error: { code: 'tasks/persistence-unknown' } },
  })
  await waitForState(client.tasks, 'ready')
  client.tasks.openForm()
  client.tasks.editForm('title', 'Uncertain write')
  await client.tasks.create()
  assert.equal(client.tasks.getSnapshot().status, 'error')
  assert.equal(client.tasks.getSnapshot().hasLoaded, false)
  assert.equal(cards(client).length, 0)
  assert(client.tasks.getSnapshot().form.retryInput)
  assert(client.render().includes('任务存储状态不确定，请重新启用任务插件或重启 DSH 后重试。'))
})

test('a delayed creation replay cannot replace a newer stage response', async t => {
  const host = await mountHost(t)
  let first = true
  let finishReplay
  const client = await mountClient(t, {
    async call(channel, endpoint, payload, signal) {
      const result = await host.rpc.call(channel, endpoint, payload, signal)
      if (payload.operation !== 'create') return result
      if (first) { first = false; throw new Error('lost creation response') }
      return new Promise(resolve => { finishReplay = () => resolve(result) })
    },
  })
  await waitForState(client.tasks, 'ready')
  client.tasks.editForm('title', 'Replay and change concurrently')
  await client.tasks.create()
  await client.retry()
  const task = client.tasks.getSnapshot().tasks[0]
  const replay = client.tasks.create()
  await until(() => finishReplay !== undefined)
  await client.tasks.setStage(task.id, 'done')
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 2)
  finishReplay()
  await replay
  assert.equal(client.tasks.getSnapshot().tasks[0].stage, 'done')
  assert.equal(client.tasks.getSnapshot().tasks[0].revision, 2)
  assert.equal(client.tasks.getSnapshot().tasks.length, 1)
})

test('completed column keeps total count while showing the recent four; expanding and collapsing preserves tasks', async t => {
  const tasks = Array.from({ length: 12 }, (_, index) => record({
    id: 'task-' + index, title: 'Completed ' + index, stage: 'done', position: index,
    updatedAt: new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString(),
  }))
  const client = await mountClient(t, { call: async () => ({ ok: true, value: { tasks } }) })
  await waitForState(client.tasks, 'ready')
  assert.equal(cards(client).length, 4)
  assert.equal(cards(client)[0].props['data-task-id'], 'task-11')
  assert.equal(client.render().filter(node => node.props?.className === 'dsh-tasks-count')[2].props.children, '12')
  const range = () => client.render().find(node => node.props?.className === 'dsh-tasks-done-range')
  assert.equal(range().props['aria-pressed'], false)
  client.tasks.setQuery('Completed')
  assert.equal(cards(client).length, 12, 'Search does not truncate matches')
  assert.equal(range(), undefined)
  client.tasks.setQuery('Completed 11')
  assert.equal(cards(client).length, 1)
  assert.equal(range(), undefined)
  client.tasks.setQuery('')
  range().props.onClick()
  assert.equal(range().props['aria-pressed'], true)
  assert.equal(cards(client).length, 12)
  client.tasks.toggleColumn('done')
  assert.equal(cards(client).length, 0)
  assert.equal(client.tasks.getSnapshot().tasks.length, 12)
  client.tasks.toggleColumn('done')
  assert.equal(cards(client).length, 12)
})

async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for Client action')
    await setImmediate()
  }
}

test('appearance is owned by the optional theme slot and ignores legacy task preferences', async t => {
  const storage = memorySessionStorage()
  storage.setItem('dsh-plugin-tasks:appearance-v1', 'classic')
  storage.setItem('unrelated-key', 'keep')
  const client = await mountClient(t, { call: async () => emptyList() }, { sessionStorage: storage })
  await waitForState(client.tasks, 'ready')
  assert.equal(nodeWith(client, 'dsh-tasks-root dsh-tasks-board-view').props['data-tasks-appearance'], undefined)
  const css = client.render().find(node => node.type === 'style').props.children
  assert(css.includes('body[data-dsh-paper-theme="paper"]:not([data-dsh-task-appearance="ios"])'))
  assert(css.includes('body[data-dsh-task-appearance="paper"]'))
  assert(css.includes('.dsh-tasks-root .dsh-tasks-select-list'))
  assert(css.includes('--dsh-tasks-paper: var(--dsh-paper-paper)'))
  assert(css.includes(':focus { outline: none; box-shadow: none; border-color: var(--dsh-tasks-focus); }'))
  assert(!client.render().some(node => node.props?.className === 'dsh-tasks-appearance'))
  assert.equal(client.tasks.setAppearance, undefined)
  assert.equal(storage.getItem('unrelated-key'), 'keep')
})

test('paper decoration is stable across refresh and list order', async t => {
  let tasks = [record(), record({ id: 'another-task', title: 'Another' })]
  const client = await mountClient(t, { call: async () => ({ ok: true, value: { tasks } }) })
  await waitForState(client.tasks, 'ready')
  const decoration = () => Object.fromEntries(cards(client).map(node => [node.props['data-task-id'], JSON.stringify(node.props.style)]))
  const before = decoration()
  assert.notEqual(before[tasks[0].id], before[tasks[1].id])
  tasks = [...tasks].reverse()
  await client.tasks.refresh()
  assert.deepEqual(decoration(), before)
})

test('card cleans markdown link brief and renders external link chip and compact action button', async t => {
  const tapdUrl = 'https://www.tapd.cn/12345/prong/stories/view/1001'
  const task = record({
    id: 'tapd-task-1',
    title: 'TAPD Sync Task',
    brief: `[Open in TAPD](<${tapdUrl}>)\n\n    主责: 开发人员。前置: 无`,
    stage: 'todo',
  })
  const client = await mountClient(t, { call: async () => ({ ok: true, value: { tasks: [task] } }) })
  await waitForState(client.tasks, 'ready')
  const rendered = client.render()

  // The card brief should NOT contain the raw markdown link
  const briefNode = rendered.find(node => node.props?.className === 'dsh-tasks-card-brief')
  assert(briefNode)
  assert.equal(briefNode.props.children, '主责: 开发人员。前置: 无')

  // The card should render an external link chip
  const extLink = rendered.find(node => node.props?.className === 'dsh-tasks-card-extlink')
  assert(extLink)
  assert.equal(extLink.props.href, tapdUrl)

  // The action button should have compact action button class
  const actionBtn = rendered.find(node => node.props?.['data-task-next-action'] !== undefined)
  assert(actionBtn)
  assert(actionBtn.props.className.includes('dsh-tasks-card-action-btn'))
})

function cardSlice(rendered, taskId) {
  const start = rendered.findIndex(node => node.props?.['data-task-id'] === taskId)
  assert(start >= 0, `Card not found: ${taskId}`)
  let end = rendered.length
  for (let i = start + 1; i < rendered.length; i++) {
    const cls = rendered[i]?.props?.className
    if (rendered[i]?.props?.['data-task-id'] || cls === 'dsh-tasks-colfoot' || cls === 'dsh-tasks-col') {
      end = i
      break
    }
  }
  return rendered.slice(start, end)
}

test('board phase-2 styling: merged footer, action tones, extlink arrow, bottom icon counts, done check & colfoot range', async t => {
  const tapdUrl = 'https://www.tapd.cn/12345/prong/stories/view/2026'
  const sessionId = '11111111-2222-4333-8444-555555555555'
  const launchId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee1'
  const reviewId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee2'
  const resumeId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee3'
  const progressId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee4'
  const blockedId = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeee5'
  const tasks = [
    record({
      id: launchId,
      title: 'Launchable Task',
      brief: `[Open in TAPD](<${tapdUrl}>)\n\nDetailed brief`,
      stage: 'todo',
      priority: 'P0',
      fileCount: 2,
      commentCount: 3,
      position: 0,
    }),
    record({
      id: reviewId,
      title: 'Reviewable Task',
      stage: 'doing',
      priority: 'P1',
      activeSessionId: sessionId,
      delivery: { id: '22222222-3333-4444-8555-666666666666', sessionId, status: 'pending', summary: 'Ready', submittedAt: '2026-11-16T00:00:00.000Z' },
      position: 0,
    }),
    record({
      id: resumeId,
      title: 'Resumable Task',
      stage: 'todo',
      priority: 'P2',
      launch: { phase: 'created', sessionId, input: { requestId: 'req-1', content: 'Resume launch' } },
      position: 1,
    }),
    record({
      id: progressId,
      title: 'Running Task',
      stage: 'doing',
      activeSessionId: sessionId,
      position: 1,
    }),
    record({
      id: blockedId,
      title: 'Blocked Task',
      stage: 'todo',
      dependencyIds: [launchId],
      position: 2,
    }),
    ...Array.from({ length: 5 }, (_, index) => record({
      id: 'task-done-' + index,
      title: 'Done Task ' + index,
      stage: 'done',
      position: index,
      updatedAt: new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString(),
    })),
  ]
  const client = await mountClient(t, { call: async () => ({ ok: true, value: { tasks } }) })
  await waitForState(client.tasks, 'ready')
  const rendered = client.render()

  // 1. Merged footer wraps context & buttons; action tones match promote vs neutral
  const launchSlice = cardSlice(rendered, launchId)
  const footerIdx = launchSlice.findIndex(node => node.props?.className === 'dsh-tasks-card-footer')
  assert(footerIdx >= 0)
  const footerChildren = React.Children.toArray(launchSlice[footerIdx].props.children)
  assert(footerChildren.some(child => child.props?.className === 'dsh-tasks-card-context'))
  assert(footerChildren.some(child => child.props?.className === 'dsh-tasks-card-buttons'))

  const toneOf = id => cardSlice(rendered, id).find(node => node.props?.['data-task-next-action'] !== undefined)?.props['data-action-tone']
  assert.equal(toneOf(launchId), 'promote')
  assert.equal(toneOf(reviewId), 'promote')
  assert.equal(toneOf(resumeId), 'promote')
  assert.equal(toneOf(progressId), 'neutral')
  assert.equal(toneOf(blockedId), 'neutral')

  // 2. External link chip omits link SVG icon and preserves arrow span
  const extLink = launchSlice.find(node => node.props?.className === 'dsh-tasks-card-extlink')
  assert(extLink)
  const extChildren = React.Children.toArray(extLink.props.children)
  assert.equal(extChildren.length, 2)
  assert.equal(extChildren[0].props.children, 'TAPD')
  assert.equal(extChildren[1].props.className, 'dsh-tasks-extlink-arrow')
  assert.equal(extChildren[1].props.children, '↗')

  // 3. fileCount/commentCount render inside bottom .dsh-tasks-card-counts with aria-label
  const countsIdx = launchSlice.findIndex(node => node.props?.className === 'dsh-tasks-card-counts')
  assert(countsIdx > footerIdx)
  const countNodes = React.Children.toArray(launchSlice[countsIdx].props.children)
  assert.equal(countNodes.length, 2)
  assert.equal(countNodes[0].props['aria-label'], '任务文件: 2')
  assert.equal(countNodes[1].props['aria-label'], '评论: 3')

  // 4. Done card title has .dsh-tasks-done-check; .dsh-tasks-done-range is inside .dsh-tasks-colfoot before .dsh-tasks-add
  const doneSlice = cardSlice(rendered, 'task-done-4')
  const doneTitle = doneSlice.find(node => node.props?.className === 'dsh-tasks-card-title')
  assert(React.Children.toArray(doneTitle.props.children).some(child => child.props?.className === 'dsh-tasks-done-check'))

  const colHeads = rendered.filter(node => node.props?.className === 'dsh-tasks-colhead')
  assert(!colHeads.some(head => React.Children.toArray(head.props.children).some(child => child.props?.className === 'dsh-tasks-done-range')))
  const doneFoot = rendered.find(node => node.props?.className === 'dsh-tasks-colfoot' && node.props['data-has-range'] !== undefined)
  assert(doneFoot)
  const footButtons = React.Children.toArray(doneFoot.props.children)
  assert.equal(footButtons[0]?.props.className, 'dsh-tasks-done-range')
  assert.equal(footButtons.at(-1)?.props.className, 'dsh-tasks-add')

  // 5. Priority Tag preserves tone contract and exposes data-priority; custom todo tape & rename CSS are present
  const p0Tag = launchSlice.find(node => node.props?.['data-priority'] === 'P0' && node.props?.tone !== undefined)
  assert(p0Tag)
  assert.equal(p0Tag.props.tone, 'warning')
  assert.equal(p0Tag.props.children?.props?.title, 'P0')
  const p1Tag = cardSlice(rendered, reviewId).find(node => node.props?.['data-priority'] === 'P1' && node.props?.tone !== undefined)
  assert(p1Tag)
  assert.equal(p1Tag.props.tone, 'neutral')

  const css = rendered.find(node => node.type === 'style').props.children
  assert(css.includes('.dsh-tasks-col[data-stage="todo"]:not([data-column-id="stage:todo"])::before'))
  assert(css.includes('.dsh-tasks-col-rename'))
})

test('custom column color applies data-column-color and --dsh-tasks-col-color without affecting uncolored columns', async t => {
  const host = await mountHost(t)
  const plainRes = await callTask(host.rpc, 'edit-columns', { expectedRevision: 1, action: 'add', stage: 'doing', name: 'Plain doing' })
  assert.equal(plainRes.ok, true)
  const uncoloredColumnId = plainRes.value.board.columns.at(-1).id

  const coloredRes = await callTask(host.rpc, 'edit-columns', { expectedRevision: 2, action: 'add', stage: 'doing', name: '123', color: '#d96b6b' })
  assert.equal(coloredRes.ok, true)
  const coloredColumnId = coloredRes.value.board.columns.at(-1).id

  const client = await mountClient(t, host.rpc, { fetch: host.fetchAuthenticated })
  await until(() => client.tasks.getSnapshot().status === 'ready' && client.tasks.getSnapshot().board?.columns?.some(col => col.id === coloredColumnId))
  const rendered = client.render()
  const cols = rendered.filter(node => node.props?.className === 'dsh-tasks-col')
  const coloredCol = cols.find(node => node.props['data-column-id'] === coloredColumnId)
  const uncoloredCol = cols.find(node => node.props['data-column-id'] === uncoloredColumnId)
  assert(coloredCol)
  assert.equal(coloredCol.props['data-column-color'], '')
  assert.equal(coloredCol.props.style?.['--dsh-tasks-col-color'], '#d96b6b')
  assert(uncoloredCol)
  assert.equal(uncoloredCol.props['data-column-color'], undefined)
  assert.equal(uncoloredCol.props.style, undefined)

  const css = rendered.find(node => node.type === 'style').props.children
  assert(css.includes('.dsh-tasks-col[data-column-color]::before'))
  assert(css.includes('.dsh-tasks-col[data-column-color] .dsh-tasks-colname::before'))
})

test('openForm prefills workspaceId from active concrete workspaceFilter without overwriting drafts', async t => {
  const host = await mountHost(t, {
    workspaces: async () => [{ id: 'ws-a', title: 'Workspace A', path: '/tmp/ws-a' }],
  })
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  client.tasks.setWorkspaceFilter('ws-a')
  client.tasks.openForm()
  assert.equal(client.tasks.getSnapshot().form.workspaceId, 'ws-a')
  client.tasks.closeForm()

  // Existing draft workspace choice is preserved even when filter changes.
  client.tasks.editForm('workspaceId', '')
  client.tasks.editForm('title', 'Draft title')
  client.tasks.openForm()
  assert.equal(client.tasks.getSnapshot().form.workspaceId, '')
  client.tasks.closeForm()

  // Special sentinels ('', 'ungrouped') do not set a concrete workspaceId.
  client.tasks.setWorkspaceFilter('ungrouped')
  client.tasks.editForm('title', '')
  client.tasks.openForm()
  assert.equal(client.tasks.getSnapshot().form.workspaceId, '')
})

test('discardDetails reverts unsaved edits and clears storage without closing the detail drawer', async t => {
  const host = await mountHost(t)
  const { task } = (await callTask(host.rpc, 'create', { title: 'Original title', requestId: 'discard-test' })).value
  const sessionStorage = memorySessionStorage()
  const client = await mountClient(t, host.rpc, { sessionStorage })
  await waitForState(client.tasks, 'ready')
  client.tasks.openDetails(task.id)
  client.tasks.editDetails('title', 'Edited locally')
  assert.equal(client.tasks.getSnapshot().editor.title, 'Edited locally')
  assert(sessionStorage.getItem('dsh-plugin-tasks:details-v1:' + task.id))

  client.tasks.discardDetails()
  assert.equal(client.tasks.getSnapshot().detailId, task.id)
  assert.equal(client.tasks.getSnapshot().editor, undefined)
  assert.equal(sessionStorage.getItem('dsh-plugin-tasks:details-v1:' + task.id), null)
})
