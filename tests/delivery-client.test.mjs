import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { callTask, memorySessionStorage, mountClient, mountHost, mountStorage, waitForState } from './fixtures.mjs'

const row = (fields = {}) => ({ id: randomUUID(), title: 'Task', stage: 'todo', position: 0, revision: 1,
  createdAt: '2026-11-19T09:00:00.000Z', updatedAt: '2026-11-19T09:00:00.000Z', ...fields })
const cards = client => client.render().filter(node => node.props?.['data-task-id'])
const nextActions = client => client.render().filter(node => node.props?.['data-task-next-action'] !== undefined)

test('prerequisites and criteria survive form drafts and edits, and a completed dependency only unlocks the card', async t => {
  const host = await mountHost(t)
  const created = (await callTask(host.rpc, 'create', { requestId: randomUUID(), title: 'Dependency' })).value.task
  const sessionStorage = memorySessionStorage()
  let client = await mountClient(t, host.rpc, { sessionStorage })
  await waitForState(client.tasks, 'ready')
  client.tasks.openForm()
  client.tasks.editForm('title', 'Dependent')
  client.tasks.editForm('acceptanceCriteria', '  Result is reviewed  ')
  client.tasks.editForm('dependencyIds', [created.id])
  await client.plugin.dispose()
  client = await mountClient(t, host.rpc, { sessionStorage })
  await waitForState(client.tasks, 'ready')
  assert.equal(client.tasks.getSnapshot().form.acceptanceCriteria, '  Result is reviewed  ')
  await client.tasks.create()
  let dependent = client.tasks.getSnapshot().tasks.find(task => task.title === 'Dependent')
  assert.deepEqual(dependent.dependencyIds, [created.id]); assert.equal(dependent.acceptanceCriteria, 'Result is reviewed')
  const names = () => nextActions(client).map(node => node.props.children)
  assert(names().includes('查看前置任务'))
  client.tasks.setFilter('ready', true)
  assert.deepEqual(cards(client).map(node => node.props['data-task-id']), [created.id])
  await client.tasks.setStage(created.id, 'done')
  assert.deepEqual(cards(client).map(node => node.props['data-task-id']), [dependent.id])
  assert.deepEqual(names(), ['开始任务'])
  assert(!client.tasks.getSnapshot().launchForm)
  assert(!client.tasks.getSnapshot().tasks.find(task => task.id === dependent.id).activeSessionId)
  client.tasks.openDetails(dependent.id)
  client.tasks.editDetails('dependencyIds', [])
  client.tasks.editDetails('acceptanceCriteria', '')
  await client.tasks.saveDetails()
  dependent = client.tasks.getSnapshot().tasks.find(task => task.id === dependent.id)
  assert.equal(dependent.dependencyIds, undefined); assert.equal(dependent.acceptanceCriteria, undefined)
})

