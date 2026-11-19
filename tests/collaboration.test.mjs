import assert from 'node:assert/strict'
import test from 'node:test'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { callTask, mountClient, mountHost, waitForState } from './fixtures.mjs'

const ok = result => { assert(result.ok, JSON.stringify(result)); return result.value }

test('shared label identity, dates, completion transitions and idempotent edits', async context => {
  const host = await mountHost(context)
  const call = (op, input) => callTask(host.rpc, op, input)
  const { board } = ok(await call('edit-labels', { action: 'add', expectedRevision: 1, color: '#bbccdd', name: 'Review' }))
  const labelId = board.labels[0].id
  const column = ok(await call('edit-columns', { action: 'add', expectedRevision: 2, stage: 'done', name: 'Accepted' })).board.columns.at(-1)
  const creation = { requestId: 'new', title: 'Delivery', labelId, priority: '本周优先', dueDate: '2028-02-29', stage: 'done' }
  assert.equal((await call('create', { ...creation, dueDate: '2027-02-29' })).error.code, 'tasks/bad-request')
  const { task } = ok(await call('create', creation)), taskId = task.id
  assert.equal(task.completedAt, task.createdAt)
  const due = { labelId, priority: creation.priority, query: 'LIVERY', today: creation.dueDate }
  assert.equal(ok(await call('list', { ...due, due: 'today' })).tasks.length, 0)
  assert.equal(ok(await call('move', { taskId, columnId: column.id, expectedRevision: 1 })).task.completedAt, task.completedAt)
  ok(await call('edit-columns', { action: 'rename', expectedRevision: 3, columnId: column.id, name: 'Approved' }))
  ok(await call('edit-labels', { action: 'edit', expectedRevision: 4, labelId, name: 'QA', color: '#112233' }))
  assert.equal((await call('edit-labels', { action: 'remove', expectedRevision: 5, labelId })).error.code, 'tasks/label-in-use')
  assert.equal(ok(await call('set-stage', { taskId, expectedRevision: 2, stage: 'todo' })).task.completedAt, undefined)
  assert.equal(ok(await call('list', { ...due, due: 'today' })).tasks[0].id, taskId)
  assert.equal(ok(await call('list', { ...due, due: 'overdue' })).tasks.length, 0)
  assert.equal(ok(await call('list', { ...due, today: '2028-03-01', due: 'overdue' })).tasks.length, 1)
  const patch = { taskId, requestId: 'clear', expectedRevision: 3, patch: { labelId: null } }
  ok(await call('update', patch)); ok(await call('update', patch))
  ok(await call('edit-labels', { action: 'remove', expectedRevision: 5, labelId }))
  ok(await call('create', creation))
  const history = ok(await call('history', { taskId })).events.reverse()
  assert.deepEqual(history.map(row => row.kind), ['created', 'completed', 'moved', 'moved', 'reopened', 'updated'])
  assert.equal(history[2].to, column.id)
  assert.deepEqual(history.at(-1).fields, ['labelId'])
})

test('interrupted archive rotation, unknown commit and restart preserve exact paged history', async context => {
  let fail, archived = false
  const host = await mountHost(context, { wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (table, ...args) => {
      if (fail === table) throw new Error('injected rejection')
      await target.putRecord(table, ...args)
      if (table === 'activity') archived = true
      if (fail === 'unknown' && table === 'tasks') throw new StorageError('unknown-state', 'lost commit acknowledgement')
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const call = (op, input) => host.ctx.taskService.execute(op, input)
  const taskId = ok(await call('create', { requestId: 'new', title: 'Hello' })).task.id
  const comment = index => ({ taskId, requestId: `comment-${index}`, text: `private comment ${index}` })
  const seen = [], off = await host.ctx.taskService.watch(event => seen.push(event))
  for (let index = 1; index <= 31; index++) ok(await call('comment', comment(index)))
  fail = 'activity'
  assert.equal((await call('comment', comment(32))).error.code, 'tasks/persistence-failed')
  fail = 'tasks'
  assert.equal((await call('comment', comment(32))).error.code, 'tasks/persistence-failed')
  assert(archived)
  assert.equal(ok(await call('history', { taskId })).events[0].id, 32)
  fail = 'unknown'
  assert.equal((await call('comment', comment(32))).error.code, 'tasks/persistence-unknown')
  assert(!JSON.stringify(seen).includes('private comment'))
  off(); await host.shutdown()
  const reopened = await mountHost(context, { storageRoot: host.storageRoot })
  const after = (op, input) => reopened.ctx.taskService.execute(op, input)
  assert.equal(ok(await after('comment', comment(32))).task.commentCount, 32)
  assert.equal(ok(await after('comment', comment(3))).task.revision, 33)
  assert.equal((await after('comment', { ...comment(3), text: 'changed' })).error.code, 'tasks/request-conflict')
  const newest = ok(await after('history', { taskId, limit: 2 }))
  ok(await after('comment', comment(33)))
  const older = ok(await after('history', { taskId, before: newest.before, limit: 100 }))
  assert.deepEqual([...newest.events, ...older.events].map(row => row.id), Array.from({ length: 33 }, (_, index) => 33 - index))
  assert.equal(older.before, undefined)
  assert.equal(ok(await after('comment-matches', { query: 'COMMENT 19' })).matches[taskId], 'private comment 19')
  assert.equal(ok(await after('list', { query: 'comment 19' })).tasks[0].id, taskId)
  assert(!JSON.stringify(ok(await after('list', {}))).includes('private comment'))
  ok(await after('delete', { taskId, expectedRevision: 34 }))
  assert.equal((await after('history', { taskId })).error.code, 'tasks/not-found')
  assert.deepEqual(ok(await after('comment-matches', { query: 'private' })).matches, {})
})

test('lost comment response preserves comment and body drafts independently', async context => {
  const host = await mountHost(context)
  const taskId = ok(await callTask(host.rpc, 'create', { requestId: 'draft', title: 'Original' })).task.id, sent = []
  const { tasks } = await mountClient(context, { async call(...args) {
    const result = await host.rpc.call(...args)
    if (args[2].operation === 'comment' && sent.push(args[2].input) === 1) throw new Error('lost response')
    return result
  } })
  await waitForState(tasks, 'ready')
  tasks.openDetails(taskId); tasks.editDetails('title', 'Unsaved title'); tasks.editComment(taskId, 'Handover')
  await tasks.postComment(taskId)
  assert.equal(tasks.getSnapshot().comments[taskId].text, 'Handover')
  assert(tasks.getSnapshot().comments[taskId].error)
  await tasks.postComment(taskId)
  assert.deepEqual(sent[0], sent[1])
  assert.equal(tasks.getSnapshot().comments[taskId], undefined)
  assert.equal(tasks.getSnapshot().editor.title, 'Unsaved title')
  assert.equal(tasks.getSnapshot().tasks[0].commentCount, 1)
})
