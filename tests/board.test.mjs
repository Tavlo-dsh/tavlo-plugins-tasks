import assert from 'node:assert/strict'
import test from 'node:test'
import { callTask, mountHost, writeTaskDatabase } from './fixtures.mjs'
import { fusionV5Fixture } from './fusion-v5.fixture.mjs'
import * as tasksHost from '../index.js'

const ok = result => { assert(result.ok, JSON.stringify(result)); return result.value }

test('global column lifecycle, stable IDs and legacy stages survive restart', async context => {
  const host = await mountHost(context)
  const call = (operation, input) => callTask(host.rpc, operation, input)
  const legacy = []
  const dispose = await host.ctx.get('taskService').watch(event => legacy.push(event))
  const edit = input => call('edit-columns', input)
  const { board } = ok(await edit({ expectedRevision: 1, action: 'add', name: ' Review ', stage: 'doing' }))
  const columnId = board.columns.at(-1).id
  assert.equal(board.columns.at(-1).name, 'Review')
  assert.equal((await edit({ expectedRevision: 1, action: 'rename', columnId, name: 'Stale' })).error.code, 'tasks/revision-conflict')
  const create = { requestId: 'review', title: 'Check', stage: 'doing', columnId }
  const { task } = ok(await call('create', create))
  assert.equal(task.columnId, columnId)
  const same = ok(await call('set-stage', { taskId: task.id, expectedRevision: 1, stage: 'doing' })).task
  assert.equal(same.columnId, columnId)
  assert.equal(ok(await call('create', create)).task.revision, 2)
  assert.equal((await call('create', { ...create, columnId: 'stage:doing' })).error.code, 'tasks/request-conflict')
  assert.equal((await edit({ expectedRevision: 2, action: 'remove', columnId })).error.code, 'tasks/column-not-empty-or-default')
  ok(await edit({ expectedRevision: 2, action: 'rename', columnId, name: 'Verify' }))
  ok(await edit({ expectedRevision: 3, action: 'reorder', columnId, before: 'stage:todo' }))
  assert.deepEqual(legacy.map(event => [event.type, event.sequence]), [['snapshot', 0], ['upsert', 1], ['upsert', 2]])
  dispose()
  await host.shutdown()
  const second = await mountHost(context, { storageRoot: host.storageRoot })
  const after = (operation, input) => callTask(second.rpc, operation, input)
  assert.deepEqual(ok(await after('board', {})).board.columns[0], { id: columnId, stage: 'doing', name: 'Verify' })
  assert.equal(ok(await after('set-stage', { taskId: task.id, expectedRevision: 2, stage: 'done' })).task.columnId, 'stage:done')
  assert.equal((await after('edit-columns', { expectedRevision: 4, action: 'remove', columnId: 'stage:todo' })).error.code, 'tasks/column-not-empty-or-default')
  assert.equal(ok(await after('edit-columns', { expectedRevision: 4, action: 'remove', columnId })).board.columns.length, 3)
})

test('moves use stable anchors, reject stale writes and persist same-column ordering', async context => {
  const host = await mountHost(context)
  const call = (operation, input) => callTask(host.rpc, operation, input)
  const cards = []
  for (const title of ['First', 'Middle', 'Last']) cards.push(ok(await call('create', { title, requestId: title })).task)
  const [first, middle, last] = cards
  const move = { taskId: last.id, columnId: 'stage:todo', expectedRevision: 1, anchor: { taskId: first.id, side: 'before' } }
  const changed = ok(await call('move', move)).task
  assert(changed.orderKey < first.orderKey)
  assert.equal((await call('move', move)).error.code, 'tasks/revision-conflict')
  assert.equal(ok(await call('move', { ...move, expectedRevision: 2 })).task.revision, 2)
  ok(await call('move', { taskId: middle.id, columnId: 'stage:doing', expectedRevision: 1 }))
  assert.equal((await call('move', { ...move, expectedRevision: 2, anchor: { taskId: middle.id, side: 'after' } })).error.code, 'tasks/revision-conflict')
  await host.shutdown()
  const second = await mountHost(context, { storageRoot: host.storageRoot })
  const tasks = ok(await callTask(second.rpc, 'list', {})).tasks
  assert.deepEqual(tasks.filter(row => row.stage === 'todo').sort((left, right) => left.orderKey.localeCompare(right.orderKey)).map(row => row.title), ['Last', 'First'])
  assert.equal(tasks.find(row => row.id === middle.id).columnId, 'stage:doing')
})

