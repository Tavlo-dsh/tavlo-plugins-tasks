import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { mountClient, waitForState } from './fixtures.mjs'

const record = (title, fields = {}) => ({ id: randomUUID(), title, stage: 'todo', position: 0, revision: 1,
  createdAt: '2026-11-19T09:00:00.000Z', updatedAt: '2026-11-19T09:00:00.000Z', ...fields })

test('in-progress cards without a conversation offer explicit creation, not another task start', async t => {
  const todo = record('To do')
  const ongoing = record('Manually in progress', { stage: 'doing' })
  const blocked = record('Blocked', { stage: 'doing', dependencyIds: [todo.id] })
  const finished = record('Finished', { stage: 'done' })
  const sessionId = randomUUID()
  const linked = record('Has a conversation', { stage: 'doing', activeSessionId: sessionId })
  const interrupted = record('Interrupted', { stage: 'doing', launch: {
    sessionId: randomUUID(), phase: 'prepared', input: { requestId: randomUUID(), content: 'Resume this' },
  } })
  const opened = [], operations = []
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation }) {
    operations.push(operation)
    if (operation === 'list') return { ok: true, value: { tasks: [todo, ongoing, blocked, finished, linked, interrupted] } }
    if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
    throw new Error('Unexpected operation: ' + operation)
  } }, { navigate: id => opened.push(id) })
  await waitForState(client.tasks, 'ready')
  const action = name => client.render().find(node => node.props?.['data-task-next-action'] !== undefined && node.props.children === name)
  const button = name => client.render().find(node => node.type === 'button' && node.props.children === name)
  const hasStatus = key => client.render().some(node => node.props?.['data-task-status'] === key)
  assert(action('开始任务')); assert(hasStatus('dependencyReady'))
  assert(action('查看前置任务')); assert(hasStatus('dependencyBlocked'))
  assert(action('恢复启动')); assert(hasStatus('launchPending'))
  assert(hasStatus('done'))
  assert(hasStatus('unlinkedConversation'))
  assert(client.render().includes('未关联对话'))
  action('查看进度').props.onClick()
  assert.deepEqual(opened, [sessionId])
  assert.equal(client.tasks.getSnapshot().launchForm, undefined)
  action('新建对话').props.onClick()
  assert.equal(client.tasks.getSnapshot().launchForm.taskId, ongoing.id)
  assert(client.render().includes('此任务已在进行中，但尚未关联对话。确认后才会新建对话并发送首条消息。'))
  assert.equal(button('新建并启动').props.type, 'submit')
  client.tasks.closeLaunch()
  assert.equal(client.tasks.getSnapshot().tasks.find(task => task.id === ongoing.id).activeSessionId, undefined)
  client.tasks.openDetails(ongoing.id)
  assert.equal(client.render().filter(node => node.type === 'button' && node.props.children === '新建对话').length, 3)
  assert.equal(client.render().filter(node => node.props?.['data-task-status'] === 'unlinkedConversation').length, 3)
  assert(operations.every(operation => ['list', 'options'].includes(operation)))
})