test('attention routes delivery to its card, and uncertain review retries reuse the exact receipt', async t => {
  const activeSessionId = randomUUID()
  let task = row({ stage: 'doing', activeSessionId, acceptanceCriteria: 'Criteria', delivery: { id: randomUUID(), sessionId: activeSessionId,
    status: 'pending', summary: 'What changed', verification: 'Tests passed', remaining: 'Pending CI', submittedAt: '2026-11-19T10:00:00.000Z',
    links: [{ label: 'PR 2', url: 'https://example.org/pr/2' }, { label: 'ignored', url: 'javascript:alert(1)' }] } })
  const review = []
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [] }
  const client = await mountClient(t, { async call(_channel, _endpoint, { operation, input }) {
    if (operation === 'list') return { ok: true, value: { tasks: [task], board } }
    if (operation === 'history') return { ok: true, value: { events: [] } }
    if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
    if (operation === 'files') return { ok: true, value: { files: [], limits: null } }
    if (operation === 'review-delivery') {
      review.push(input)
      if (review.length === 1) throw new Error('Lost reply')
      task = { ...task, stage: 'done', revision: 2, delivery: { ...task.delivery, status: 'accepted', reviewedAt: '2026-11-19T11:00:00.000Z' } }
      return { ok: true, value: { task } }
    }
    throw new Error('Unexpected operation ' + operation)
  } }, { fetch: async () => new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'snapshot', streamId: 'delivery-host', sequence: 0, tasks: [task], board }) + '\n\n'))
  } }), { headers: { 'content-type': 'text/event-stream' } }) })
  await waitForState(client.tasks, 'ready')
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().sync !== 'live'; tries++) await setImmediate()
  assert.equal(client.tasks.getSnapshot().sync, 'live')
  assert(client.render().includes('需要我处理 · 1'))
  assert.deepEqual(nextActions(client).map(node => node.props.children), ['验收成果'])
  client.render().find(node => node.type === 'button' && node.props?.className === 'dsh-tasks-card-title').props.onClick()
  const tabs = () => client.render().filter(node => node.props?.role === 'tab')
  const shown = () => client.render().filter(node => node.props?.role === 'tabpanel' && !node.props.hidden)
  assert.deepEqual(tabs().map(tab => tab.props['aria-label']), ['详情', '动态', 'Agent 交付'])
  assert.equal(tabs()[2].props.children.some(child => child?.props?.className === 'dsh-tasks-tab-badge' && child.props['data-tone'] === 'pending'), true)
  assert.equal(shown()[0].props.id, tabs()[0].props['aria-controls'])
  tabs()[1].props.onClick()
  assert.equal(shown()[0].props.id, tabs()[1].props['aria-controls'])
  nextActions(client)[0].props.onClick()
  assert.equal(shown()[0].props.id, tabs()[2].props['aria-controls'])
  client.tasks.closeDetails()
  client.render().find(node => node.props?.className === 'dsh-tasks-attention-item').props.onClick()
  assert.equal(client.tasks.getSnapshot().detailId, task.id)
  assert.equal(shown().length, 1)
  assert.equal(shown()[0].props.id, tabs()[2].props['aria-controls'])
  assert(client.render().includes('Tests passed')); assert(client.render().includes('Pending CI'))
  assert.equal(client.render().filter(node => node.type === 'a' && node.props?.href === 'https://example.org/pr/2').length, 1)
  assert(!client.render().some(node => node.props?.href?.startsWith('javascript:')))
  const accept = () => client.render().find(node => node.type === 'button' && node.props.children === '接受并完成').props.onClick()
  await accept()
  assert.equal(client.tasks.getSnapshot().deliveryMutation.uncertain, true)
  await accept()
  assert.deepEqual(review[0], review[1]); assert.equal(review[1].expectedRevision, 1)
  assert.equal(client.tasks.getSnapshot().tasks[0].delivery.status, 'accepted')
  assert(!client.render().some(node => node.props?.['data-needs-attention']))
})

test('column, completed preview and overview preferences survive a fresh client without hiding search matches', async t => {
  const localStorage = memorySessionStorage()
  const tasks = Array.from({ length: 6 }, (_, index) => row({ stage: 'done', title: 'Complete ' + index }))
  const rpc = { call: async () => ({ ok: true, value: { tasks } }) }
  const first = await mountClient(t, rpc, { localStorage })
  await waitForState(first.tasks, 'ready')
  first.tasks.toggleColumn('stage:done', true)
  first.tasks.toggleDone()
  first.tasks.toggleOverview()
  const second = await mountClient(t, rpc, { localStorage })
  await waitForState(second.tasks, 'ready')
  assert.equal(second.tasks.getSnapshot().overview, true)
  assert.equal(second.tasks.getSnapshot().showAllDone['stage:done'], true)
  assert.equal(cards(second).length, 0)
  second.tasks.setQuery('Complete')
  assert.equal(cards(second).length, 6)
  second.tasks.setQuery('')
  assert.equal(cards(second).length, 0)
})

