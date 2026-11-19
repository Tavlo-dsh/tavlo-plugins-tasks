import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { emptyList, mountClient } from './fixtures.mjs'

const record = (id, priority, position) => ({
  id, title: id, priority, position, revision: 1, stage: 'todo',
  createdAt: '2026-11-17T01:00:00.000Z', updatedAt: '2026-11-17T01:00:00.000Z',
})

function priorityPicker(client, emptyLabel) {
  const label = client.render().find(node => node.type === 'label'
    && node.props.children[0] === '优先级'
    && node.props.children[1].props.children[0].props.children === emptyLabel)
  assert(label, `Missing priority picker with default ${emptyLabel}`)
  const picker = label.props.children[1]
  return new picker.type(picker.props)
}

const choices = picker => Array.from(picker.options(), row => [row.value, row.label])
function select(picker, value, query = '', create = false) {
  const index = picker.matches(query).findIndex(row => row.value === value && !!row.create === create)
  assert(index >= 0, `Missing option for ${value}`)
  picker.state.query = query
  picker.trigger = { matches: () => false, focus() {} }
  picker.close = () => {}
  picker.choose(index)
}

async function waitForBoard(client, revision) {
  const deadline = Date.now() + 3000
  while (client.tasks.getSnapshot().board?.revision !== revision) {
    assert(Date.now() < deadline, `Board revision ${revision} did not arrive`)
    await setImmediate()
  }
}

test('Web priority pickers and displays use the live catalog without replacing task keys', async t => {
  const board = { revision: 1, columns: [{ id: 'stage:todo', stage: 'todo' }], labels: [] }
  const tasks = [record('high', 'P0', 0), record('legacy', 'old-key', 1), record('collision', 'overdue', 2)]
  let stream
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation }) {
    if (operation === 'list') return emptyList()
    assert.equal(operation, 'options')
    return { ok: true, value: { groups: [], workspaces: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
  } }, { fetch: async (_url, { signal }) => new Response(new ReadableStream({ start(controller) {
    stream = controller
    signal.addEventListener('abort', () => controller.close(), { once: true })
  } }), { headers: { 'content-type': 'text/event-stream' } }) })
  const send = event => stream.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ streamId: 'priority-test', sequence: 0, ...event }) + '\n\n'))
  send({ type: 'snapshot', tasks, board })
  await waitForBoard(client, 1)
  assert.deepEqual(choices(priorityPicker(client, '全部')), [
    ['', '全部'], ['P0', 'P0'], ['P1', 'P1'], ['P2', 'P2'], ['old-key', 'old-key'], ['overdue', 'overdue'],
  ])

  const priorities = [{ key: 'chore', name: 'Maintenance' }, { key: 'P0', name: 'Urgent' }]
  send({ type: 'board', board: { ...board, revision: 2, priorities } })
  await waitForBoard(client, 2)
  const expected = [['chore', 'Maintenance'], ['P0', 'Urgent'], ['old-key', 'old-key'], ['overdue', 'overdue']]
  const filter = priorityPicker(client, '全部')
  assert.deepEqual(choices(filter), [['', '全部'], ...expected])
  assert(!filter.matches('unassigned-key').some(row => row.create))
  assert(client.render().some(node => node.props?.tone === 'warning' && node.props.children.props.title === 'P0'
    && node.props.children.props.children === 'Urgent'))
  assert(client.render().includes('Urgent · 1'))
  assert(client.render().some(node => node.props?.['aria-label'] === 'high · 高优先级 · Urgent'))
  assert(!client.render().some(node => node.props?.['aria-label']?.startsWith('collision · ')))
  select(filter, 'P0', 'Urgent')
  assert.equal(client.tasks.getSnapshot().filters.priority, 'P0')
  assert.deepEqual(Array.from(client.render().filter(node => node.type === 'article'), card => card.props['data-task-id']), ['high'])
  client.tasks.clearFilters()

  client.tasks.openForm()
  const create = priorityPicker(client, '无')
  assert.deepEqual(choices(create), [['', '无'], ...expected])
  assert(!create.matches('P0').some(row => row.create))
  select(create, 'chore', 'Maintenance')
  assert.equal(client.tasks.getSnapshot().form.priority, 'chore')
  select(priorityPicker(client, '无'), 'Urgent', 'Urgent', true)
  assert.equal(client.tasks.getSnapshot().form.priority, 'Urgent', 'a display name does not reserve a free-form key')
  assert.deepEqual(choices(priorityPicker(client, '无')).at(-1), ['Urgent', 'Urgent'])
  client.tasks.closeForm()

  client.tasks.openDetails('legacy')
  const edit = priorityPicker(client, '无')
  assert.deepEqual(choices(edit), [['', '无'], ...expected])
  assert.equal(edit.props.value, 'old-key')
  select(edit, 'P0', 'Urgent')
  assert.equal(client.tasks.getSnapshot().editor.priority, 'P0')

  send({ type: 'board', board: { ...board, revision: 3, priorities: [] } })
  await waitForBoard(client, 3)
  assert.deepEqual(choices(priorityPicker(client, '全部')), [['', '全部'], ['P0', 'P0'], ['old-key', 'old-key'], ['overdue', 'overdue']])
  assert(client.render().some(node => node.props?.['aria-label'] === 'high · 高优先级 · P0'))
})
