const fixtureId = number => `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`

export function fusionV5Fixture() {
  const ids = {
    later: fixtureId(1), earlier: fixtureId(2), sourced: fixtureId(3), done: fixtureId(4), deleted: fixtureId(5),
    workspace: fixtureId(6), connection: fixtureId(7), previous: fixtureId(8), active: fixtureId(9), pending: fixtureId(10),
  }
  const createdAt = '2026-11-01T00:00:00.000Z'
  const updatedAt = '2026-11-02T00:00:00.000Z'
  const record = (id, title, position, requestId) => ({
    id, title, position, revision: 1, stage: 'todo', createdAt, updatedAt: createdAt,
    _create: { requestId, title, brief: '', stage: 'todo' },
  })
  const externalRef = {
    provider: 'tapd', connectionId: ids.connection, scopeId: 'f0-project', objectType: 'story', objectId: '1123456789000000123',
  }
  const create = {
    requestId: 'f0-source-create', title: '来源任务', brief: '原始说明', stage: 'todo', workspaceId: ids.workspace,
    externalRef: { ...externalRef, url: 'https://example.invalid/story/1123456789000000123' },
    model: { provider: 'fixture', model: 'offline' },
  }
  const update = {
    taskId: ids.sourced, requestId: 'f0-source-edit', expectedRevision: 9,
    patch: { title: '已补齐的来源任务', brief: '保留原始创建意图与更新回执' },
  }
  const launch = (requestId, sessionId, expectedRevision, phase, replaceActive) => ({
    input: { requestId, taskId: ids.sourced, expectedRevision, content: '合成执行说明', replaceActive }, sessionId, phase,
  })
  const previous = launch('f0-launch-previous', ids.previous, 1, 'complete', false)
  const active = launch('f0-launch-active', ids.active, 5, 'complete', true)
  const pending = launch('f0-launch-pending', ids.pending, 10, 'sending', true)
  const deleteCreate = { requestId: 'f0-deleted-create', title: '已删除任务' }
  const source = {
    ...record(ids.sourced, create.title, 52, create.requestId), ...update.patch,
    revision: 13, stage: 'doing', updatedAt, workspaceId: create.workspaceId, model: create.model, externalRef: create.externalRef,
    activeSessionId: ids.active, previousSessionIds: [ids.previous], launch: pending,
    _create: create, _launches: [previous, active, pending],
    _updates: [{ requestId: update.requestId, appliedRevision: 10, fingerprint: 'b73041d8c13c33dcf4e3459cfc4c95336be8bcefdd5f3ffc3b42da8ccc13073b' }],
  }
  return {
    ids, create, update, externalRef, deleteCreate, previous, pending,
    orderedIds: [ids.done, ids.earlier, ids.sourced, ids.later],
    document: { unit: { version: 5 }, tables: { tasks: {
      [ids.later]: record(ids.later, '后置待办', 90, 'f0-later'),
      [ids.earlier]: record(ids.earlier, '前置待办', 12, 'f0-earlier'),
      [ids.sourced]: source,
      [ids.done]: { ...record(ids.done, '完成日期未知的旧卡', 4, 'f0-done'), revision: 2, stage: 'done', updatedAt },
      [ids.deleted]: { id: ids.deleted, _deleted: { requestId: deleteCreate.requestId, revision: 2, at: updatedAt } },
    } } },
  }
}
