import assert from 'node:assert/strict'
import test from 'node:test'
import { callTask, mountHost, mountClient, waitForState, readTaskDatabase, writeTaskDatabase } from './fixtures.mjs'

const workspaceId = 'e5d7d9aa-5952-4f71-a0d5-9c86d2286016'
const workspace = { id: workspaceId, title: 'acme-web', path: 'F:/work/acme-web' }
const model = { provider: 'configured', model: 'model-a' }
const catalog = () => ({ groups: [{ id: 'configured', name: 'Configured provider', models: [
  { id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }] } },
  { id: 'model-b', name: 'Model B' },
] }], failures: [] })

test('options read Host services and preferences persist; unavailable references remain readable and replayable', async t => {
  let available = true
  const host = await mountHost(t, { workspaces: () => available ? [workspace] : [], modelCatalog: async () => available ? catalog() : { groups: [], failures: [] } })
  const options = (await callTask(host.rpc, 'options', {})).value
  assert.equal(options.canFork, false)
  assert.deepEqual(options.workspaces, [workspace])
  assert.equal(options.groups[0].models[0].name, 'Model A')
  const input = { requestId: 'bound-task', title: 'Task with preferences', workspaceId, model, stage: 'doing' }
  const created = await callTask(host.rpc, 'create', input)
  assert(created.ok)
  assert.equal(created.value.task.workspaceId, workspaceId)
  assert.deepEqual(created.value.task.model, model)
  assert.equal(created.value.task.stage, 'doing')
  const conflict = await callTask(host.rpc, 'create', { ...input, model: undefined })
  assert.equal(conflict.error.code, 'tasks/request-conflict')
  available = false
  assert.deepEqual((await callTask(host.rpc, 'create', input)).value.task, created.value.task)
  assert.equal((await callTask(host.rpc, 'create', { ...input, requestId: 'new-after-removal' })).error.code, 'tasks/workspace-unavailable')
  await host.shutdown()
  const reopened = await mountHost(t, { storageRoot: host.storageRoot })
  assert.deepEqual((await callTask(reopened.rpc, 'list', {})).value.tasks, [created.value.task])
  assert.deepEqual((await callTask(reopened.rpc, 'create', input)).value.task, created.value.task)
})

test('launch effort uses the shared select-only listbox with the effective model’s supported choices', async t => {
  let selection = { ...model, reasoningEffort: 'high', privateValue: 'not exported' }
  const host = await mountHost(t, { modelCatalog: async () => ({ ...catalog(), default: selection }) })
  const listed = (await callTask(host.rpc, 'options', {})).value
  assert.deepEqual(listed.defaultModel, { ...model, reasoningEffort: 'high' })
  assert(!JSON.stringify(listed).includes('privateValue'))
  const task = (await callTask(host.rpc, 'create', { title: 'Launch settings', requestId: 'effort-label' })).value.task
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  client.tasks.openLaunch(task.id)
  await until(() => client.tasks.getSnapshot().options.status === 'ready')
  const effort = () => client.render().find(node => node.props?.name === 'reasoningEffort')
  const chooseEffort = value => effort().props.onChange({ target: { value } })
  const formModel = () => structuredClone(client.tasks.getSnapshot().launchForm.model)
  const rendered = client.render()
  const trigger = rendered.find(node => node.props?.role === 'combobox' && node.props['aria-label'] === '思考强度')
  assert.equal(trigger.type, 'button')
  assert.equal(trigger.props.type, 'button')
  assert.equal(trigger.props['aria-haspopup'], 'listbox')
  assert.equal(trigger.props['aria-autocomplete'], undefined)
  assert.equal(trigger.props.onChange, undefined)
  assert.equal(trigger.props.title, 'High')
  const listbox = rendered.find(node => node.props?.id === trigger.props['aria-controls'])
  assert.equal(listbox.props.role, 'listbox')
  const effortOptions = rendered.filter(node => node.props?.role === 'option' && node.props.id.startsWith(listbox.props.id + '-'))
  assert.deepEqual(effortOptions.map(node => node.props.children[1]), ['使用模型默认强度', 'Low', 'High'])
  assert.deepEqual(effortOptions.map(node => node.props['aria-selected']), [false, false, true])
  assert.equal(effort().props.type, 'hidden')
  assert.equal(effort().props.value, 'high')
  assert.equal(formModel(), undefined)
  chooseEffort('low')
  assert.deepEqual(formModel(), { ...model, reasoningEffort: 'low' })
  assert.equal(effort().props.value, 'low')
  chooseEffort('')
  assert.deepEqual(formModel(), model)
  client.tasks.editLaunch('model', { ...model, model: 'model-b' })
  assert.equal(effort(), undefined)
  assert(!client.render().includes('模型偏好'))
  selection = { ...model, model: 'missing' }
  assert.equal((await callTask(host.rpc, 'options', {})).value.defaultModel, undefined)
})

