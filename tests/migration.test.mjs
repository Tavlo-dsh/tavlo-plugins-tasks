import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'
import * as tasksHost from '../index.js'
import { taskDomain } from '../task-schema.js'
import { createTaskStore } from '../task-store.js'
import { callTask, mountHost, mountStorage, readTaskDatabase, writeTaskDatabase, taskDatabasePath, RPC_PATH } from './fixtures.mjs'

const upgraded = records => Object.fromEntries(Object.entries(records).map(([id, row]) => [id, row._deleted ? row : { ...row, columnId: 'stage:' + row.stage }]))

async function seedLegacy(t, version = 4) {
  const storage = await mountStorage(t)
  const domain = await storage.ctx.get('storageDomain').open(taskDomain)
  const store = createTaskStore(domain, { maxTitleLength: 200, maxBriefLength: 20000, maxTasks: 100 })
  const input = { requestId: 'legacy-intent', title: '迁移保留原任务', brief: '历史描述' }
  const task = (await store.execute('create', input)).value.task
  const removed = (await store.execute('create', { requestId: 'deleted-intent', title: 'Deleted' })).value.task
  await store.execute('delete', { taskId: removed.id, expectedRevision: 1 })
  await store.close()
  await storage.shutdown()
  const file = join(storage.storageRoot, 'tasks.json')
  const document = JSON.parse(await readFile(file, 'utf8'))
  document.unit.version = version
  if (version === 1) delete document.tables.tasks[task.id]._create.stage
  if (version >= 3) {
    const record = document.tables.tasks[task.id]
    const sessionId = randomUUID()
    const receipt = { input: { taskId: task.id, requestId: 'old-launch', expectedRevision: 1, content: 'Work', replaceActive: false }, sessionId, phase: 'complete' }
    Object.assign(record, { launch: receipt, _launches: [receipt], activeSessionId: sessionId,
      previousSessionIds: [randomUUID()], workspaceId: randomUUID(), model: { provider: 'old', model: 'old-model' } })
  }
  const bytes = JSON.stringify(document)
  await writeFile(file, bytes)
  return { ...storage, file, bytes, document, input, task, removed }
}

for (const version of [1, 2, 3, 4]) test(`legacy JSON v${version} migrates intact, including requests and sessions, and is never imported again`, async t => {
  const legacy = await seedLegacy(t, version)
  const first = await mountHost(t, { storageRoot: legacy.storageRoot })
  assert.equal((await readFile(taskDatabasePath(legacy.storageRoot))).subarray(0, 16).toString(), 'SQLite format 3\0')
  assert.deepEqual(readTaskDatabase(legacy.storageRoot).tables.tasks, upgraded(legacy.document.tables.tasks))
  assert.equal(await readFile(legacy.file, 'utf8'), legacy.bytes)
  const replay = await callTask(first.rpc, 'create', legacy.input)
  assert(replay.ok)
  assert.equal(replay.value.task.id, legacy.task.id)
  assert.equal((await callTask(first.rpc, 'create', { requestId: 'deleted-intent', title: 'Deleted' })).error.code, 'tasks/deleted')
  assert((await callTask(first.rpc, 'update', { taskId: legacy.task.id, requestId: 'post-migration', expectedRevision: 1, patch: { title: 'New SQLite title' } })).ok)
  await first.shutdown()
  // An old JSON backup is no longer authoritative after the completion marker.
  await writeFile(legacy.file, '{obsolete, even unreadable}')
  const second = await mountHost(t, { storageRoot: legacy.storageRoot })
  assert.equal((await callTask(second.rpc, 'get', { taskId: legacy.task.id })).value.task.title, 'New SQLite title')
  assert.equal(await readFile(legacy.file, 'utf8'), '{obsolete, even unreadable}')
  await second.shutdown()
})

test('an interrupted migration publishes no service and resumes the exact partial copy', async t => {
  const legacy = await seedLegacy(t)
  let writes = 0
  const first = await mountHost(t, { storageRoot: legacy.storageRoot, activate: false, wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (...args) => {
      if (++writes === 2) throw new Error('migration interrupted')
      return target.putRecord(...args)
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const failed = first.own(first.ctx.plugin(tasksHost))
  await assert.rejects(failed.await(), /migration interrupted/)
  assert.equal(first.ctx.get('taskService'), undefined)
  assert.equal((await first.fetchAuthenticated(RPC_PATH, { method: 'POST' })).status, 404)
  assert.equal(Object.keys(readTaskDatabase(legacy.storageRoot).tables.tasks).length, 1)
  assert.equal(await readFile(legacy.file, 'utf8'), legacy.bytes)
  await first.shutdown()
  const next = await mountHost(t, { storageRoot: legacy.storageRoot })
  assert.deepEqual(readTaskDatabase(legacy.storageRoot).tables.tasks, upgraded(legacy.document.tables.tasks))
  assert.equal((await callTask(next.rpc, 'list', {})).value.tasks.length, 1)
  await next.shutdown()
})

test('changed legacy input after a partial copy fails closed and can recover after restoring the source', async t => {
  const legacy = await seedLegacy(t)
  const first = await mountHost(t, { storageRoot: legacy.storageRoot })
  await first.shutdown()
  // Model a crash just before the final durable marker; all copied rows still match.
  writeTaskDatabase(legacy.storageRoot, legacy.document)
  const db = new DatabaseSync(taskDatabasePath(legacy.storageRoot))
  const metadata = JSON.parse(db.prepare('SELECT value FROM unit_globals WHERE unit = ?').get('tasks').value)
  metadata.migration.state = 'copying'
  db.prepare('UPDATE unit_globals SET value = ? WHERE unit = ?').run(JSON.stringify(metadata), 'tasks')
  db.close()
  const changed = structuredClone(legacy.document)
  changed.tables.tasks[legacy.task.id].title = 'Changed by old writer'
  await writeFile(legacy.file, JSON.stringify(changed))
  const broken = await mountHost(t, { storageRoot: legacy.storageRoot, activate: false })
  const plugin = broken.own(broken.ctx.plugin(tasksHost))
  await assert.rejects(plugin.await(), /legacy data changed/)
  assert.deepEqual(readTaskDatabase(legacy.storageRoot).tables.tasks, legacy.document.tables.tasks)
  await broken.shutdown()
  await writeFile(legacy.file, legacy.bytes)
  const recovered = await mountHost(t, { storageRoot: legacy.storageRoot })
  assert((await callTask(recovered.rpc, 'list', {})).ok)
  await recovered.shutdown()
})

test('invalid legacy schema or duplicate identities never become a usable SQLite database', async t => {
  for (const kind of ['schema', 'identity']) await t.test(kind, async t => {
    const legacy = await seedLegacy(t)
    if (kind === 'schema') legacy.document.tables.tasks[legacy.task.id].stage = 'invalid'
    else {
      const id = randomUUID()
      legacy.document.tables.tasks[id] = { ...legacy.document.tables.tasks[legacy.task.id], id }
    }
    const bad = JSON.stringify(legacy.document)
    await writeFile(legacy.file, bad)
    const host = await mountHost(t, { storageRoot: legacy.storageRoot, activate: false })
    const failed = host.own(host.ctx.plugin(tasksHost))
    await assert.rejects(failed.await())
    assert.equal(host.ctx.get('taskService'), undefined)
    assert.deepEqual(readTaskDatabase(legacy.storageRoot).tables.tasks, {})
    assert.equal(await readFile(legacy.file, 'utf8'), bad)
    await host.shutdown()
  })
})
