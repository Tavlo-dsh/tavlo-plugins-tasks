import assert from 'node:assert/strict'
import test from 'node:test'
import { mountClient, waitForState } from './fixtures.mjs'

const currentId = 'session-11111111-1111-4111-8111-111111111111'
const historyId = '22222222-2222-4222-8222-222222222222'
const unrelatedId = 'session-33333333-3333-4333-8333-333333333333'
const record = (id, title, links = {}) => ({ id, title, ...links, revision: 1,
  position: 1, stage: 'todo', createdAt: '2026-11-17T01:00:00.000Z', updatedAt: '2026-11-17T01:00:00.000Z' })
const ok = value => ({ ok: true, value })
const actions = (client, sessionId) => Array.from(client.resolveSessionMenu(sessionId))
const menuId = 'tavlo-tasks.open-linked-task'

async function fixture(t, initial, extra = {}) {
  const selected = []
  let rows = initial
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation, input }) {
    if (operation === 'list') return ok({ tasks: rows })
    if (operation === 'options') return ok({ groups: [], workspaces: [], workspaceStatus: 'ready', modelStatus: 'ready' })
    return extra[operation](input)
  } }, { layout: { selectPanel: id => selected.push(id) }, ...extra.client })
  await waitForState(client.tasks, 'ready')
  return { client, selected, async replace(next) { rows = next; await client.retry() } }
}

test('a linked session menu opens the task detail regardless of board filters and preserves the create draft', async t => {
  const target = record('linked', 'Linked task', { activeSessionId: currentId, previousSessionIds: [historyId] })
  const { client, selected } = await fixture(t, [target, record('plain', 'Not linked')])
  assert.equal(actions(client, unrelatedId).length, 0)
  assert.equal(actions(client, undefined).length, 0)
  assert.equal(actions(client, currentId)[0].label, '打开关联任务')
  client.tasks.setQuery('concealed')
  client.tasks.setWorkspaceFilter('different workspace')
  client.tasks.setFilter('priority', 'P0')
  client.tasks.toggleColumn('todo')
  client.tasks.openForm()
  client.tasks.editForm('title', 'Unsaved draft')
  actions(client, historyId)[0].run()
  assert.deepEqual(selected, ['tasks'])
  const { detailId, form, query, filters, workspaceFilter, collapsed } = client.tasks.getSnapshot()
  assert.equal(detailId, target.id)
  assert.equal(query, 'concealed')
  assert.equal(filters.priority, 'P0')
  assert.equal(workspaceFilter, 'different workspace')
  assert.equal(collapsed['stage:todo'], true)
  assert.equal(form.open, false)
  assert.equal(form.title, 'Unsaved draft')
  assert(client.render().some(node => node.props?.className?.split?.(' ').includes('dsh-tasks-drawer')))
})

test('查看进度 opens the exact already-executing session without launching', async t => {
  const opened = []
  const task = { ...record('ongoing', 'Already doing this', { activeSessionId: currentId }), stage: 'doing' }
  const { client } = await fixture(t, [task], { client: { navigate: id => opened.push(id) } })
  const buttons = client.render().filter(node => node.type === 'button')
  const progress = buttons.find(button => button.props.children === '查看进度')
  assert(progress); assert(!buttons.some(button => button.props.children === '开始任务'))
  progress.props.onClick()
  assert.deepEqual(opened, [currentId]); assert.equal(client.tasks.getSnapshot().launchForm, undefined)
})

test('multi-task menus prefer the active match, deduplicate and revalidate when clicked', async t => {
  const historicalTask = record('history', 'Previously linked', { previousSessionIds: [currentId] })
  const activeTask = record('active', 'Currently linked', { activeSessionId: currentId, previousSessionIds: [currentId] })
  const { client, selected, replace } = await fixture(t, [historicalTask, activeTask])
  const items = actions(client, currentId)
  assert.deepEqual(items.map(item => item.label), ['打开关联任务：Currently linked', '打开关联任务：Previously linked'])
  await replace([historicalTask])
  assert.throws(items[0].run, /no longer available/)
  assert.deepEqual(selected, [])
  actions(client, currentId)[0].run()
  assert.deepEqual(selected, ['tasks'])
  assert.equal(client.tasks.getSnapshot().detailId, historicalTask.id)
  await replace([])
  assert.equal(actions(client, currentId).length, 0)
})

test('jumping suspends a launch draft and restores it upon reopening the same launch', async t => {
  const target = record('linked', 'Linked task', { activeSessionId: currentId })
  const launchTask = record('launch', 'To launch')
  const { client } = await fixture(t, [target, launchTask])
  client.tasks.openLaunch(launchTask.id)
  client.tasks.editLaunch('content', 'Typed but unsent prompt')
  actions(client, currentId)[0].run()
  assert.equal(client.tasks.getSnapshot().launchForm.open, false)
  assert.equal(client.tasks.getSnapshot().detailId, target.id)
  client.tasks.openLaunch(launchTask.id)
  assert.equal(client.tasks.getSnapshot().launchForm.open, true)
  assert.equal(client.tasks.getSnapshot().launchForm.content, 'Typed but unsent prompt')
})

test('a pending write blocks navigation, and older hosts without layout still render the board', async t => {
  const target = record('linked', 'Linked task', { activeSessionId: currentId })
  const pending = Promise.withResolvers()
  const { client, selected } = await fixture(t, [target], { create: () => pending.promise })
  client.tasks.openForm()
  client.tasks.editForm('title', 'New task')
  const save = client.tasks.create()
  try {
    const action = actions(client, currentId)[0]
    assert.equal(action.disabled, true)
    assert.throws(action.run, /no longer available/)
    assert.deepEqual(selected, [])
    assert.equal(client.tasks.getSnapshot().form.open, true)
  } finally { pending.resolve({ ok: false, error: { code: 'tasks/bad-request' } }); await save }
  for (const client of [{ layout: undefined }, { contextMenus: false }]) {
    const { client: old } = await fixture(t, [target], { client })
    assert.equal(actions(old, currentId).length, 0)
    assert(old.render().some(node => node.props?.['data-task-id'] === target.id))
  }
})

test('the task action uses the shared native session menu and its keyed icon, not a legacy button', async t => {
  const target = record('linked', 'Linked task', { activeSessionId: currentId })
  const { client, replace } = await fixture(t, [target])
  const menu = client.menus.get(menuId)
  assert.equal(menu.target, 'session')
  assert.equal(menu.order, 550)
  assert(!client.slots.some(({ config }) => config.name === 'sidebar.workspaces.session.menu.item'))
  const icon = client.slots.find(({ config }) => config.name === 'contextMenu.icon')
  assert.equal(icon.config.key, actions(client, currentId)[0].icon.key)
  assert.equal(icon.component().props.size, 14)
  assert.equal(client.resolveSessionMenu(currentId, AbortSignal.abort()).length, 0)
  const [source] = menu.observe({ sessionId: currentId })
  assert.equal(source, client.tasks)
  let visible = true
  const unsubscribe = source.subscribe(() => { visible = actions(client, currentId).length > 0 })
  try { await replace([]); assert.equal(visible, false) } finally { unsubscribe() }
  await client.plugin.dispose()
  assert.equal(client.menus.size, 0)
})