test('catalog failures allow unbound creation; unavailable or invalid explicit selections never write', async t => {
  const host = await mountHost(t, { workspaces: () => [workspace], modelCatalog: async () => { throw new Error('do not disclose diagnostic') } })
  const options = await callTask(host.rpc, 'options', {})
  assert.equal(options.value.workspaceStatus, 'ready')
  assert.equal(options.value.modelStatus, 'error')
  assert(!JSON.stringify(options).includes('do not disclose'))
  assert((await callTask(host.rpc, 'create', { requestId: 'unbound', title: 'Default model' })).ok)
  assert.equal((await callTask(host.rpc, 'create', { requestId: 'model-reject', title: 'Rejected', model })).error.code, 'tasks/model-unavailable')
  assert.equal((await callTask(host.rpc, 'create', { requestId: 'path-reject', title: 'Rejected', workspaceId: 'F:/arbitrary-path' })).error.code, 'tasks/bad-request')
  assert.equal((await callTask(host.rpc, 'options', { extra: true })).error.code, 'tasks/bad-request')
  assert.equal((await callTask(host.rpc, 'list', {})).value.tasks.length, 1)
  const withoutServices = await mountHost(t)
  assert.equal((await callTask(withoutServices.rpc, 'options', {})).value.workspaceStatus, 'unavailable')
  assert((await callTask(withoutServices.rpc, 'create', { requestId: 'bare', title: 'Bare profile' })).ok)
})

test('schema v6 opens legacy v1 records and preserves legacy creation deduplication', async t => {
  const first = await mountHost(t)
  const input = { requestId: 'legacy', title: 'Old task', brief: 'Before preferences' }
  const task = (await callTask(first.rpc, 'create', input)).value.task
  await first.shutdown()
  const document = readTaskDatabase(first.storageRoot)
  document.unit.version = 1
  delete document.tables.tasks[task.id]._create.stage
  writeTaskDatabase(first.storageRoot, document)
  const next = await mountHost(t, { storageRoot: first.storageRoot })
  assert.deepEqual((await callTask(next.rpc, 'list', {})).value.tasks, [task])
  assert.equal((await callTask(next.rpc, 'create', input)).value.task.id, task.id)
  assert.equal((await callTask(next.rpc, 'create', { ...input, stage: 'doing' })).error.code, 'tasks/request-conflict')
  assert.equal((await callTask(next.rpc, 'set-stage', { taskId: task.id, expectedRevision: 1, stage: 'done' })).value.task.revision, 2)
  assert.equal(readTaskDatabase(first.storageRoot).unit.version, 8)
})

test('browser selection callbacks persist preferences, display metadata, and filter actual task cards', async t => {
  const host = await mountHost(t, { workspaces: () => [workspace], modelCatalog: async () => catalog() })
  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')
  client.tasks.openForm('doing')
  await client.tasks.loadOptions()
  await until(() => client.tasks.getSnapshot().options.status === 'ready')
  const field = name => client.render().find(node => node.props?.name === name)
  field('title').props.onChange({ target: { value: 'Bound task' } })
  field('workspaceId').props.onChange({ target: { value: workspaceId } })
  field('model').props.onChange({ target: { value: JSON.stringify([model.provider, model.model]) } })
  client.tasks.closeForm()
  client.tasks.openForm()
  assert.equal(client.tasks.getSnapshot().form.stage, 'doing')
  assert(client.render().some(node => node.props?.role === 'dialog' && node.props.className.includes('dsh-tasks-drawer')))
  await client.tasks.create()
  assert.equal(client.tasks.getSnapshot().tasks[0].workspaceId, workspaceId)
  assert.deepEqual(client.tasks.getSnapshot().tasks[0].model, model)
  assert(client.render().includes('acme-web'))
  assert(client.render().includes('· Model A'))
  client.tasks.setWorkspaceFilter('ungrouped')
  assert.equal(client.render().filter(node => node.type === 'article').length, 0)
  client.tasks.setWorkspaceFilter(workspaceId)
  assert.equal(client.render().filter(node => node.type === 'article').length, 1)
  client.tasks.openDetails(client.tasks.getSnapshot().tasks[0].id)
  assert(client.render().some(node => node.props?.role === 'dialog' && node.props['aria-label'] === '任务详情'))
  assert(client.render().includes('F:/work/acme-web'))
  const taskId = client.tasks.getSnapshot().detailId
  const select = (name, value) => field(name).props.onChange({ target: { value } })
  select('model', '')
  select('model', JSON.stringify([model.provider, model.model]))
  assert.equal(client.tasks.getSnapshot().editor, undefined)
  select('workspaceId', '')
  select('model', '')
  await client.tasks.saveDetails()
  assert.equal(client.render().filter(node => node.type === 'article').length, 0)
  client.tasks.closeDetails()
  client.tasks.openDetails(taskId)
  assert.equal(field('workspaceId').props.value, '')
  assert.equal(field('model').props.value, '')
  select('workspaceId', workspaceId)
  select('model', JSON.stringify([model.provider, model.model]))
  await client.tasks.saveDetails()
  assert.equal(client.render().filter(node => node.type === 'article').length, 1)
  client.tasks.openLaunch(taskId)
  assert.equal(client.tasks.getSnapshot().launchForm.workspaceId, workspaceId)
  assert.deepEqual(client.tasks.getSnapshot().launchForm.model, model)
})