test('attention banner computes semantic tones, reason tags, preview, and routes items', async t => {
  const sApproval = randomUUID()
  const sError = randomUUID()
  const sPending = randomUUID()
  const tasks = [
    row({ id: randomUUID(), title: 'Pending task', stage: 'doing', activeSessionId: sPending,
      delivery: { id: randomUUID(), sessionId: sPending, status: 'pending', summary: 'Done', submittedAt: '2026-11-19T10:00:00.000Z' } }),
    row({ id: randomUUID(), title: 'Approval task', stage: 'doing', activeSessionId: sApproval }),
    row({ id: randomUUID(), title: 'Error task', stage: 'doing', activeSessionId: sError }),
  ]
  const navigated = []
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [] }
  let pushEvent
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation }) {
      if (operation === 'list') return { ok: true, value: { tasks: [tasks[0]], board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      if (operation === 'history') return { ok: true, value: { events: [] } }
      if (operation === 'files') return { ok: true, value: { files: [], limits: null } }
      throw new Error('Unexpected operation ' + operation)
    },
  }, {
    navigate: id => navigated.push(id),
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => { try { controller.close() } catch {} }, { once: true })
        const encode = event => controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(event) + '\n\n'))
        encode({ type: 'snapshot', streamId: 'attn-test', sequence: 0, tasks: [tasks[0]], board, statuses: {} })
        pushEvent = encode
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  })
  await waitForState(client.tasks, 'ready')
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().sync !== 'live'; tries++) await setImmediate()
  assert.equal(client.tasks.getSnapshot().sync, 'live')

  let banner = client.render().find(node => node.props?.['data-needs-attention'] !== undefined)
  assert.equal(banner.props['data-needs-attention'], 1)
  assert.equal(banner.props['data-attention-tone'], 'action')
  assert.equal(client.render().find(node => node.props?.className === 'dsh-tasks-attention-preview').props.children[0].props.children, 'Pending task')
  assert.equal(client.render().find(node => node.props?.className === 'dsh-tasks-attention-preview-more'), undefined)

  pushEvent({ type: 'upsert', streamId: 'attn-test', sequence: 1, task: tasks[1] })
  pushEvent({ type: 'status', streamId: 'attn-test', sequence: 2, taskId: tasks[1].id, status: { sessionId: sApproval, status: 'approval' } })
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().statuses[tasks[1].id]?.status !== 'approval'; tries++) await setImmediate()
  banner = client.render().find(node => node.props?.['data-needs-attention'] !== undefined)
  assert.equal(banner.props['data-needs-attention'], 2)
  assert.equal(banner.props['data-attention-tone'], 'warn')
  const preview = client.render().find(node => node.props?.className === 'dsh-tasks-attention-preview')
  assert.equal(preview.props.children[0].props.children, 'Approval task')
  assert.equal(preview.props.children[1].props.children, '+1')
  const pills = client.render().filter(node => node.type === 'small' && node.props?.['data-reason'])
  assert.deepEqual(pills.map(node => node.props['data-reason']), ['approval', 'reviewPending'])

  pushEvent({ type: 'upsert', streamId: 'attn-test', sequence: 3, task: tasks[2] })
  pushEvent({ type: 'status', streamId: 'attn-test', sequence: 4, taskId: tasks[2].id, status: { sessionId: sError, status: 'error' } })
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().statuses[tasks[2].id]?.status !== 'error'; tries++) await setImmediate()
  banner = client.render().find(node => node.props?.['data-needs-attention'] !== undefined)
  assert.equal(banner.props['data-needs-attention'], 3)
  assert.equal(banner.props['data-attention-tone'], 'danger')

  const items = client.render().filter(node => node.props?.className === 'dsh-tasks-item' || node.props?.className === 'dsh-tasks-attention-item')
  assert.equal(items.length, 3)
  items[0].props.onClick()
  assert.deepEqual(navigated, [sApproval])
  items[1].props.onClick()
  assert.equal(client.tasks.getSnapshot().detailId, tasks[0].id)
  assert.equal(client.tasks.getSnapshot().detailView, 'deliveryTab')
})

