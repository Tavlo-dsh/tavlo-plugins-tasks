import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { createTaskService } from '../task-service.js'
import { openTaskStorage } from '../task-storage.js'
import { createTaskStore } from '../task-store.js'
import { mountStorage, readTaskDatabase, taskDatabasePath } from './fixtures.mjs'

const defaults = ['P0', 'P1', 'P2'].map(key => ({ key, name: key }))
const ok = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }
const code = result => { assert.equal(result.ok, false); return result.error.code }
const keys = board => board.priorities.map(row => row.key)

async function mountService(t, storageRoot) {
  const host = await mountStorage(t, { storageRoot })
  let store
  await host.own(host.ctx.plugin({
    inject: ['storage', 'storageDomain'],
    async apply(ctx) {
      await ctx.effect(async () => {
        const domain = await openTaskStorage(ctx, { databasePath: taskDatabasePath(host.storageRoot) })
        try {
          store = createTaskStore(domain, { maxTitleLength: 200, maxBriefLength: 20000, maxTasks: 10000 })
        } catch (error) {
          await domain.close()
          throw error
        }
        return () => store.close()
      })
    },
  })).await()
  const service = createTaskService(store)
  const board = async () => ok(await service.execute('board', {})).board
  const edit = input => service.execute('edit-priorities', input)
  return { ...host, service, store, board, edit }
}

function readGlobal(root) {
  const db = new DatabaseSync(taskDatabasePath(root), { readOnly: true })
  try { return JSON.parse(db.prepare('SELECT value FROM unit_globals WHERE unit = ?').get('tasks').value) }
  finally { db.close() }
}

test('unconfigured boards serve defaults without writing them and publish board snapshots', async t => {
  const host = await mountService(t)
  const stored = readGlobal(host.storageRoot)
  assert.equal(Object.hasOwn(stored.board, 'priorities'), false)
  const capabilities = await host.service.capabilities()
  assert.equal(capabilities.features.boardPriorities, true)
  assert(capabilities.operations.includes('edit-priorities'))

  const snapshots = [], legacy = []
  const off = await host.store.watch(event => snapshots.push(event), undefined, true)
  const offLegacy = await host.service.watch(event => legacy.push(event))
  const initial = await host.board()
  assert.deepEqual(initial, { ...stored.board, priorities: defaults })
  assert.deepEqual(snapshots[0].board, initial)
  initial.priorities[0].name = 'Caller mutation'
  assert.deepEqual((await host.board()).priorities, defaults)

  // Rendering the defaults, even in another board operation, is not a migration.
  const noop = await host.edit({ action: 'edit', key: 'P0', name: ' P0 ', expectedRevision: 1 })
  assert.equal(ok(noop).board.revision, 1)
  assert.equal(snapshots.length, 1)
  assert.deepEqual(readGlobal(host.storageRoot), stored)
  const labeled = ok(await host.service.execute('edit-labels', { action: 'add', name: 'Review', color: '#112233', expectedRevision: 1 })).board
  assert.deepEqual(labeled.priorities, defaults)
  assert.equal(Object.hasOwn(readGlobal(host.storageRoot).board, 'priorities'), false)

  const edited = await host.edit({ action: 'edit', key: 'P0', name: 'Urgent', expectedRevision: 2 })
  const resolved = ok(edited).board
  assert.deepEqual(resolved.labels, labeled.labels)
  assert.deepEqual(snapshots.map(event => [event.type, event.sequence, event.board.revision]), [
    ['snapshot', 0, 1], ['board', 0, 2], ['board', 0, 3],
  ])
  assert.equal(snapshots[2].streamId, edited.streamId)
  assert.deepEqual(snapshots[2].board, resolved)
  assert.deepEqual(legacy.map(event => event.type), ['snapshot'])
  off(); offLegacy()
})

test('the catalog normalizes values, uses exact keys, and serializes mutations on the board revision', async t => {
  const { board, edit } = await mountService(t)
  const add = { action: 'add', key: ' p0 ', name: '  Later  ', expectedRevision: 1 }
  const [first, stale] = await Promise.all([edit(add), edit({ ...add, key: 'Alternate' })])
  assert.equal(code(stale), 'tasks/revision-conflict')
  assert.deepEqual(ok(first).board.priorities, [...defaults, { key: 'p0', name: 'Later' }])
  assert.equal(code(await edit({ ...add, expectedRevision: 2 })), 'tasks/priority-duplicate')
  for (const action of ['edit', 'remove', 'reorder']) {
    const fields = action === 'edit' ? { name: 'New' } : action === 'reorder' ? { before: 'P1' } : {}
    assert.equal(code(await edit({ action, key: 'missing', expectedRevision: 2, ...fields })), 'tasks/priority-missing')
  }

  const reorder = (key, before, expectedRevision) => edit({ action: 'reorder', key, before, expectedRevision })
  assert.equal(code(await reorder('p0', 'P3', 2)), 'tasks/revision-conflict')
  assert.equal(ok(await reorder('p0', 'p0', 2)).board.revision, 2)
  assert.deepEqual(keys(ok(await reorder('p0', ' P1 ', 2)).board), ['P0', 'p0', 'P1', 'P2'])
  assert.equal(ok(await reorder('p0', 'P1', 3)).board.revision, 3)
  assert.deepEqual(keys(ok(await reorder('P0', null, 3)).board), ['p0', 'P1', 'P2', 'P0'])
  assert.equal(ok(await reorder('P0', null, 4)).board.revision, 4)
  assert.deepEqual(ok(await edit({ action: 'edit', key: 'p0', name: 'New name', expectedRevision: 4 })).board.priorities[0], { key: 'p0', name: 'New name' })
  assert.equal((await board()).revision, 5)
})