test('the board workspace picker includes empty Host workspaces and keeps its selection when clearing other filters', async t => {
  const emptyWorkspace = { id: 'c28e3f19-fcca-4ba9-8fcd-54ea8f1fa703', title: 'No tasks yet', path: 'F:/work/empty' }
  const host = await mountHost(t, { workspaces: () => [workspace, emptyWorkspace] })
  await callTask(host.rpc, 'create', { title: 'Bound task', requestId: 'bound', workspaceId, priority: 'P1' })
  await callTask(host.rpc, 'create', { title: 'Ungrouped task', requestId: 'unbound' })
  const client = await mountClient(t, host.rpc, { fetch: host.fetchAuthenticated })
  await waitForState(client.tasks, 'ready')
  await until(() => client.tasks.getSnapshot().sync === 'live')
  await client.tasks.loadOptions()
  await until(() => client.tasks.getSnapshot().options.workspaceStatus === 'ready')
  const picker = () => client.render().find(node => node.type === 'input' && node.props['aria-label'] === '按工作区筛选')
  const articles = () => client.render().filter(node => node.type === 'article')
  // The lightweight renderer does not mount DOM refs. Inspect the picker options here;
  // selection via the actual combobox is exercised by the Chromium layout probe.
  assert.equal(picker().props.value, '全部工作区')
  assert(client.render().some(node => node.props?.role === 'option' && node.props.children.includes(emptyWorkspace.title)))
  assert.equal(articles().length, 2)
  client.tasks.setWorkspaceFilter(workspaceId)
  client.tasks.setFilter('priority', 'P2')
  assert.equal(articles().length, 0)
  client.tasks.clearFilters()
  assert.equal(picker().props.value, workspace.title)
  assert.equal(articles().length, 1)
  client.tasks.setWorkspaceFilter(emptyWorkspace.id)
  assert.equal(articles().length, 0)
  client.tasks.setWorkspaceFilter('ungrouped')
  assert.equal(articles().length, 1)
  client.tasks.setWorkspaceFilter('')
  assert.equal(articles().length, 2)
})

test('preference edits validate new selections atomically and allow clearing stale ones', async t => {
  let available = true
  const host = await mountHost(t, { workspaces: () => [workspace], modelCatalog: async () => available ? catalog() : { groups: [], failures: [] } })
  const task = (await callTask(host.rpc, 'create', { requestId: 'initial', title: 'Initial' })).value.task
  const update = (requestId, expectedRevision, patch) => callTask(host.rpc, 'update', { taskId: task.id, requestId, expectedRevision, patch })
  assert.equal((await update('invalid', 1, { workspaceId, model: { ...model, model: 'missing' } })).error.code, 'tasks/model-unavailable')
  const changed = await update('select', 1, { workspaceId, model })
  assert.deepEqual(changed.value.task.model, model)
  available = false
  assert.equal((await update('select', 1, { workspaceId, model })).value.mutation.replayed, true)
  const cleared = await update('clear', 2, { workspaceId: null, model: null })
  assert(!('workspaceId' in cleared.value.task))
  assert(!('model' in cleared.value.task))
})

test('unknown creation with bindings survives Client reload and keeps identical payload and initial column', async t => {
  const host = await mountHost(t, { workspaces: () => [workspace], modelCatalog: async () => catalog() })
  let lose = true
  const inputs = []
  const rpc = { async call(channel, endpoint, payload, signal) {
    const result = await host.rpc.call(channel, endpoint, payload, signal)
    if (payload.operation === 'create') {
      inputs.push(JSON.stringify(payload.input))
      if (lose) { lose = false; throw new Error('lost committed response') }
    }
    return result
  } }
  const first = await mountClient(t, rpc)
  await waitForState(first.tasks, 'ready')
  first.tasks.openForm('done')
  first.tasks.editForm('title', 'Bound retry')
  first.tasks.editForm('workspaceId', workspaceId)
  first.tasks.editForm('model', model)
  await first.tasks.create()
  await first.plugin.dispose()
  const next = await mountClient(t, rpc, { sessionStorage: first.sessionStorage })
  await waitForState(next.tasks, 'ready')
  assert.equal(next.tasks.getSnapshot().form.stage, 'done')
  assert.equal(next.tasks.getSnapshot().form.workspaceId, workspaceId)
  assert(next.render().find(node => node.type === 'fieldset').props.disabled)
  await next.tasks.create()
  assert.equal(inputs[0], inputs[1])
  assert.equal(next.tasks.getSnapshot().tasks.length, 1)
  assert.equal(next.tasks.getSnapshot().tasks[0].stage, 'done')
})

async function until(predicate) {
  const deadline = Date.now() + 3000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out')
    await new Promise(resolve => setImmediate(resolve))
  }
}
