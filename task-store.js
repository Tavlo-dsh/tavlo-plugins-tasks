/** Serialized task operations over a caller-owned Storage Domain. */
import { createHash, randomUUID } from 'node:crypto'
import { createInputSchemas, pageSize, imageRef, imageTypes, fileRef, fileCapacity, uploadImage, uploadSchema, uploadFile, uploadFileSchema } from './task-schema.js'
import { externalKey, fingerprint } from './task-identity.js'
import { between, boardPriorities, defaultColumn, orderKey, priorityCapacity } from './task-board.js'

class TaskFailure extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

const failure = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })

function publicTask(record) {
  const { _create, _launches, _updates, _tail, _images, _files, ...task } = record
  if (task.launch) {
    const { input, phase, sessionId } = task.launch
    task.launch = { input, phase, ...(sessionId ? { sessionId } : {}) }
  }
  if (_images?.length) task.imageCount = _images.length
  const fileCount = (_images?.length ?? 0) + (_files?.length ?? 0)
  if (fileCount) task.fileCount = fileCount
  return structuredClone(task.columnId ? { ...task, orderKey: orderKey(task) } : task)
}

function publicBoard(board) {
  return board && structuredClone({ ...board, priorities: boardPriorities(board) })
}

/**
 * Own a validated domain, deduplication index, and operation queue.
 * @param domain - freshly opened taskDomain; ownership transfers on success.
 * @param limits - resolved plugin Config.
 * @param reportError - diagnostic sink for unexpected storage errors.
 * @param options - optional live workspace/model lookup and binding validation.
 * @returns execute(), watch() with a subscription disposer, and idempotent close().
 */
export function validateTaskRecords(entries) {
  const requests = new Map()
  const sources = new Map()
  let nextPosition = 0
  // Domain.open validates individual values. These checks validate relationships.
  for (const [key, record] of entries) {
    const requestId = record._deleted?.requestId ?? record._create.requestId
    if (key !== record.id || requests.has(requestId)) {
      throw new Error(`tasks: inconsistent record identity or duplicate creation request at '${key}'`)
    }
    requests.set(requestId, key)
    if (record._deleted) continue
    const attachmentIds = [...(record._images ?? []), ...(record._files ?? [])].map(ref => ref.attachmentId)
    if (attachmentIds.length > fileCapacity || new Set(attachmentIds).size !== attachmentIds.length) {
      throw new Error(`tasks: inconsistent attachments at '${key}'`)
    }
    const source = externalKey(record.externalRef)
    if (source && sources.has(source)) throw new Error(`tasks: duplicate external source at '${key}'`)
    if (source) sources.set(source, key)
    const updates = record._updates ?? []
    if (new Set(updates.map(row => row.requestId)).size !== updates.length
      || updates.some(row => row.appliedRevision > record.revision)) {
      throw new Error(`tasks: inconsistent update history at '${key}'`)
    }
    const receipts = record._launches ?? []
    if (receipts.some(row => row.input.taskId !== key)
      || new Set(receipts.map(row => row.input.requestId)).size !== receipts.length
      || JSON.stringify(record.launch) !== JSON.stringify(receipts.at(-1))) {
      throw new Error(`tasks: inconsistent launch history at '${key}'`)
    }
    nextPosition = Math.max(nextPosition, Math.floor(record.position) + 1)
  }
  return { requests, sources, nextPosition }
}