test('StatusBadge and TaskCard compute semantic tones across runtime, delivery, and dependencies', async t => {
  const sErr = randomUUID(), sAppr = randomUUID(), sRun = randomUUID(), sIdle = randomUUID(), sPend = randomUUID(), sRet = randomUUID()
  const prereqId = randomUUID()
  const tasks = [
    row({ id: prereqId, title: 'Prereq running', stage: 'doing', activeSessionId: sRun }),
    row({ id: randomUUID(), title: 'Ready card', stage: 'todo' }),
    row({ id: randomUUID(), title: 'Blocked card', stage: 'todo', dependencyIds: [prereqId] }),
    row({ id: randomUUID(), title: 'Error card', stage: 'doing', activeSessionId: sErr }),
    row({ id: randomUUID(), title: 'Approval card', stage: 'doing', activeSessionId: sAppr }),
    row({ id: randomUUID(), title: 'Idle card', stage: 'doing', activeSessionId: sIdle }),
    row({ id: randomUUID(), title: 'Review pending card', stage: 'doing', activeSessionId: sPend,
      delivery: { id: randomUUID(), sessionId: sPend, status: 'pending', summary: 'Done', submittedAt: '2026-11-19T10:00:00.000Z' } }),
    row({ id: randomUUID(), title: 'Review returned card', stage: 'doing', activeSessionId: sRet,
      delivery: { id: randomUUID(), sessionId: sRet, status: 'returned', summary: 'Initial attempt', feedback: 'Fix it', submittedAt: '2026-11-19T10:00:00.000Z', reviewedAt: '2026-11-19T11:00:00.000Z' } }),
    row({ id: randomUUID(), title: 'Done card', stage: 'done' }),
  ]
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [] }
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation }) {
      if (operation === 'list') return { ok: true, value: { tasks, board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      throw new Error('Unexpected operation ' + operation)
    },
  }, {
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => { try { controller.close() } catch {} }, { once: true })
        const statuses = {
          [tasks[0].id]: { sessionId: sRun, status: 'running' },
          [tasks[3].id]: { sessionId: sErr, status: 'error' },
          [tasks[4].id]: { sessionId: sAppr, status: 'approval' },
          [tasks[5].id]: { sessionId: sIdle, status: 'idle' },
        }
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'snapshot', streamId: 'tone-test', sequence: 0, tasks, board, statuses }) + '\n\n'))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  })
  await waitForState(client.tasks, 'ready')
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().sync !== 'live'; tries++) await setImmediate()

  const rendered = client.render()
  const cardById = new Map(rendered.filter(node => node.type === 'article' && node.props?.['data-task-id']).map(node => [node.props['data-task-id'], node]))
  assert.equal(cardById.get(tasks[0].id).props['data-card-tone'], undefined)
  assert.equal(cardById.get(tasks[1].id).props['data-card-tone'], undefined)
  assert.equal(cardById.get(tasks[2].id).props['data-card-tone'], 'blocked')
  assert.equal(cardById.get(tasks[3].id).props['data-card-tone'], 'danger')
  assert.equal(cardById.get(tasks[4].id).props['data-card-tone'], 'warn')
  assert.equal(cardById.get(tasks[5].id).props['data-card-tone'], undefined)
  assert.equal(cardById.get(tasks[6].id).props['data-card-tone'], 'action')
  assert.equal(cardById.get(tasks[7].id).props['data-card-tone'], 'warn')
  assert.equal(cardById.get(tasks[8].id).props['data-card-tone'], undefined)

  const badgeByStatus = new Map()
  for (let i = 0; i < rendered.length; i++) {
    const node = rendered[i]
    if (node?.props?.['data-task-status']) {
      const span = rendered.slice(i + 1, i + 4).find(child => child?.props?.['data-status-tone'])
      badgeByStatus.set(node.props['data-task-status'], span?.props?.['data-status-tone'])
    }
  }
  assert.deepEqual(Object.fromEntries(badgeByStatus), {
    running: 'info',
    dependencyReady: 'ready',
    dependencyBlocked: 'blocked',
    error: 'danger',
    approval: 'warn',
    idle: 'muted',
    reviewPending: 'action',
    reviewReturned: 'warn',
    done: 'muted',
  })
})

