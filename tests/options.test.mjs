import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { callTask, mountHost, mountClient, waitForState } from './fixtures.mjs'

const workspaceId = 'e5d7d9aa-5952-4f71-a0d5-9c86d2286016'
const workspace = { id: workspaceId, title: 'acme-web', path: 'F:/work/acme-web' }
const model = { provider: 'configured', model: 'model-a' }
const catalog = () => ({ groups: [{ id: 'configured', name: 'Configured provider', models: [
  { id: 'model-a', name: 'Model A', reasoning: { efforts: [{ id: 'high', name: 'High' }] } },
] }], failures: [] })

test('options read Host services and preferences persist; unavailable references remain readable and replayable', async t => {
  let available = true
  const host = await mountHost(t, { workspaces: () => available ? [workspace] : [], modelCatalog: async () => available ? catalog() : { groups: [], failures: [] } })
  const options = (await callTask(host.rpc, 'options', {})).value
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

test('schema v4 opens exact legacy v1 records and preserves legacy creation deduplication', async t => {
  const first = await mountHost(t)
  const input = { requestId: 'legacy', title: 'Old task', brief: 'Before preferences' }
  const task = (await callTask(first.rpc, 'create', input)).value.task
  await first.shutdown()
  const path = join(first.storageRoot, 'tasks.json')
  const document = JSON.parse(await readFile(path, 'utf8'))
  document.unit.version = 1
  delete document.tables.tasks[task.id]._create.stage
  await writeFile(path, JSON.stringify(document))
  const next = await mountHost(t, { storageRoot: first.storageRoot })
  assert.deepEqual((await callTask(next.rpc, 'list', {})).value.tasks, [task])
  assert.equal((await callTask(next.rpc, 'create', input)).value.task.id, task.id)
  assert.equal((await callTask(next.rpc, 'create', { ...input, stage: 'doing' })).error.code, 'tasks/request-conflict')
  assert.equal((await callTask(next.rpc, 'set-stage', { taskId: task.id, expectedRevision: 1, stage: 'done' })).value.task.revision, 2)
  assert.equal(JSON.parse(await readFile(path, 'utf8')).unit.version, 4)
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
  assert(client.render().some(node => node.type === 'dialog'))
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
  assert(client.render().includes('任务详情'))
  assert(client.render().includes('F:/work/acme-web'))
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