export function createTaskStore(domain, limits, reportError = () => {}, options, sessions, attachments) {
  const table = domain.table('tasks')
  const indices = validateTaskRecords(table.entries())
  const { requests, sources } = indices
  let nextPosition = indices.nextPosition
  const { operations: schemas, creationReplay, updateReplay, launchReplay } = createInputSchemas(limits)

  let chain = Promise.resolve()
  let closing = false
  let disposal
  let sequence = 0
  const streamId = randomUUID()
  let unavailableCode
  const observers = new Set()
  const boardObservers = new Set()
  const board = () => domain.boardGlobal?.get().board
  const archive = domain.boardGlobal && domain.table('activity')
  let actor
  function* history(record, before = Infinity) {
    const tail = record._tail
    if (!tail) return
    let id = Math.min(before - 1, tail.at(-1).id)
    while (id > 0) {
      const inTail = id >= tail[0].id
      const start = inTail ? tail[0].id : Math.floor((id - 1) / pageSize) * pageSize + 1
      const page = inTail ? tail : archive.get(`${record.id}:${start}`)
      for (; id >= start; id--) yield page[id - start]
    }
  }
  function matchComment(record, query) {
    if (!record.commentCount) return
    for (const event of history(record)) if (event.kind === 'comment') {
      const index = event.text.toLowerCase().indexOf(query)
      if (index >= 0) return event.text.slice(Math.max(0, index - 32), index + 96)
    }
  }
  async function commit(current, next, events = []) {
    const moved = current && (current.columnId !== next.columnId || current.stage !== next.stage)
    if (moved) events.push({ kind: 'moved', from: current.columnId ?? defaultColumn(current.stage), to: next.columnId ?? defaultColumn(next.stage) })
    if (current?.stage !== 'done' && next.stage === 'done') {
      next.completedAt = next.updatedAt
      events.push({ kind: 'completed' })
    } else if (current?.stage === 'done' && next.stage !== 'done') {
      delete next.completedAt
      events.push({ kind: 'reopened' })
    }
    if (archive && events.length) {
      let tail = [...(current?._tail ?? [])], id = tail.at(-1)?.id ?? 0
      if (tail.length >= pageSize) {
        await archive.put(`${next.id}:${tail[0].id}`, tail.slice(0, pageSize))
        tail = tail.slice(pageSize)
      }
      for (const event of events) {
        tail.push({ ...event, id: ++id, at: next.updatedAt, source: actor })
      }
      next._tail = tail
    }
    await table.put(next.id, next)
    return next
  }
  function liveTask(id) {
    const row = table.get(id)
    if (!row || row._deleted) throw new TaskFailure('tasks/not-found', 'Task does not exist')
    return row
  }
  function validateLabel(id) {
    if (id && !board()?.labels?.some(label => label.id === id)) throw new TaskFailure('tasks/label-missing', 'Label no longer exists')
  }
  const subscriptionDisposers = new Set()
  const statuses = {}

  function listTasks() {
    const records = [...table.entries()].map(([, record]) => record).filter(record => !record._deleted)
    records.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    return records.map(publicTask)
  }

  function notify(event) {
    sequence++
    for (const observer of [...observers]) {
      try { observer(structuredClone({ ...event, sequence, streamId })) } catch (error) { reportError(error) }
    }
  }

  async function validateBindings(input) {
    if (!input.workspaceId && !input.model) return
    const error = options ? await options.validate(input) : { code: 'tasks/options-unavailable', message: 'Task options unavailable' }
    if (error) throw new TaskFailure(error.code, error.message)
  }

  async function create(input) {
    const existingId = requests.get(input.requestId)
    if (existingId !== undefined) {
      const existing = table.get(existingId)
      if (existing === undefined) throw new Error('tasks: creation index refers to a missing record')
      if (existing._deleted) throw new TaskFailure('tasks/deleted', 'This task was deleted')
      if (existing._create.title !== input.title || existing._create.brief !== input.brief) {
        throw new TaskFailure('tasks/request-conflict', 'Creation request was already used with different input', {
          requestId: input.requestId, taskId: existingId,
        })
      }
      const sameModel = (a, b) => a?.provider === b?.provider && a?.model === b?.model
        && a?.reasoningEffort === b?.reasoningEffort
      if ((existing._create.stage ?? 'todo') !== input.stage || existing._create.columnId !== input.columnId
        || ['labelId', 'priority', 'dueDate'].some(key => existing._create[key] !== input[key])
        || existing._create.workspaceId !== input.workspaceId || !sameModel(existing._create.model, input.model)
        || fingerprint(existing._create.externalRef ?? null) !== fingerprint(input.externalRef ?? null)) {
        throw new TaskFailure('tasks/request-conflict', 'Creation request was already used with different bindings', {
          requestId: input.requestId, taskId: existingId,
        })
      }
      return { task: publicTask(existing) }
    }
    assertSource(input.externalRef)
    validateLabel(input.labelId)
    await validateBindings(input)
    if ([...table.entries()].filter(([, record]) => !record._deleted).length >= limits.maxTasks) {
      throw new TaskFailure('tasks/limit-reached', 'Task limit reached', { resource: 'tasks', limit: limits.maxTasks })
    }
    if (!Number.isSafeInteger(nextPosition)) {
      throw new TaskFailure('tasks/limit-reached', 'Task ordering capacity reached', { resource: 'position' })
    }
    const now = new Date().toISOString()
    const column = board() && findColumn(input.columnId ?? defaultColumn(input.stage))
    if (column && column.stage !== input.stage) throw new TaskFailure('tasks/bad-request', 'Column stage mismatch')
    const record = {
      id: randomUUID(), revision: 1, title: input.title,
      ...(input.brief === '' ? {} : { brief: input.brief }),
      stage: input.stage, position: nextPosition, createdAt: now, updatedAt: now,
      ...(column ? { columnId: column.id } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.externalRef ? { externalRef: input.externalRef } : {}),
      ...Object.fromEntries(['labelId', 'priority', 'dueDate'].filter(key => input[key]).map(key => [key, input[key]])),
      _create: { ...input },
    }
    if (column) {
      let last
      for (const [, row] of table.entries()) if (row.columnId === column.id && row.orderKey && (!last || row.orderKey > last.orderKey)) last = row
      if (last && last.orderKey >= orderKey(record)) record.orderKey = newRank(last)
    }
    await commit(null, record, [{ kind: 'created' }])
    // Commit the index and ordering only after the record is durable.
    requests.set(input.requestId, record.id)
    if (record.externalRef) sources.set(externalKey(record.externalRef), record.id)
    nextPosition++
    notify({ type: 'upsert', task: publicTask(record) })
    return { task: publicTask(record) }
  }

  function assertSource(ref, taskId) {
    const existingId = ref && sources.get(externalKey(ref))
    if (existingId && existingId !== taskId) throw new TaskFailure('tasks/external-conflict', 'External item already belongs to a task', {
      taskId: existingId, reason: 'duplicate',
    })
  }

  async function updateTask(input) {
    const current = table.get(input.taskId)
    if (!current) throw new TaskFailure('tasks/not-found', 'Task does not exist')
    if (current._deleted) throw new TaskFailure('tasks/deleted', 'This task was deleted')
    const digest = fingerprint({ expectedRevision: input.expectedRevision, patch: input.patch })
    const receipt = current._updates?.find(row => row.requestId === input.requestId)
    if (receipt) {
      if (receipt.fingerprint !== digest) throw new TaskFailure('tasks/request-conflict', 'Update request changed')
      return { task: publicTask(current), mutation: { requestId: input.requestId, appliedRevision: receipt.appliedRevision, replayed: true } }
    }
    if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded', {
      taskId: current.id, currentRevision: current.revision,
    })
    if ((current._updates?.length ?? 0) >= (limits.maxUpdatesPerTask ?? 10000)) {
      throw new TaskFailure('tasks/limit-reached', 'Update receipt limit reached', { resource: 'updates' })
    }
    const next = { ...current }
    validateLabel(input.patch.labelId)
    await validateBindings(input.patch)
    for (const key of ['labelId', 'priority', 'dueDate', 'workspaceId', 'model']) {
      if (input.patch[key] === null) delete next[key]
      else if (input.patch[key] !== undefined) next[key] = input.patch[key]
    }
    if (input.patch.title !== undefined) next.title = input.patch.title
    if (input.patch.brief !== undefined) {
      if (input.patch.brief === '') delete next.brief
      else next.brief = input.patch.brief
    }
    if (input.patch.externalRef !== undefined) {
      const ref = input.patch.externalRef
      if (ref && current.externalRef && externalKey(ref) !== externalKey(current.externalRef)) {
        throw new TaskFailure('tasks/external-conflict', 'Unbind the current source before binding another', { taskId: current.id, reason: 'rebind-required' })
      }
      assertSource(ref, current.id)
      if (ref) next.externalRef = ref
      else delete next.externalRef
    }
    const changed = fingerprint(current) !== fingerprint(next)
    if (changed) {
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision limit reached')
      next.revision++
      next.updatedAt = new Date().toISOString()
    }
    next._updates = [...(current._updates ?? []), { requestId: input.requestId, fingerprint: digest, appliedRevision: next.revision }]
    // Record and receipt share one durable row, so a retry can never apply twice.
    await commit(current, next, changed ? [{ kind: 'updated', fields: Object.keys(input.patch).filter(key => fingerprint(current[key] ?? null) !== fingerprint(next[key] ?? null)) }] : [])
    if (current.externalRef) sources.delete(externalKey(current.externalRef))
    if (next.externalRef) sources.set(externalKey(next.externalRef), next.id)
    if (changed) notify({ type: 'upsert', task: publicTask(next) })
    return { task: publicTask(next), mutation: { requestId: input.requestId, appliedRevision: next.revision, replayed: false } }
  }

  async function setStage(input) {
    const current = liveTask(input.taskId)
    if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded', { taskId: current.id, currentRevision: current.revision })
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Task revision capacity reached', { resource: 'revision' })
    const next = await commit(current, { ...current, ...(current.columnId && current.stage !== input.stage ? { columnId: defaultColumn(input.stage), orderKey: undefined } : {}), stage: input.stage, revision: current.revision + 1, updatedAt: new Date().toISOString() })
    notify({ type: 'upsert', task: publicTask(next) })
    return { task: publicTask(next) }
  }

  function findColumn(id) {
    const column = board()?.columns.find(item => item.id === id)
    if (!column) throw new TaskFailure('tasks/revision-conflict', 'Column no longer exists')
    return column
  }

  function columnTasks(id, exclude) {
    return [...table.entries()].map(([, task]) => task).filter(task => task.columnId === id && task.id !== exclude)
      .sort((left, right) => orderKey(left) < orderKey(right) ? -1 : orderKey(left) > orderKey(right) ? 1 : left.id.localeCompare(right.id))
  }

  function newRank(previous, next) {
    const lower = previous && orderKey(previous), upper = next && orderKey(next)
    const rank = between(lower, upper)
    if (!rank || (lower && rank <= lower) || (upper && rank >= upper)) throw new TaskFailure('tasks/limit-reached', 'Ordering capacity reached')
    return rank
  }

  async function move(input) {
    const task = table.get(input.taskId), column = findColumn(input.columnId)
    if (!task || task._deleted) throw new TaskFailure('tasks/not-found', 'Task does not exist')
    if (task.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed before drop')
    const rows = columnTasks(column.id, task.id)
    let index = rows.length
    if (input.anchor) {
      index = rows.findIndex(row => row.id === input.anchor.taskId)
      if (index < 0) throw new TaskFailure('tasks/revision-conflict', 'Drop anchor moved')
      if (input.anchor.side === 'after') index++
    }
    if (task.columnId === column.id && columnTasks(column.id)[index]?.id === task.id) return { task: publicTask(task) }
    if (task.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision capacity reached')
    const updated = { ...task, stage: column.stage, columnId: column.id, orderKey: newRank(rows[index - 1], rows[index]),
      revision: task.revision + 1, updatedAt: new Date().toISOString() }
    await commit(task, updated)
    notify({ type: 'upsert', task: publicTask(updated) })
    return { task: publicTask(updated) }
  }

  async function editColumns(input) {
    const current = board()
    if (!current || current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Board changed')
    let columns = [...current.columns]
    if (input.action === 'add') {
      if (columns.length >= 100) throw new TaskFailure('tasks/limit-reached', 'Column limit reached')
      columns.push({ id: randomUUID(), stage: input.stage, name: input.name })
    } else {
      const column = findColumn(input.columnId)
      if (input.action === 'rename') columns = columns.map(row => row.id === column.id ? { ...row, name: input.name } : row)
      if (input.action === 'remove') {
        if (column.id === defaultColumn(column.stage) || columnTasks(column.id).length) throw new TaskFailure('tasks/column-not-empty-or-default', 'Only empty custom columns can be removed')
        columns = columns.filter(row => row.id !== column.id)
      }
      if (input.action === 'reorder') {
        if (input.before === column.id) return { board: publicBoard(current) }
        if (input.before) findColumn(input.before)
        columns = columns.filter(row => row.id !== column.id)
        columns.splice(input.before ? columns.findIndex(row => row.id === input.before) : columns.length, 0, column)
      }
    }
    return saveBoard({ ...current, columns, revision: current.revision + 1 })
  }

  async function editLabels(input) {
    const current = board()
    if (!current || current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Board changed')
    let labels = [...(current.labels ?? [])]
    if (input.action === 'add') {
      if (labels.length >= 100) throw new TaskFailure('tasks/limit-reached', 'Label limit reached')
      labels.push({ id: randomUUID(), name: input.name, color: input.color })
    } else {
      validateLabel(input.labelId)
      if (input.action === 'remove' && [...table.entries()].some(([, task]) => task.labelId === input.labelId)) throw new TaskFailure('tasks/label-in-use', 'Unassign the label before removing it')
      labels = input.action === 'remove' ? labels.filter(row => row.id !== input.labelId) : labels.map(row => row.id === input.labelId ? { ...row, name: input.name, color: input.color } : row)
    }
    return saveBoard({ ...current, labels, revision: current.revision + 1 })
  }

  async function editPriorities(input) {
    const current = board()
    if (!current || current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Board changed')
    const priorities = [...boardPriorities(current)]
    const index = priorities.findIndex(row => row.key === input.key)
    if (input.action === 'add') {
      if (index !== -1) throw new TaskFailure('tasks/priority-duplicate', 'Priority key already exists')
      if (priorities.length >= priorityCapacity) throw new TaskFailure('tasks/limit-reached', 'Priority limit reached')
      priorities.push({ key: input.key, name: input.name })
    } else {
      if (index === -1) throw new TaskFailure('tasks/priority-missing', 'Priority no longer exists')
      if (input.action === 'edit') {
        if (priorities[index].name === input.name) return { board: publicBoard(current) }
        priorities[index] = { key: input.key, name: input.name }
      } else if (input.action === 'remove') {
        for (const [, task] of table.entries()) {
          if (!task._deleted && task.priority === input.key) throw new TaskFailure('tasks/priority-in-use', 'Unassign the priority before removing it')
        }
        priorities.splice(index, 1)
      } else {
        let before = input.before === null ? priorities.length : priorities.findIndex(row => row.key === input.before)
        if (before === -1) throw new TaskFailure('tasks/revision-conflict', 'Priority reorder anchor no longer exists')
        if (before > index) before--
        if (before === index) return { board: publicBoard(current) }
        const [entry] = priorities.splice(index, 1)
        priorities.splice(before, 0, entry)
      }
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision capacity reached')
    return saveBoard({ ...current, priorities, revision: current.revision + 1 })
  }

  async function saveBoard(next) {
    await domain.boardGlobal.set({ ...domain.boardGlobal.get(), board: next })
    const output = { board: publicBoard(next) }
    for (const observer of boardObservers) {
      try { observer(structuredClone({ type: 'board', streamId, sequence, ...output })) } catch (error) { reportError(error) }
    }
    return output
  }

  async function deleteTask(input) {
    const current = table.get(input.taskId)
    if (!current) throw new TaskFailure('tasks/not-found', 'Task does not exist')
    if (current._deleted) { await purge(current.id); return { taskId: current.id, revision: current._deleted.revision } }
    if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded')
    if (current.launch && !['complete', 'abandoned'].includes(current.launch.phase)) {
      throw new TaskFailure('tasks/launch-pending', 'Resolve the pending launch before deleting this task')
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Task revision capacity reached')
    const revision = current.revision + 1
    await table.put(current.id, { id: current.id, _deleted: { requestId: current._create.requestId, revision, at: new Date().toISOString() } })
    if (current.externalRef) sources.delete(externalKey(current.externalRef))
    delete statuses[current.id]
    notify({ type: 'remove', taskId: current.id, revision })
    await purge(current.id)
    return { taskId: current.id, revision }
  }

  async function purge(taskId) {
    if (archive) for (const key of archive.keys()) if (key.startsWith(taskId + ':')) await archive.delete(key)
  }

  async function launchTask(input, resume) {
    let record = table.get(input.taskId)
    if (!record || record._deleted) throw new TaskFailure('tasks/not-found', 'Task does not exist')
    let receipt = record._launches?.find(row => row.input.requestId === input.requestId)
    if (receipt) {
      if (!resume && JSON.stringify(receipt.input) !== JSON.stringify(input)) {
        throw new TaskFailure('tasks/request-conflict', 'Launch request changed')
      }
      if (receipt.phase === 'abandoned') throw new TaskFailure('tasks/launch-abandoned', 'This launch was ended before prompt admission')
      if (receipt.phase === 'complete') return { task: publicTask(record), sessionId: receipt.sessionId }
      // A stored marker is not permission to call a non-idempotent Host API again.
      if (receipt.phase === 'forking') throw new TaskFailure('tasks/fork-unknown', 'Fork may have created a conversation; no first message was sent')
      if (receipt.input.forkFromSessionId && receipt.input.forkFromSessionId !== record.activeSessionId) {
        throw new TaskFailure('tasks/fork-source-changed', 'The task no longer owns the fork source')
      }
    } else {
      if (resume) throw new TaskFailure('tasks/not-found', 'Launch request does not exist')
      if (record.launch && !['complete', 'abandoned'].includes(record.launch.phase)) throw new TaskFailure('tasks/launch-pending', 'Resume the pending launch first')
      if (input.forkFromSessionId) {
        if (input.forkFromSessionId !== record.activeSessionId) throw new TaskFailure('tasks/fork-source-changed', 'Choose the current task conversation as the fork source')
        if (!input.replaceActive) throw new TaskFailure('tasks/session-exists', 'Explicit replacement is required to fork')
        if (input.workspaceId || input.agentPreset) throw new TaskFailure('tasks/bad-request', 'Fork inherits the workspace and preset from its source')
        if (!sessions?.fork) throw new TaskFailure('tasks/fork-unavailable', 'Native session fork is unavailable')
      }
      if (record.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded')
      if (!sessions) throw new TaskFailure('tasks/session-unavailable', 'Session service unavailable')
      const invalid = await options?.validate(input)
      if (invalid) throw new TaskFailure(invalid.code, invalid.message)
      await sessions.checkLaunch(record, input)
      if ((record._launches?.length ?? 0) >= (limits.maxLaunchesPerTask ?? 1000)) throw new TaskFailure('tasks/limit-reached', 'Launch history limit reached')
      receipt = { input, ...(input.forkFromSessionId ? { phase: 'forking' } : { sessionId: randomUUID(), phase: 'prepared' }),
        ...(input.includeImages && record._images?.length ? { images: record._images } : {}) }
      record = await save(receipt)
      if (receipt.phase === 'forking') {
        let child
        try { child = await sessions.fork(input.forkFromSessionId) }
        catch (error) {
          if (error?.code === 'tasks/fork-unavailable') await save({ input, phase: 'abandoned' })
          throw error
        }
        receipt = { ...receipt, ...child, phase: 'created' }
        try { record = await save(receipt) }
        catch (error) {
          // An uncertain storage acknowledgement must still quarantine the store.
          if (error?.code === 'unknown-state') throw error
          reportError(error)
          throw new TaskFailure('tasks/fork-unknown', 'Could not save the fork identity; no first message was sent')
        }
        if (receipt.attachWorkspaceId) throw new TaskFailure('tasks/fork-attach-failed', 'Resume to attach the saved fork to its workspace')
      }
    }
    if (!sessions) throw new TaskFailure('tasks/session-unavailable', 'Session service unavailable')
    // Persist each boundary before the next external side effect. Prompt admission
    // is replayed with the same DSH request id when the final task write is lost.
    if (receipt.phase === 'prepared') {
      await sessions.create(receipt)
      receipt = { ...receipt, phase: 'created' }
      record = await save(receipt)
    }
    if (receipt.attachWorkspaceId) await sessions.repairForkAttachment(receipt)
    const imageParts = receipt.images?.length ? await sessions.imageParts(receipt.images) : []
    if (receipt.phase === 'created') {
      await sessions.select(receipt)
      const { attachWorkspaceId, ...ready } = receipt
      receipt = { ...ready, phase: 'sending' }
      record = await save(receipt)
    }
    try { await sessions.prompt(receipt, imageParts) }
    catch (error) {
      if (imageParts.length && error.details?.causeCode === 'session/attachment-invalid') {
        await save({ ...receipt, phase: 'created' })
        throw new TaskFailure('tasks/prompt-image-rejected', 'Session rejected image input')
      }
      throw error
    }
    receipt = { input: receipt.input, sessionId: receipt.sessionId, phase: 'complete' }
    const workspaceId = receipt.input.forkFromSessionId ? await sessions.forkWorkspace(receipt.sessionId) : receipt.input.workspaceId
    record = await save(receipt, { workspaceId })
    return { task: publicTask(record), sessionId: receipt.sessionId }

    async function save(nextReceipt, bind = false) {
      const current = liveTask(input.taskId)
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision limit reached')
      const receipts = [...(current._launches ?? [])]
      const index = receipts.findIndex(row => row.input.requestId === input.requestId)
      if (index < 0) receipts.push(nextReceipt)
      else receipts[index] = nextReceipt
      const updated = {
          ...current, launch: nextReceipt, _launches: receipts,
          ...(bind ? {
            workspaceId: bind.workspaceId,
            activeSessionId: nextReceipt.sessionId,
            previousSessionIds: [...new Set([...(current.previousSessionIds ?? []), ...(current.activeSessionId ? [current.activeSessionId] : [])])],
            stage: current.stage === 'todo' ? 'doing' : current.stage,
            ...(current.columnId && current.stage === 'todo' ? { columnId: defaultColumn('doing'), orderKey: undefined } : {}),
          } : {}),
          revision: current.revision + 1, updatedAt: new Date().toISOString(),
      }
      if (bind && !bind.workspaceId) delete updated.workspaceId
      const next = await commit(current, updated, bind ? [{ kind: 'bound', sessionId: nextReceipt.sessionId }] : [])
      notify({ type: 'upsert', task: publicTask(next) })
      return next
    }
  }

  async function abandonLaunch(input) {
    const next = await table.update(input.taskId, current => {
      if (current._deleted) throw new TaskFailure('tasks/not-found', 'Task does not exist')
      const receipt = current.launch
      if (!receipt || receipt.input.requestId !== input.requestId) throw new TaskFailure('tasks/not-found', 'Launch request does not exist')
      if (receipt.phase === 'abandoned') return current
      if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded')
      if (!['prepared', 'forking', 'created'].includes(receipt.phase)) throw new TaskFailure('tasks/launch-pending', 'Prompt may already be accepted; resume this launch')
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision limit reached')
      const ended = { ...receipt, phase: 'abandoned' }
      return { ...current, launch: ended,
        _launches: current._launches.map(row => row.input.requestId === input.requestId ? ended : row),
        ...(receipt.sessionId ? { previousSessionIds: [...new Set([...(current.previousSessionIds ?? []), receipt.sessionId])] } : {}),
        revision: current.revision + 1, updatedAt: new Date().toISOString(),
      }
    })
    notify({ type: 'upsert', task: publicTask(next) })
    return { task: publicTask(next) }
  }

  async function mutateAttachment(input, operation) {
    const current = liveTask(input.taskId), images = current._images ?? [], files = current._files ?? []
    const adding = operation === uploadImage || operation === uploadFile
    const legacy = operation === uploadImage || operation === 'remove-image'
    const noun = legacy ? 'image' : 'file'
    const sha = adding && createHash('sha256').update(input.data).digest('hex')
    // Keep the exact fingerprints of existing images and removal receipts.
    const digest = fingerprint(adding ? { operation: legacy ? 'upload' : 'upload-file', mediaType: input.mediaType, sha,
      ...(legacy ? {} : { name: input.name }) }
      : { operation, attachmentId: input.attachmentId, revision: input.expectedRevision })
    const receipt = current._updates?.find(row => row.requestId === input.requestId)
    if (receipt) {
      if (receipt.fingerprint !== digest) throw new TaskFailure('tasks/request-conflict', `${legacy ? 'Image' : 'File'} request changed`)
      return { task: publicTask(current) }
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER || (current._updates?.length ?? 0) >= (limits.maxUpdatesPerTask ?? 10000)) throw new TaskFailure('tasks/limit-reached', 'Mutation capacity reached')
    let nextImages = images, nextFiles = files, changedRef
    if (adding) {
      const allowed = legacy ? attachments?.limits() : attachments?.fileLimits?.()
      if (!allowed) throw new TaskFailure(`tasks/${noun}s-unavailable`, `${legacy ? 'Image' : 'File'} storage unavailable`)
      const image = imageTypes.includes(input.mediaType)
      if (image && (!allowed.mediaTypes.includes(input.mediaType) || !input.data.length || input.data.length > allowed.maxImageBytes)) {
        throw new TaskFailure('tasks/invalid-image', 'Unsupported or oversized image')
      }
      if (!image && input.data.length > allowed.maxFileBytes) throw new TaskFailure('tasks/invalid-file', 'File exceeds the upload limit')
      if (images.length + files.length >= fileCapacity) throw new TaskFailure(`tasks/${noun}-limit`, `Remove an attachment first`)
      if (image) {
        let ref
        try {
          const { name: _providerName, ...hostRef } = await attachments.save(input.data, input.mediaType, input.name)
          ref = imageRef.parse({ ...hostRef, ...(legacy ? {} : { name: input.name }) })
        } catch { throw new TaskFailure('tasks/image-save-failed', 'Host could not validate or store this image') }
        if (!images.some(row => row.attachmentId === ref.attachmentId)) {
          // Some file MIME types are reported as octet-stream. When the same
          // stored bytes are later validated as an image, prefer the image ref.
          nextFiles = files.filter(row => row.attachmentId !== ref.attachmentId)
          nextImages = [...images, ref]
          changedRef = ref
        }
      } else {
        const attachmentId = 'sha256:' + sha
        if (![...images, ...files].some(row => row.attachmentId === attachmentId)) {
          try {
            const saved = await attachments.saveFile(input.data, input.name, input.mediaType)
            const ref = fileRef.parse({ attachmentId: saved.attachmentId, name: saved.name, bytes: saved.bytes, mediaType: input.mediaType })
            if (ref.attachmentId !== attachmentId || ref.bytes !== input.data.length) throw new Error('Unexpected file reference')
            nextFiles = [...files, ref]
            changedRef = ref
          } catch { throw new TaskFailure('tasks/file-save-failed', 'Host could not store this file') }
        }
      }
    } else {
      if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', `Review the latest task before removing a ${noun}`)
      const image = images.find(row => row.attachmentId === input.attachmentId)
      if (image) {
        nextImages = images.filter(row => row !== image)
        changedRef = image
      } else if (!legacy) {
        const file = files.find(row => row.attachmentId === input.attachmentId)
        if (file) {
          nextFiles = files.filter(row => row !== file)
          changedRef = file
        }
      }
    }
    const next = { ...current, ...(nextImages !== images ? { _images: nextImages } : {}),
      ...(nextFiles !== files ? { _files: nextFiles } : {}), revision: current.revision + Number(!!changedRef) }
    if (changedRef) next.updatedAt = new Date().toISOString()
    next._updates = [...(current._updates ?? []), { requestId: input.requestId, fingerprint: digest, appliedRevision: next.revision }]
    await commit(current, next, changedRef ? [{ kind: `${noun}-${adding ? 'added' : 'removed'}`, attachmentId: changedRef.attachmentId,
      ...(changedRef.name ? { name: changedRef.name } : {}) }] : [])
    const task = publicTask(next)
    if (changedRef) notify({ type: 'upsert', task })
    return { task }
  }

  function execute(operation, input, signal, source = 'service') {
    if (closing) return Promise.resolve(failure('tasks/unavailable', 'Task store is closing'))
    if (unavailableCode) return Promise.resolve(failure(unavailableCode, 'Task storage must be reopened'))
    // Isolate trusted in-process callers' mutable objects before entering the queue.
    try { input = structuredClone(input) }
    catch { return Promise.resolve(failure('tasks/bad-request', 'Input must be plain data')) }
    const result = chain.then(async () => {
      actor = source
      if (signal?.aborted) return failure('gateway/cancelled', 'Request cancelled')
      if (unavailableCode) return failure(unavailableCode, 'Task storage must be reopened')
      try {
        // Choose replay validation inside the queue, after earlier requests commit.
        const record = typeof input?.taskId === 'string' ? table.get(input.taskId) : undefined
        const schema = operation === 'create' && requests.has(input?.requestId) ? creationReplay
          : operation === 'update' && (record?._deleted || record?._updates?.some(row => row.requestId === input?.requestId)) ? updateReplay
          : operation === 'launch' && record?._launches?.some(row => row.input.requestId === input?.requestId) ? launchReplay
          : operation === uploadImage ? uploadSchema : operation === uploadFile ? uploadFileSchema : schemas.get(operation)
        if (!schema) return failure('tasks/not-found', 'Unknown operation', { endpoint: operation })
        const parsed = schema.safeParse(input)
        if (!parsed.success) return failure('tasks/bad-request', 'Invalid task input', {
          issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
        })
        let value
        if (operation === 'capabilities') {
          value = { contractVersion: 1, operations: [...schemas.keys()], features: {
            externalRef: true, externalRefUnique: true, durableUpdateReplay: true, snapshotWatch: true,
            filteredList: true, boardColumns: !!board(), boardPriorities: !!board(), collaboration: !!archive,
            taskImages: !!attachments?.limits(), taskFiles: !!attachments?.fileLimits?.(),
          }, limits: { maxTitleLength: limits.maxTitleLength, maxBriefLength: limits.maxBriefLength,
            maxTasks: limits.maxTasks, maxUpdatesPerTask: limits.maxUpdatesPerTask ?? 10000 } }
        } else if (operation === 'images') {
          const target = parsed.data.taskId && liveTask(parsed.data.taskId)
          const launchRequestId = parsed.data.launchRequestId
          const receipt = launchRequestId && target?.launch
          if (launchRequestId && (!receipt || receipt.input.requestId !== launchRequestId
            || !['prepared', 'forking', 'created', 'sending'].includes(receipt.phase))) {
            throw new TaskFailure('tasks/not-found', 'Pending launch does not exist')
          }
          value = { limits: attachments?.limits() ?? null, images: structuredClone((launchRequestId ? receipt.images : target?._images) ?? []),
            ...(target ? { revision: target.revision } : {}), ...(launchRequestId ? { launchRequestId } : {}) }
        } else if (operation === 'files') {
          const target = parsed.data.taskId && liveTask(parsed.data.taskId)
          value = { files: structuredClone([...(target?._images ?? []), ...(target?._files ?? [])]),
            limits: attachments?.fileLimits?.() ?? null, ...(target ? { revision: target.revision } : {}) }
        } else if (operation === uploadImage || operation === uploadFile || operation === 'remove-image' || operation === 'remove-file') {
          value = await mutateAttachment(parsed.data, operation)
        } else if (operation === 'board') {
          value = { board: publicBoard(board()) }
        } else if (operation === 'edit-priorities') {
          value = await editPriorities(parsed.data)
        } else if (operation === 'edit-columns') {
          value = await editColumns(parsed.data)
        } else if (operation === 'edit-labels') {
          value = await editLabels(parsed.data)
        } else if (operation === 'history') {
          const { taskId, before, limit } = parsed.data
          const events = []
          for (const { requestId, ...event } of history(liveTask(taskId), before)) {
            if (events.length === limit) break
            events.push(event)
          }
          value = { events, ...(events.at(-1)?.id > 1 ? { before: events.at(-1).id } : {}) }
        } else if (operation === 'comment') {
          const { taskId, requestId, text } = parsed.data, current = liveTask(taskId)
          if (!archive) throw new TaskFailure('tasks/unavailable', 'Activity storage unavailable')
          const prior = current.commentCount && history(current).find(event => event.kind === 'comment' && event.requestId === requestId)
          if (prior && prior.text !== text) throw new TaskFailure('tasks/request-conflict', 'Comment request changed')
          if (prior) value = { task: publicTask(current) }
          else {
            if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision capacity reached')
            const next = await commit(current, { ...current, updatedAt: new Date().toISOString(), revision: current.revision + 1,
              commentCount: (current.commentCount ?? 0) + 1 }, [{ kind: 'comment', requestId, text }])
            value = { task: publicTask(next) }
            notify({ type: 'upsert', task: value.task })
          }
        } else if (operation === 'comment-matches') {
          const matches = {}, query = parsed.data.query.toLowerCase()
          for (const [, task] of table.entries()) {
            const snippet = matchComment(task, query)
            if (snippet) matches[task.id] = snippet
          }
          value = { matches }
        } else if (operation === 'move') {
          value = await move(parsed.data)
        } else if (operation === 'options') {
          if (!options) throw new TaskFailure('tasks/options-unavailable', 'Task options unavailable')
          value = await options.list()
        } else if (operation === 'list') {
          const filter = parsed.data
          const query = filter.query?.toLowerCase(), today = filter.today ?? new Date().toLocaleDateString('sv-SE')
          const tasks = listTasks().filter(task => (!filter.stage || task.stage === filter.stage)
            && (!filter.labelId || task.labelId === filter.labelId) && (!filter.priority || task.priority === filter.priority)
            && (!filter.dueDate || task.dueDate === filter.dueDate) && (!filter.due || (task.stage !== 'done' && task.dueDate && (filter.due === 'today' ? task.dueDate === today : task.dueDate < today)))
            && (!query || [task.id, task.title, task.brief ?? ''].some(text => text.toLowerCase().includes(query)) || matchComment(table.get(task.id), query))
            && (!filter.workspaceId || task.workspaceId === filter.workspaceId)
            && (!filter.provider || task.externalRef?.provider === filter.provider)
            && (!filter.externalRef || externalKey(task.externalRef) === externalKey(filter.externalRef)))
          const offset = filter.offset ?? 0
          value = { tasks: tasks.slice(offset, filter.limit === undefined ? undefined : offset + filter.limit),
            ...(filter.limit !== undefined || filter.offset !== undefined ? { total: tasks.length } : {}) }
        } else if (operation === 'get') {
          if (!record || record._deleted) throw new TaskFailure('tasks/not-found', 'Task does not exist')
          value = { task: publicTask(record) }
        } else if (operation === 'create') {
          if (parsed.data.columnId && input.stage === undefined) {
            const existing = requests.has(input.requestId) && table.get(requests.get(input.requestId))
            if (!existing?._deleted) parsed.data.stage = existing?._create?.stage ?? findColumn(parsed.data.columnId).stage
          }
          value = await create(parsed.data)
        } else if (operation === 'update') {
          value = await updateTask(parsed.data)
        } else if (operation === 'launch' || operation === 'resume-launch') {
          value = await launchTask(parsed.data, operation === 'resume-launch')
        } else if (operation === 'abandon-launch') {
          value = await abandonLaunch(parsed.data)
        } else if (operation === 'delete') {
          value = await deleteTask(parsed.data)
        } else {
          value = await setStage(parsed.data)
        }
        return { ok: true, value, streamId, sequence }
      } catch (error) {
        if (error instanceof TaskFailure) return failure(error.code, error.message, error.details)
        if (error?.taskSessionFailure) return failure(error.code, error.message, error.details ?? {})
        if (error?.code === 'missing-key') {
          return failure('tasks/not-found', 'Task does not exist', { taskId: input.taskId })
        }
        reportError(error)
        const unknown = error?.code === 'unknown-state'
        if (unknown) {
          unavailableCode = 'tasks/persistence-unknown'
          notify({ type: 'unavailable', code: unavailableCode })
        }
        return failure(unknown ? 'tasks/persistence-unknown' : 'tasks/persistence-failed',
          unknown ? 'Storage state is uncertain; reload before retrying' : 'Task storage operation failed', {
            operation,
            ...(typeof error?.code === 'string' ? { storageCode: error.code } : {}),
          })
      }
    })
    // Failed operations do not prevent independent later operations from running.
    chain = result.then(() => {}, () => {})
    return result
  }

  /** Register and read the baseline in the queue; the caller owns subscription cleanup. */
  function watch(observer, signal, includeBoard = false) {
    if (closing) return Promise.reject(new TaskFailure('tasks/unavailable', 'Task store is closing'))
    const ready = chain.then(() => {
      if (signal?.aborted) throw new TaskFailure('gateway/cancelled', 'Request cancelled')
      if (closing) throw new TaskFailure('tasks/unavailable', 'Task store is closing')
      if (unavailableCode) throw new TaskFailure(unavailableCode, 'Task storage must be reopened')
      const dispose = () => {
        observers.delete(observer)
        boardObservers.delete(observer)
        subscriptionDisposers.delete(dispose)
        signal?.removeEventListener('abort', dispose)
      }
      observer({ type: 'snapshot', sequence, streamId, tasks: listTasks(), statuses: structuredClone(statuses), ...(includeBoard ? { board: publicBoard(board()) } : {}) })
      if (signal?.aborted || closing) return dispose
      observers.add(observer)
      if (includeBoard) boardObservers.add(observer)
      signal?.addEventListener('abort', dispose, { once: true })
      subscriptionDisposers.add(dispose)
      return dispose
    })
    chain = ready.then(() => {}, () => {})
    return ready
  }

  function close() {
    if (disposal === undefined) {
      closing = true
      // Assign before notifying: an observer can initiate its own disposal.
      disposal = chain.then(() => domain.close())
      notify({ type: 'unavailable', code: 'tasks/unavailable' })
      for (const dispose of subscriptionDisposers) dispose()
      subscriptionDisposers.clear()
      observers.clear()
      // Drain the plugin queue first: its accepted jobs may not have entered
      // the Domain write queue yet. Domain.close then drains and releases it.
    }
    return disposal
  }

  function updateStatus(taskId, status) {
    if (closing || unavailableCode || JSON.stringify(statuses[taskId]) === JSON.stringify(status)) return
    let task
    try { task = table.get(taskId) }
    catch (error) {
      // A failing write can quarantine the Domain before execute() publishes
      // its unavailable event. Passive status sampling must not reject then.
      if (error?.code === 'unknown-state') return
      throw error
    }
    if (!task || task._deleted || task.activeSessionId !== status.sessionId) return
    statuses[taskId] = status
    notify({ type: 'status', taskId, status })
  }
  return { execute, watch, close, updateStatus }
}