test('active filter chips render label, priority, dueDate, and ready filters with clear controls', async t => {
  const board = {
    revision: 1,
    columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })),
    labels: [{ id: 'lbl-1', name: 'Backend API', color: '#4879bc' }],
    priorities: ['P0', 'P1', 'P2'].map(key => ({ key, name: key })),
  }
  const today = new Date().toLocaleDateString('sv-SE')
  const task = row({ id: randomUUID(), title: 'Filtered card', stage: 'todo', labelId: 'lbl-1', priority: 'P0', dueDate: today })
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation }) {
      if (operation === 'list') return { ok: true, value: { tasks: [task], board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      throw new Error('Unexpected operation ' + operation)
    },
  })
  await waitForState(client.tasks, 'ready')

  assert.equal(client.render().find(node => node.props?.className === 'dsh-tasks-active-filters'), undefined)

  client.tasks.setFilter('labelId', 'lbl-1')
  let group = client.render().find(node => node.props?.className === 'dsh-tasks-active-filters')
  assert(group)
  assert.equal(client.render().find(node => node.props?.className === 'dsh-tasks-filter-clear'), undefined)

  client.tasks.setFilter('priority', 'P0')
  client.tasks.setFilter('dueDate', 'today')
  client.tasks.setFilter('ready', true)
  const nodes = client.render()
  assert(nodes.some(node => node.props?.['data-filter-key'] === 'labelId' && node.props.className === 'dsh-tasks-filter-chip'))
  assert(nodes.some(node => node.props?.['data-filter-key'] === 'priority' && node.props?.['data-priority'] === 'P0'))
  assert(nodes.some(node => node.props?.className === 'dsh-tasks-due-chip' && node.props?.['data-filter-key'] === 'dueDate'))
  assert(nodes.some(node => node.props?.['data-filter-key'] === 'ready'))

  const clearBtn = nodes.find(node => node.props?.className === 'dsh-tasks-filter-clear')
  assert(clearBtn)

  nodes.find(node => node.props?.['data-filter-key'] === 'priority').props.onClick()
  assert.equal(client.tasks.getSnapshot().filters.priority, '')
  assert.equal(client.tasks.getSnapshot().filters.labelId, 'lbl-1')

  clearBtn.props.onClick()
  assert.equal(Object.keys(client.tasks.getSnapshot().filters).length, 0)
  assert.equal(client.render().find(node => node.props?.className === 'dsh-tasks-active-filters'), undefined)
})

test('quickCreate inherits workspaceFilter, preserves form draft, and openForm accepts initialTitle', async t => {
  const createdCalls = []
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [] }
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation, input }) {
      if (operation === 'list') return { ok: true, value: { tasks: [], board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [{ id: 'ws-alpha', title: 'Alpha' }], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      if (operation === 'create') {
        createdCalls.push(input)
        if (input.title === 'FAIL_ME') return { ok: false, error: { code: 'tasks/create-failed' } }
        return {
          ok: true,
          value: {
            task: row({
              id: randomUUID(), title: input.title, stage: input.stage, columnId: input.columnId,
              workspaceId: input.workspaceId,
            }),
          },
        }
      }
      throw new Error('Unexpected operation ' + operation)
    },
  })
  await waitForState(client.tasks, 'ready')

  client.tasks.editForm('title', 'Existing draft')
  client.tasks.setWorkspaceFilter('ws-alpha')
  const okRes = await client.tasks.quickCreate({ title: '  Quick task 1  ', stage: 'doing', columnId: 'stage:doing' })
  assert.equal(okRes.ok, true)
  assert.equal(createdCalls.length, 1)
  assert.equal(createdCalls[0].title, 'Quick task 1')
  assert.equal(createdCalls[0].stage, 'doing')
  assert.equal(createdCalls[0].columnId, 'stage:doing')
  assert.equal(createdCalls[0].workspaceId, 'ws-alpha')
  assert.equal(client.tasks.getSnapshot().form.title, 'Existing draft')
  assert.equal(client.tasks.getSnapshot().tasks.length, 1)

  client.tasks.setWorkspaceFilter('ungrouped')
  const failRes = await client.tasks.quickCreate({ title: 'FAIL_ME', stage: 'todo' })
  assert.equal(failRes.ok, false)
  assert.equal(createdCalls[1].workspaceId, undefined)
  assert.equal(client.tasks.getSnapshot().form.title, 'Existing draft')

  client.tasks.editForm('title', '')
  client.tasks.openForm('todo', 'stage:todo', 'Escalated quick title')
  assert.equal(client.tasks.getSnapshot().form.title, 'Escalated quick title')
  client.tasks.editForm('title', 'Modified draft')
  client.tasks.openForm('doing', 'stage:doing', 'Should not overwrite')
  assert.equal(client.tasks.getSnapshot().form.title, 'Modified draft')
})

