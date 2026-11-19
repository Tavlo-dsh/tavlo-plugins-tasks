import assert from 'node:assert/strict'
import test from 'node:test'
import { callTask, mountHost, readTaskDatabase, writeTaskDatabase } from './fixtures.mjs'
import { fusionV5Fixture } from './fusion-v5.fixture.mjs'

const success = result => { assert.equal(result.ok, true, JSON.stringify(result)); return result.value }

test('fusion baseline: SQLite v5 keeps ordering, source identity and all receipts on reopening', async context => {
  const fixture = fusionV5Fixture()
  const { ids } = fixture
  const empty = await mountHost(context)
  await empty.shutdown()
  writeTaskDatabase(empty.storageRoot, fixture.document)
  const prompts = []
  const sessionController = {
    state: async () => ({ cursor: 0, running: false, pendingInput: [], queue: [] }),
    create: async () => assert.fail('A saved launch must not create another session'),
    selectModel: async () => assert.fail('A sending launch has already selected its model'),
    prompt: async input => { prompts.push(input); return { accepted: true } },
  }
  const reopen = () => mountHost(context, { storageRoot: empty.storageRoot, sessionController,
    sessionQuery: { observeSession: async () => ({ events: [], [Symbol.dispose]() {} }) } })
  const host = await reopen()
  const call = (operation, input) => callTask(host.rpc, operation, input)
  const { tasks } = success(await call('list', {}))
  assert.deepEqual(tasks.map(task => task.id), fixture.orderedIds)
  assert.deepEqual(tasks.map(task => [task.stage, task.position]), [['done', 4], ['todo', 12], ['doing', 52], ['todo', 90]])
  assert.equal(Object.hasOwn(tasks[0], 'completedAt'), false)
  const sourced = tasks.find(task => task.id === ids.sourced)
  assert.deepEqual(success(await call('list', { externalRef: fixture.externalRef })).tasks, [sourced])
  assert.equal(sourced.activeSessionId, ids.active)
  assert.deepEqual(sourced.previousSessionIds, [ids.previous])
  assert.deepEqual(sourced.launch, fixture.pending)
  assert.deepEqual(success(await call('create', fixture.create)).task, sourced)
  assert.equal((await call('create', { ...fixture.create, requestId: 'f0-duplicate' })).error.code, 'tasks/external-conflict')
  assert.deepEqual(success(await call('update', fixture.update)), { task: sourced,
    mutation: { requestId: fixture.update.requestId, appliedRevision: 10, replayed: true } })
  assert.equal((await call('update', { ...fixture.update, expectedRevision: 13 })).error.code, 'tasks/request-conflict')
  assert.deepEqual(success(await call('delete', { taskId: ids.deleted, expectedRevision: 1 })), { taskId: ids.deleted, revision: 2 })
  assert.equal((await call('create', fixture.deleteCreate)).error.code, 'tasks/deleted')
  assert.equal(success(await call('launch', fixture.previous.input)).sessionId, ids.previous)
  assert.deepEqual(prompts, [])
  const disk = readTaskDatabase(host.storageRoot)
  assert.equal(disk.unit.version, 8)
  for (const row of Object.values(disk.tables.tasks)) if (!row._deleted) {
    assert.equal(row.columnId, 'stage:' + row.stage)
    delete row.columnId
  }
  assert.deepEqual(disk.tables, fixture.document.tables)

  const resumedInput = { taskId: ids.sourced, requestId: fixture.pending.input.requestId }
  const resumed = success(await call('resume-launch', resumedInput))
  assert.equal(resumed.sessionId, ids.pending)
  assert.equal(resumed.task.stage, 'doing')
  assert.deepEqual(resumed.task.previousSessionIds, [ids.previous, ids.active])
  assert.deepEqual(success(await call('history', { taskId: ids.sourced })).events.map(event => event.kind), ['bound'])
  assert.deepEqual(prompts, [{ sessionId: ids.pending, requestId: 'tasks.f0-launch-pending', mode: 'queue',
    content: [{ type: 'text', text: fixture.pending.input.content }] }])
  await host.shutdown()
  const restarted = await reopen()
  assert.deepEqual(success(await callTask(restarted.rpc, 'resume-launch', resumedInput)), resumed)
  assert.equal(prompts.length, 1)
  const sameStage = success(await callTask(restarted.rpc, 'set-stage', { taskId: ids.sourced, expectedRevision: resumed.task.revision, stage: 'doing' })).task
  assert.equal(sameStage.revision, resumed.task.revision + 1)
  assert.equal(sameStage.position, sourced.position)
  assert.equal(sameStage.activeSessionId, ids.pending)
})
