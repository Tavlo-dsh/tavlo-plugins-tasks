import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { callTask, emptyList, memorySessionStorage, mountClient, mountHost, waitForState } from './fixtures.mjs'

test('shipped browser factory reads the list over real authenticated HTTP', async t => {
  const host = await mountHost(t)
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  assert.equal(client.tasks.getSnapshot().tasks.length, 0)
  const rendered = client.render()
  assert(rendered.includes('暂无任务。'))
  assert.equal(rendered.find(node => node.type === 'div').props['aria-busy'], false)
  assert(!rendered.some(node => node.props?.className === 'dsh-tasks-retry'))
  assert.equal(rendered.find(node => node.props?.className === 'dsh-tasks-primary').props.disabled, false)
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

test('actual board callbacks create, search description/title, move, and refresh persisted cards', async t => {
  const host = await mountHost(t)
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  nodeWith(client, 'dsh-tasks-primary').props.onClick()
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
  const search = nodeWith(client, 'dsh-tasks-search')
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

test('completed column keeps total count while showing recent 10; expanding and collapsing preserves tasks', async t => {
  const tasks = Array.from({ length: 12 }, (_, index) => record({
    id: 'task-' + index, title: 'Completed ' + index, stage: 'done', position: index,
    updatedAt: new Date(Date.UTC(2026, 10, 16, 0, index)).toISOString(),
  }))
  const client = await mountClient(t, { call: async () => ({ ok: true, value: { tasks } }) })
  await waitForState(client.tasks, 'ready')
  assert.equal(cards(client).length, 10)
  assert.equal(cards(client)[0].props['data-task-id'], 'task-11')
  assert.equal(client.render().filter(node => node.props?.className === 'dsh-tasks-count')[2].props.children, '12')
  client.tasks.toggleDone()
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

test('appearance follows the optional global theme and ignores legacy task preferences', async t => {
  const storage = memorySessionStorage()
  storage.setItem('dsh-plugin-tasks:appearance-v1', 'classic')
  storage.setItem('unrelated-key', 'keep')
  const client = await mountClient(t, { call: async () => emptyList() }, { sessionStorage: storage })
  await waitForState(client.tasks, 'ready')
  assert.equal(nodeWith(client, 'dsh-tasks-root').props['data-tasks-appearance'], undefined)
  const css = client.render().find(node => node.type === 'style').props.children
  assert(css.includes('body[data-dsh-paper-theme="paper"] .dsh-tasks-root'))
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