test('reverse dependencies display in detail drawer and completing prerequisite emits unlockNotice', async t => {
  const host = await mountHost(t)
  const prereqA = (await callTask(host.rpc, 'create', { requestId: randomUUID(), title: 'Prereq A' })).value.task
  const prereqB = (await callTask(host.rpc, 'create', { requestId: randomUUID(), title: 'Prereq B' })).value.task
  const singleDep = (await callTask(host.rpc, 'create', { requestId: randomUUID(), title: 'Unlocked after A', dependencyIds: [prereqA.id] })).value.task
  const doubleDep = (await callTask(host.rpc, 'create', { requestId: randomUUID(), title: 'Still blocked by B', dependencyIds: [prereqA.id, prereqB.id] })).value.task

  const client = await mountClient(t, host.rpc)
  await waitForState(client.tasks, 'ready')

  client.tasks.openDetails(prereqA.id)
  const rendered = client.render()
  assert(rendered.some(node => node.props?.className === 'dsh-tasks-dependents'))
  const linkBtns = rendered.filter(node => node.props?.className === 'dsh-tasks-dependency-link')
  assert(linkBtns.some(btn => btn.props.children === 'Unlocked after A'))
  linkBtns.find(btn => btn.props.children === 'Unlocked after A').props.onClick()
  assert.equal(client.tasks.getSnapshot().detailId, singleDep.id)
  client.tasks.closeDetails()

  await client.tasks.setStage(prereqA.id, 'done')
  const notice = client.tasks.getSnapshot().unlockNotice
  assert(notice)
  assert.deepEqual(Array.from(notice.tasks, item => item.id), [singleDep.id])
  assert(!notice.tasks.some(item => item.id === doubleDep.id))

  const toast = client.render().find(node => node.props?.className === 'dsh-tasks-unlock-toast')
  assert(toast)
  const unlockLink = client.render().find(node => node.props?.className === 'dsh-tasks-unlock-link')
  assert.equal(unlockLink.props.children, 'Unlocked after A')
  unlockLink.props.onClick()
  assert.equal(client.tasks.getSnapshot().unlockNotice, undefined)
  assert.equal(client.tasks.getSnapshot().detailId, singleDep.id)
})