test('priority removal protects exact live references without rewriting tasks or restricting free-form input', async t => {
  const host = await mountService(t)
  const { service, edit } = host
  const preset = ok(await service.execute('create', { requestId: 'preset', title: 'Default value', priority: 'P0', stage: 'done' })).task
  const custom = ok(await service.execute('create', { requestId: 'custom', title: 'Old free-form value', priority: ' legacy ' })).task
  const stored = readTaskDatabase(host.storageRoot)
  assert.equal(code(await edit({ action: 'remove', key: 'P0', expectedRevision: 1 })), 'tasks/priority-in-use')
  ok(await edit({ action: 'add', key: 'p0', name: 'Lowercase', expectedRevision: 1 }))
  ok(await edit({ action: 'remove', key: 'p0', expectedRevision: 2 }))
  ok(await edit({ action: 'add', key: 'legacy', name: 'Imported', expectedRevision: 3 }))
  assert.equal(code(await edit({ action: 'remove', key: 'legacy', expectedRevision: 4 })), 'tasks/priority-in-use')
  ok(await edit({ action: 'edit', key: 'legacy', name: 'Renamed', expectedRevision: 4 }))
  ok(await edit({ action: 'reorder', key: 'legacy', before: 'P0', expectedRevision: 5 }))
  assert.deepEqual(readTaskDatabase(host.storageRoot), stored)
  assert.deepEqual(ok(await service.execute('get', { taskId: preset.id })).task, preset)
  assert.deepEqual(ok(await service.execute('list', { priority: ' legacy ' })).tasks, [custom])

  const updated = ok(await service.execute('update', { taskId: custom.id, expectedRevision: 1, requestId: 'changed', patch: { priority: ' still free-form ' } })).task
  assert.equal(updated.priority, 'still free-form')
  ok(await edit({ action: 'remove', key: 'legacy', expectedRevision: 6 }))
  const final = ok(await edit({ action: 'edit', key: 'P1', name: 'Normal', expectedRevision: 7 })).board
  const global = readGlobal(host.storageRoot)
  assert.deepEqual(global.board, final)
  assert.equal(global.migration.state, 'complete')
  await host.shutdown()
  const reopened = await mountService(t, host.storageRoot)
  assert.deepEqual(await reopened.board(), final)
  assert.equal(readTaskDatabase(host.storageRoot).unit.version, stored.unit.version)
  assert.deepEqual(readGlobal(host.storageRoot), global)
  assert.deepEqual(ok(await reopened.service.execute('get', { taskId: custom.id })).task, updated)
})

test('an explicit empty catalog persists instead of falling back to defaults', async t => {
  const host = await mountService(t)
  for (const [index, { key }] of defaults.entries()) {
    ok(await host.edit({ action: 'remove', key, expectedRevision: index + 1 }))
  }
  await host.shutdown()
  const reopened = await mountService(t, host.storageRoot)
  assert.deepEqual((await reopened.board()).priorities, [])
  assert.equal((await reopened.board()).revision, 4)
})

test('priority mutations enforce input validation and the 100-definition capacity', async t => {
  const { board, edit } = await mountService(t)
  const add = { expectedRevision: 1, action: 'add', key: 'x', name: 'Name' }
  for (const patch of [{ key: ' ' }, { key: 'x'.repeat(33) }, { name: ' ' }, { name: 'x'.repeat(81) }, { expectedRevision: 0 },
    { action: 'rename' }, { before: 'P0' }]) {
    assert.equal(code(await edit({ ...add, ...patch })), 'tasks/bad-request')
  }
  assert.equal(code(await edit({ action: 'reorder', key: 'P0', expectedRevision: 1 })), 'tasks/bad-request')
  assert.equal(code(await edit({ action: 'reorder', key: 'P0', before: ' ', expectedRevision: 1 })), 'tasks/bad-request')
  const max = { key: 'x'.repeat(32), name: 'y'.repeat(80) }
  assert.deepEqual(ok(await edit({ ...add, key: ` ${max.key} `, name: ` ${max.name} ` })).board.priorities.at(-1), max)
  for (let i = 4; i < 100; i++) ok(await edit({ ...add, key: `custom-${i}`, expectedRevision: i - 2 }))
  assert.equal((await board()).priorities.length, 100)
  assert.equal(code(await edit({ ...add, expectedRevision: 98 })), 'tasks/limit-reached')
  assert.equal((await board()).revision, 98)
})