test('interrupted v5 column backfill resumes despite unit version already advancing', async context => {
  const empty = await mountHost(context)
  await empty.shutdown()
  const fixture = fusionV5Fixture()
  writeTaskDatabase(empty.storageRoot, fixture.document)
  let writes = 0
  const broken = await mountHost(context, { storageRoot: empty.storageRoot, activate: false, wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (...args) => {
      if (++writes === 2) throw new Error('interrupted backfill')
      return target.putRecord(...args)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  await assert.rejects(broken.own(broken.ctx.plugin(tasksHost)).await(), /interrupted backfill/)
  assert.equal(broken.ctx.get('taskService'), undefined)
  await broken.shutdown()
  const repaired = await mountHost(context, { storageRoot: empty.storageRoot })
  const tasks = ok(await callTask(repaired.rpc, 'list', {})).tasks
  assert.deepEqual(tasks.map(task => task.id), fixture.orderedIds)
  assert(tasks.every(task => task.columnId === 'stage:' + task.stage && task.revision === fixture.document.tables.tasks[task.id].revision))
})

test('columns support optional custom #rrggbb colors across add, rename, clear and restart', async context => {
  const host = await mountHost(context)
  const call = (operation, input) => callTask(host.rpc, operation, input)
  const edit = input => call('edit-columns', input)

  const added = ok(await edit({ expectedRevision: 1, action: 'add', name: 'Blocked', stage: 'doing', color: '#d96b6b' })).board
  const custom = added.columns.at(-1)
  assert.equal(custom.color, '#d96b6b')

  // Omitting color on rename preserves the existing color; passing a new hex updates it.
  const kept = ok(await edit({ expectedRevision: 2, action: 'rename', columnId: custom.id, name: 'Paused' })).board
  assert.equal(kept.columns.find(col => col.id === custom.id).color, '#d96b6b')

  const recolored = ok(await edit({ expectedRevision: 3, action: 'rename', columnId: custom.id, name: 'Paused', color: '#2d9d9c' })).board
  assert.equal(recolored.columns.find(col => col.id === custom.id).color, '#2d9d9c')

  // Default columns also support setting and clearing custom colors.
  const defaultColored = ok(await edit({ expectedRevision: 4, action: 'rename', columnId: 'stage:todo', name: 'Backlog', color: '#e5b94c' })).board
  assert.equal(defaultColored.columns.find(col => col.id === 'stage:todo').color, '#e5b94c')

  // Passing color: null clears custom color and restores absence on persisted row.
  const clearedCustom = ok(await edit({ expectedRevision: 5, action: 'rename', columnId: custom.id, name: 'Paused', color: null })).board
  assert.equal('color' in clearedCustom.columns.find(col => col.id === custom.id), false)

  // Invalid color formats are rejected cleanly.
  assert.equal((await edit({ expectedRevision: 6, action: 'add', name: 'Bad', stage: 'doing', color: 'red' })).ok, false)
  assert.equal((await edit({ expectedRevision: 6, action: 'rename', columnId: custom.id, name: 'Bad', color: '#123' })).ok, false)

  await host.shutdown()
  const reopened = await mountHost(context, { storageRoot: host.storageRoot })
  const after = ok(await callTask(reopened.rpc, 'board', {})).board
  assert.equal(after.columns.find(col => col.id === 'stage:todo').color, '#e5b94c')
  assert.equal('color' in after.columns.find(col => col.id === custom.id), false)
  ok(await callTask(reopened.rpc, 'edit-columns', { expectedRevision: 6, action: 'rename', columnId: 'stage:todo', name: 'To do', color: null }))
  assert.equal('color' in ok(await callTask(reopened.rpc, 'board', {})).board.columns.find(col => col.id === 'stage:todo'), false)
})