test('attention banner wraps reason counts in clickable pill buttons with aria-pressed', async t => {
  const sApproval = randomUUID(), sPending = randomUUID()
  const tasks = [
    row({ id: randomUUID(), title: 'Approval task', stage: 'doing', activeSessionId: sApproval }),
    row({ id: randomUUID(), title: 'Pending review task', stage: 'doing', activeSessionId: sPending,
      delivery: { id: randomUUID(), sessionId: sPending, status: 'pending', summary: 'Done', submittedAt: '2026-11-19T10:00:00.000Z' } }),
  ]
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [] }
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation }) {
      if (operation === 'list') return { ok: true, value: { tasks, board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      throw new Error('Unexpected operation ' + operation)
    },
  }, {
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => { try { controller.close() } catch {} }, { once: true })
        const statuses = { [tasks[0].id]: { sessionId: sApproval, status: 'approval' } }
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'snapshot', streamId: 'pill-test', sequence: 0, tasks, board, statuses }) + '\n\n'))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  })
  await waitForState(client.tasks, 'ready')
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().sync !== 'live'; tries++) await setImmediate()

  const pillNodes = client.render().filter(node => node.type === 'button' && node.props?.className === 'dsh-tasks-attention-pill')
  assert.equal(pillNodes.length, 2)
  assert.equal(pillNodes[0].props['aria-pressed'], false)
  assert.equal(typeof pillNodes[0].props.onClick, 'function')
})

test('task-store updateStatus stamps since once and rotates it only on status transitions', async t => {
  const { createTaskStore } = await import('../task-store.js')
  const { createTaskSessions } = await import('../task-sessions.js')
  const { taskDomain } = await import('../task-schema.js')
  const mounted = await mountStorage(t)
  const sessionsMap = new Map()
  mounted.ctx.provide('sessionController', {
    async state({ sessionId }) {
      if (!sessionsMap.has(sessionId)) throw Object.assign(new Error('Missing'), { code: 'session/not-found' })
      return sessionsMap.get(sessionId)
    },
    async create({ sessionId }) {
      sessionsMap.set(sessionId, { cursor: 0, running: false, pendingInput: [], queue: [] })
      return { sessionId }
    },
    async selectModel() {},
    async prompt() { return { accepted: true } },
  })
  const sessions = createTaskSessions(mounted.ctx)
  const events = []
  const domain = await mounted.ctx.storageDomain.open(taskDomain)
  const store = createTaskStore(domain, { maxTitleLength: 200, maxBriefLength: 20000, maxTasks: 1000 }, () => {}, { validate: async () => undefined }, sessions)
  t.after(async () => { sessions.close(); await store.close() })
  const unwatch = await store.watch(ev => events.push(ev))
  t.after(unwatch)

  const created = await store.execute('create', { requestId: randomUUID(), title: 'Run timing' })
  assert.equal(created.ok, true)
  const taskId = created.value.task.id
  store.updateStatus(taskId, { sessionId: randomUUID(), status: 'running' })
  assert.equal(events.filter(e => e.type === 'status').length, 0)

  const launched = await store.execute('launch', { taskId, expectedRevision: 1, requestId: randomUUID(), content: 'start', replaceActive: false })
  assert.equal(launched.ok, true)
  const sid = launched.value.task.activeSessionId

  store.updateStatus(taskId, { sessionId: sid, status: 'running' })
  let statusEvents = events.filter(e => e.type === 'status')
  assert.equal(statusEvents.length, 1)
  const firstSince = statusEvents[0].status.since
  assert(typeof firstSince === 'string' && Number.isFinite(Date.parse(firstSince)))

  store.updateStatus(taskId, { sessionId: sid, status: 'running' })
  assert.equal(events.filter(e => e.type === 'status').length, 1)

  const customSince = '2026-11-25T07:00:00.000Z'
  store.updateStatus(taskId, { sessionId: sid, status: 'idle', since: customSince })
  statusEvents = events.filter(e => e.type === 'status')
  assert.equal(statusEvents.length, 2)
  assert.equal(statusEvents[1].status.status, 'idle')
  assert.equal(statusEvents[1].status.since, customSince)
})

test('done column groups completed tasks by today, thisWeek, and earlier; running card renders elapsed badge', async t => {
  const now = new Date()
  const todayIso = now.toISOString()
  const twoWeeksAgo = new Date(now.getTime() - 14 * 86400000).toISOString()
  const sRun = randomUUID()
  const runSince = new Date(now.getTime() - 65 * 60000).toISOString()
  const tasks = [
    row({ id: randomUUID(), title: 'Running task', stage: 'doing', activeSessionId: sRun }),
    row({ id: randomUUID(), title: 'Done earlier', stage: 'done', completedAt: twoWeeksAgo, updatedAt: twoWeeksAgo }),
    row({ id: randomUUID(), title: 'Done today', stage: 'done', completedAt: todayIso, updatedAt: todayIso }),
  ]
  const board = { revision: 1, columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })), labels: [] }
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation }) {
      if (operation === 'list') return { ok: true, value: { tasks, board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      throw new Error('Unexpected operation ' + operation)
    },
  }, {
    fetch: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init?.signal?.addEventListener('abort', () => { try { controller.close() } catch {} }, { once: true })
        const statuses = { [tasks[0].id]: { sessionId: sRun, status: 'running', since: runSince } }
        controller.enqueue(new TextEncoder().encode('data: ' + JSON.stringify({ type: 'snapshot', streamId: 'p2-group-run', sequence: 0, tasks, board, statuses }) + '\n\n'))
      },
    }), { headers: { 'content-type': 'text/event-stream' } }),
  })
  await waitForState(client.tasks, 'ready')
  for (let tries = 0; tries < 50 && client.tasks.getSnapshot().sync !== 'live'; tries++) await setImmediate()

  const rendered = client.render()
  const groupHeads = rendered.filter(node => node.props?.className === 'dsh-tasks-done-group-head').map(node => node.props['data-done-group'])
  assert.deepEqual(groupHeads, ['today', 'earlier'])
  const elapsedNodes = rendered.filter(node => node.props?.className === 'dsh-tasks-running-elapsed')
  assert.equal(elapsedNodes.length, 1)
  assert.match(elapsedNodes[0].props.children, /^· 1h \d+m$/)
})

test('temporary sortBy reorders cards and renders dismissible sort chip', async t => {
  const tasks = [
    row({ id: randomUUID(), title: 'Low P2', stage: 'todo', position: 0, orderKey: '0', priority: 'P2', dueDate: '2026-12-10' }),
    row({ id: randomUUID(), title: 'Urgent P0', stage: 'todo', position: 1, orderKey: '1', priority: 'P0', dueDate: '2026-12-01' }),
    row({ id: randomUUID(), title: 'Mid P1', stage: 'todo', position: 2, orderKey: '2', priority: 'P1', dueDate: '2026-11-28' }),
  ]
  const board = {
    revision: 1,
    columns: ['todo', 'doing', 'done'].map(stage => ({ id: 'stage:' + stage, stage })),
    labels: [],
    priorities: ['P0', 'P1', 'P2'].map(key => ({ key, name: key })),
  }
  const client = await mountClient(t, {
    async call(_channel, _endpoint, { operation }) {
      if (operation === 'list') return { ok: true, value: { tasks, board } }
      if (operation === 'options') return { ok: true, value: { workspaces: [], groups: [], workspaceStatus: 'ready', modelStatus: 'ready' } }
      throw new Error('Unexpected operation ' + operation)
    },
  })
  await waitForState(client.tasks, 'ready')

  const titles = () => client.render().filter(node => node.props?.className === 'dsh-tasks-card-title-text').map(node => node.props.children)
  assert.deepEqual(titles(), ['Low P2', 'Urgent P0', 'Mid P1'])

  client.tasks.setSortBy('priority')
  assert.deepEqual(titles(), ['Urgent P0', 'Mid P1', 'Low P2'])
  const sortChip = client.render().find(node => node.props?.['data-filter-key'] === 'sortBy')
  assert(sortChip)

  client.tasks.setSortBy('dueDate')
  assert.deepEqual(titles(), ['Mid P1', 'Urgent P0', 'Low P2'])

  client.render().find(node => node.props?.['data-filter-key'] === 'sortBy').props.onClick()
  assert.equal(client.tasks.getSnapshot().sortBy, 'manual')
  assert.deepEqual(titles(), ['Low P2', 'Urgent P0', 'Mid P1'])
})
