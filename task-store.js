/** Serialized task operations over a caller-owned Storage Domain. */
import { createHash, randomUUID } from 'node:crypto'
import { createInputSchemas, pageSize, imageRef, imageTypes, fileRef, fileCapacity, uploadImage, uploadSchema, uploadFile, uploadFileSchema,
  submitDelivery, submitDeliverySchema, recoverCreationSession, recoverCreationSessionSchema, sessionId as sessionIdSchema } from './task-schema.js'
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
  const { _create, _creationSessionId, _launches, _updates, _tail, _images, _files, _deliveryReceipts, ...task } = record
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

// A creator can already be executing the work. No launch, prompt or new Session took place.
function creationBinding(record) {
  return record._creationSessionId && { sessionId: record._creationSessionId, criteria: record._create.acceptanceCriteria || undefined }
}
const activeBinding = record => record.activeSessionId && (record.activeSessionId === record._creationSessionId
  ? creationBinding(record) : record._launches?.findLast(row => row.sessionId === record.activeSessionId && row.phase === 'complete'))
const launchInProgress = record => record.launch && !['complete', 'abandoned'].includes(record.launch.phase)

function validateDeliveryRecords(record, launches) {
  const complete = new Map(launches.filter(row => row.phase === 'complete').map(row => [row.sessionId, row]))
  const creator = creationBinding(record)
  if (creator) {
    if (record._create.stage !== 'doing' || complete.has(creator.sessionId)
      || (record.activeSessionId !== creator.sessionId && !record.previousSessionIds?.includes(creator.sessionId))) {
      throw new Error(`tasks: inconsistent creation binding at '${record.id}'`)
    }
    complete.set(creator.sessionId, creator)
  }
  const sessions = new Map(), reviews = new Map(), submissions = new Set(), reviewRequests = new Set()
  let latest, previousSubmission, appliedRevision = 0
  const invalid = () => { throw new Error(`tasks: inconsistent delivery history at '${record.id}'`) }
  for (const receipt of record._deliveryReceipts ?? []) {
    const { deliveryId, requestId } = receipt
    if (receipt.appliedRevision <= appliedRevision || receipt.appliedRevision > record.revision) invalid()
    appliedRevision = receipt.appliedRevision
    if (receipt.kind === 'submission') {
      if (!complete.has(receipt.sessionId) || sessions.has(deliveryId) || submissions.has(requestId)
        || (previousSubmission && !reviews.has(previousSubmission))) invalid()
      sessions.set(deliveryId, receipt.sessionId)
      submissions.add(requestId)
      previousSubmission = deliveryId
      if (receipt.sessionId === record.activeSessionId) latest = deliveryId
    } else {
      if (deliveryId !== previousSubmission || reviews.has(deliveryId) || reviewRequests.has(requestId)) invalid()
      reviews.set(deliveryId, receipt.decision)
      reviewRequests.add(requestId)
    }
  }
  const { delivery } = record
  if (delivery?.id !== latest) invalid()
  if (delivery && (delivery.sessionId !== record.activeSessionId || delivery.criteria !== complete.get(delivery.sessionId)?.criteria
    || delivery.status !== ({ accept: 'accepted', return: 'returned' }[reviews.get(delivery.id)] ?? 'pending')
    || (delivery.status !== 'accepted' && record.stage === 'done')
    || (delivery.status === 'pending' && launchInProgress(record)))) invalid()
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
  const records = new Map(entries), incoming = new Map()
  for (const [key, record] of records) {
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
    validateDeliveryRecords(record, receipts)
    for (const id of new Set([...(record.dependencyIds ?? []), ...(record._create.dependencyIds ?? [])])) {
      if (id === key || !records.has(id)) throw new Error(`tasks: inconsistent dependency identity at '${key}'`)
    }
    for (const id of record.dependencyIds ?? []) incoming.set(id, (incoming.get(id) ?? 0) + 1)
    nextPosition = Math.max(nextPosition, Math.floor(record.position) + 1)
  }
  // Nodes representing deleted prerequisites have no outgoing edges. Keep
  // them valid, but detect cycles among all live links without recursion.
  const ready = [...records.keys()].filter(id => !incoming.has(id))
  for (const id of ready) {
    for (const dependency of records.get(id).dependencyIds ?? []) {
      const count = incoming.get(dependency) - 1
      if (count) incoming.set(dependency, count)
      else { incoming.delete(dependency); ready.push(dependency) }
    }
  }
  if (incoming.size) throw new Error('tasks: cyclic dependencies')
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
  function validateDependencies(ids = [], task) {
    const prior = new Set(task?.dependencyIds), seen = new Set(), queue = [...ids]
    for (const dependencyId of ids) {
      const prerequisite = table.get(dependencyId)
      // A deleted prerequisite can stay until its owner removes it, but must
      // not be newly assigned (or reassigned after having been removed).
      if (!prerequisite || (prerequisite._deleted && !prior.has(dependencyId))) {
        throw new TaskFailure('tasks/dependency-missing', 'Prerequisite task no longer exists', { dependencyId })
      }
    }
    if (!task) return
    for (const id of queue) {
      if (id === task.id) throw new TaskFailure('tasks/dependency-cycle', 'Task dependencies cannot form a cycle', { taskId: task.id })
      if (seen.has(id)) continue
      seen.add(id)
      for (const dependency of table.get(id)?.dependencyIds ?? []) queue.push(dependency)
    }
  }
  function assertManualCompletion(task, stage) {
    if (stage !== 'done' || task.stage === 'done') return
    if (task.delivery && task.delivery.status !== 'accepted') {
      throw new TaskFailure('tasks/delivery-review-required', 'Only accepting a pending delivery can complete this task', { deliveryId: task.delivery.id })
    }
    if (actor === 'agent' && !task.delivery && (task.acceptanceCriteria || activeBinding(task)?.criteria)) {
      throw new TaskFailure('tasks/delivery-required', 'Submit delivery evidence for owner review instead of completing this task')
    }
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

  async function recoverCreation(input, signal) {
    const current = liveTask(input.taskId), { sessionId } = input
    if (current._creationSessionId === sessionId && current.activeSessionId === sessionId) return { task: publicTask(current) }
    if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Read the latest task before recovery')
    // Comments are independent progress notes. Account for every revision and activity;
    // never recover across a move, field update, launch, delivery or missing history.
    const comments = current.commentCount ?? 0
    if (current.revision !== 1 + comments || current._tail?.at(-1)?.id !== current.revision
      || current._create.stage !== 'doing' || current.stage !== 'doing'
      || current.activeSessionId || current.launch || current.previousSessionIds?.length) {
      throw new TaskFailure('tasks/creation-unverified', 'Task changed beyond comments or already has a conversation')
    }
    let seq = current.revision
    for (const event of history(current)) {
      if (event?.id !== seq || (seq === 1 ? event.kind !== 'created' || event.source !== 'agent' : event.kind !== 'comment')) {
        throw new TaskFailure('tasks/creation-unverified', 'Task history does not consist of agent creation and comments')
      }
      seq--
    }
    if (seq !== 0 || !await sessions?.verifyCreation?.(current, input, signal)) {
      throw new TaskFailure('tasks/creation-unverified', 'Cannot verify the original native creation of this doing task')
    }
    const next = await commit(current, { ...current, activeSessionId: sessionId, _creationSessionId: sessionId,
      revision: current.revision + 1, updatedAt: new Date().toISOString() }, [{ kind: 'bound', sessionId }])
    const task = publicTask(next)
    notify({ type: 'upsert', task })
    return { task }
  }

  async function create(input, creatorSessionId) {
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
        || (existing._create.acceptanceCriteria ?? '') !== (input.acceptanceCriteria ?? '')
        || fingerprint(existing._create.dependencyIds ?? []) !== fingerprint(input.dependencyIds ?? [])
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
    validateDependencies(input.dependencyIds)
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
      ...(input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {}),
      ...(input.dependencyIds?.length ? { dependencyIds: input.dependencyIds } : {}),
      stage: input.stage, position: nextPosition, createdAt: now, updatedAt: now,
      ...(column ? { columnId: column.id } : {}),
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.model ? { model: input.model } : {}),
      ...(input.externalRef ? { externalRef: input.externalRef } : {}),
      ...Object.fromEntries(['labelId', 'priority', 'dueDate'].filter(key => input[key]).map(key => [key, input[key]])),
      ...(creatorSessionId ? { activeSessionId: creatorSessionId, _creationSessionId: creatorSessionId } : {}),
      _create: { ...input },
    }
    if (column) {
      let last
      for (const [, row] of table.entries()) if (row.columnId === column.id && row.orderKey && (!last || row.orderKey > last.orderKey)) last = row
      if (last && last.orderKey >= orderKey(record)) record.orderKey = newRank(last)
    }
    const events = [{ kind: 'created' }]
    if (creatorSessionId) events.push({ kind: 'bound', sessionId: creatorSessionId })
    await commit(null, record, events)
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
    if (input.patch.acceptanceCriteria !== undefined) {
      if (input.patch.acceptanceCriteria) next.acceptanceCriteria = input.patch.acceptanceCriteria
      else delete next.acceptanceCriteria
    }
    if (input.patch.dependencyIds !== undefined) {
      validateDependencies(input.patch.dependencyIds, current)
      if (input.patch.dependencyIds.length) next.dependencyIds = input.patch.dependencyIds
      else delete next.dependencyIds
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

  const deliveryMutation = (record, receipt, replayed) => ({
    task: publicTask(record), deliveryId: receipt.deliveryId,
    mutation: { requestId: receipt.requestId, appliedRevision: receipt.appliedRevision, replayed },
  })
  function assertDeliveryRevision(current, expectedRevision) {
    if (current.revision !== expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded', {
      taskId: current.id, currentRevision: current.revision,
    })
  }
  function nextDeliveryRevision(current) {
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Task revision capacity reached')
    return current.revision + 1
  }
  async function commitDelivery(current, next, event) {
    await commit(current, next, event ? [event] : [])
    notify({ type: 'upsert', task: publicTask(next) })
  }
  async function submitTaskDelivery({ taskId, requestId, ...evidence }, sessionId) {
    const current = liveTask(taskId), binding = activeBinding(current)
    if (!binding || current.activeSessionId !== sessionId) {
      throw new TaskFailure('tasks/delivery-session-mismatch', 'Only the current bound conversation may submit its delivery')
    }
    if (!evidence.verification) delete evidence.verification
    if (!evidence.remaining) delete evidence.remaining
    const digest = fingerprint(evidence)
    const prior = current._deliveryReceipts?.find(row => row.kind === 'submission' && row.requestId === requestId)
    if (prior) {
      if (prior.sessionId !== sessionId || prior.fingerprint !== digest) throw new TaskFailure('tasks/request-conflict', 'Submission request changed')
      return deliveryMutation(current, prior, true)
    }
    if (current.stage === 'done') throw new TaskFailure('tasks/delivery-task-done', 'The task is already done')
    if (launchInProgress(current)) throw new TaskFailure('tasks/launch-pending', 'A new conversation is being bound to this task')
    if (current.delivery?.status === 'pending') throw new TaskFailure('tasks/delivery-pending', 'A delivery is already awaiting review')
    // Reserve the review slot as well: reaching the limit must never strand a pending delivery.
    if ((current._deliveryReceipts?.length ?? 0) >= 10000) throw new TaskFailure('tasks/limit-reached', 'Delivery receipt limit reached')
    const revision = nextDeliveryRevision(current), updatedAt = new Date().toISOString()
    const delivery = { id: randomUUID(), sessionId, ...evidence, ...(binding.criteria ? { criteria: binding.criteria } : {}),
      submittedAt: updatedAt, status: 'pending' }
    const receipt = { kind: 'submission', requestId, sessionId, deliveryId: delivery.id, fingerprint: digest, appliedRevision: revision }
    const next = { ...current, revision, updatedAt, delivery, _deliveryReceipts: [...(current._deliveryReceipts ?? []), receipt] }
    await commitDelivery(current, next, { kind: 'delivery-submitted', sessionId, text: delivery.summary })
    return deliveryMutation(next, receipt, false)
  }
  async function reviewTaskDelivery({ taskId, expectedRevision, deliveryId, requestId, decision, feedback }) {
    const current = liveTask(taskId), { delivery } = current
    const digest = fingerprint({ deliveryId, expectedRevision, decision, feedback: feedback || undefined })
    const prior = current._deliveryReceipts?.find(row => row.kind === 'review' && row.requestId === requestId)
    if (prior) {
      if (prior.fingerprint !== digest) throw new TaskFailure('tasks/request-conflict', 'Review request changed')
      return deliveryMutation(current, prior, true)
    }
    assertDeliveryRevision(current, expectedRevision)
    if (delivery?.id !== deliveryId || delivery.status !== 'pending') {
      throw new TaskFailure('tasks/delivery-not-pending', 'This delivery is no longer awaiting review')
    }
    const revision = nextDeliveryRevision(current), updatedAt = [new Date().toISOString(), delivery.submittedAt].sort().at(-1)
    const status = decision === 'accept' ? 'accepted' : 'returned', stage = decision === 'accept' ? 'done' : 'doing'
    const receipt = { kind: 'review', requestId, deliveryId, decision, fingerprint: digest, appliedRevision: revision }
    const next = { ...current, revision, updatedAt, stage,
      ...(current.columnId && current.stage !== stage ? { columnId: defaultColumn(stage), orderKey: undefined } : {}),
      delivery: { ...delivery, status, reviewedAt: updatedAt, ...(feedback ? { feedback } : {}) },
      _deliveryReceipts: [...current._deliveryReceipts, receipt] }
    await commitDelivery(current, next, { kind: `delivery-${status}`, sessionId: delivery.sessionId, text: feedback || delivery.summary })
    return deliveryMutation(next, receipt, false)
  }
  async function continueTaskDelivery({ taskId, expectedRevision, deliveryId }) {
    const current = liveTask(taskId), { delivery } = current
    if (delivery?.id !== deliveryId || delivery.status !== 'returned' || delivery.sessionId !== current.activeSessionId) {
      throw new TaskFailure('tasks/delivery-not-returned', 'No current returned delivery to continue')
    }
    if (delivery.continuedAt) return { task: publicTask(current) }
    assertDeliveryRevision(current, expectedRevision)
    if (launchInProgress(current)) throw new TaskFailure('tasks/launch-pending', 'A new conversation is being bound to this task')
    if (!sessions?.continueDelivery) throw new TaskFailure('tasks/session-unavailable', 'Session service unavailable')
    const revision = nextDeliveryRevision(current)
    await sessions.continueDelivery(taskId, delivery)
    const updatedAt = [new Date().toISOString(), delivery.reviewedAt].sort().at(-1)
    const next = { ...current, revision, updatedAt, delivery: { ...delivery, continuedAt: updatedAt } }
    await commitDelivery(current, next)
    return { task: publicTask(next) }
  }

  async function setStage(input) {
    const current = liveTask(input.taskId)
    if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded', { taskId: current.id, currentRevision: current.revision })
    assertManualCompletion(current, input.stage)
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
    assertManualCompletion(task, column.stage)
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
      columns.push({ id: randomUUID(), stage: input.stage, name: input.name, ...(input.color ? { color: input.color } : {}) })
    } else {
      const column = findColumn(input.columnId)
      if (input.action === 'rename') columns = columns.map(row => {
        if (row.id !== column.id) return row
        const next = { ...row, name: input.name }
        if (input.color === null) delete next.color
        else if (input.color !== undefined) next.color = input.color
        return next
      })
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
      if (record.delivery?.status === 'pending') throw new TaskFailure('tasks/delivery-pending', 'Review the pending delivery before replacing its conversation')
      const blockers = (record.dependencyIds ?? []).filter(id => table.get(id)?.stage !== 'done')
      if (blockers.length) throw new TaskFailure('tasks/dependencies-blocked', 'Complete the prerequisite tasks before launching', { dependencyIds: blockers })
      if (!sessions) throw new TaskFailure('tasks/session-unavailable', 'Session service unavailable')
      const invalid = await options?.validate(input)
      if (invalid) throw new TaskFailure(invalid.code, invalid.message)
      await sessions.checkLaunch(record, input)
      if ((record._launches?.length ?? 0) >= (limits.maxLaunchesPerTask ?? 1000)) throw new TaskFailure('tasks/limit-reached', 'Launch history limit reached')
      receipt = { input, ...(input.forkFromSessionId ? { phase: 'forking' } : { sessionId: randomUUID(), phase: 'prepared' }),
        ...(record.acceptanceCriteria ? { criteria: record.acceptanceCriteria } : {}),
        ...((input.includeFiles || input.includeImages) && record._images?.length ? { images: record._images } : {}),
        ...(input.includeFiles && record._files?.length ? { files: record._files } : {}) }
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
    const fileParts = receipt.files?.length ? await sessions.fileParts(receipt, receipt.files) : []
    if (receipt.phase === 'created') {
      await sessions.select(receipt)
      const { attachWorkspaceId, ...ready } = receipt
      receipt = { ...ready, phase: 'sending' }
      record = await save(receipt)
    }
    try { await sessions.prompt(receipt, [...imageParts, ...fileParts]) }
    catch (error) {
      if ((imageParts.length || fileParts.length) && error.details?.causeCode === 'session/attachment-invalid') {
        await save({ ...receipt, phase: 'created' })
        if (imageParts.length && (!fileParts.length || /IMAGE/.test(error.details.attachmentReason ?? ''))) {
          throw new TaskFailure('tasks/prompt-image-rejected', 'Session rejected image input')
        }
        throw new TaskFailure('tasks/prompt-file-rejected', 'Session rejected a task file')
      }
      throw error
    }
    receipt = { input: receipt.input, sessionId: receipt.sessionId, phase: 'complete', ...(receipt.criteria ? { criteria: receipt.criteria } : {}) }
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
      if (bind) {
        if (!bind.workspaceId) delete updated.workspaceId
        if (current.activeSessionId !== nextReceipt.sessionId) delete updated.delivery
      }
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

  function execute(operation, input, signal, source = 'service', agentSessionId) {
    if (source !== 'rpc' && (operation === 'review-delivery' || operation === 'continue-delivery')) {
      return Promise.resolve(failure('tasks/not-found', 'Unknown operation', { endpoint: operation }))
    }
    if (operation === recoverCreationSession && (source !== 'agent' || !sessionIdSchema.safeParse(agentSessionId).success)) {
      return Promise.resolve(failure('tasks/creation-unverified', 'Recovery requires a native Agent conversation'))
    }
    if (operation === submitDelivery && (source !== 'agent' || !sessionIdSchema.safeParse(agentSessionId).success)) {
      return Promise.resolve(failure('tasks/delivery-session-mismatch', 'Delivery requires an authenticated Agent conversation'))
    }
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
          : operation === uploadImage ? uploadSchema : operation === uploadFile ? uploadFileSchema
          : operation === recoverCreationSession ? recoverCreationSessionSchema
          : operation === submitDelivery ? submitDeliverySchema : schemas.get(operation)
        if (!schema) return failure('tasks/not-found', 'Unknown operation', { endpoint: operation })
        const parsed = schema.safeParse(input)
        if (!parsed.success) return failure('tasks/bad-request', 'Invalid task input', {
          issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
        })
        let value
        if (operation === 'capabilities') {
          value = { contractVersion: 1, operations: [...schemas.keys()].filter(key => source === 'rpc' || !['review-delivery', 'continue-delivery'].includes(key)), features: {
            acceptanceCriteria: true, taskDependencies: true, taskDelivery: true,
            externalRef: true, externalRefUnique: true, durableUpdateReplay: true, snapshotWatch: true,
            filteredList: true, boardColumns: !!board(), boardPriorities: !!board(), collaboration: !!archive,
            taskImages: !!attachments?.limits(), taskFiles: !!attachments?.fileLimits?.(), taskFileLaunch: !!sessions?.canSendFiles?.(),
          }, limits: { maxTitleLength: limits.maxTitleLength, maxBriefLength: limits.maxBriefLength,
            maxTasks: limits.maxTasks, maxUpdatesPerTask: limits.maxUpdatesPerTask ?? 10000 } }
        } else if (operation === 'images' || operation === 'files') {
          const target = parsed.data.taskId && liveTask(parsed.data.taskId)
          const launchRequestId = parsed.data.launchRequestId
          const receipt = launchRequestId && target?.launch
          if (launchRequestId && (!receipt || receipt.input.requestId !== launchRequestId
            || !['prepared', 'forking', 'created', 'sending'].includes(receipt.phase))) {
            throw new TaskFailure('tasks/not-found', 'Pending launch does not exist')
          }
          const images = (receipt ? receipt.images : target?._images) ?? []
          const files = (receipt ? receipt.files : target?._files) ?? []
          value = { ...(operation === 'images'
            ? { limits: attachments?.limits() ?? null, images: structuredClone(images) }
            : { limits: attachments?.fileLimits?.() ?? null, files: structuredClone([...images, ...files]) }),
            ...(target ? { revision: target.revision } : {}), ...(launchRequestId ? { launchRequestId } : {}) }
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
          const creator = source === 'agent' && parsed.data.stage === 'doing' && sessionIdSchema.safeParse(agentSessionId).success
            ? agentSessionId : undefined
          value = await create(parsed.data, creator)
        } else if (operation === recoverCreationSession) {
          value = await recoverCreation(parsed.data, signal)
        } else if (operation === 'update') {
          value = await updateTask(parsed.data)
        } else if (operation === submitDelivery) {
          value = await submitTaskDelivery(parsed.data, agentSessionId)
        } else if (operation === 'review-delivery') {
          value = await reviewTaskDelivery(parsed.data)
        } else if (operation === 'continue-delivery') {
          value = await continueTaskDelivery(parsed.data)
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
            operation: typeof operation === 'symbol' ? operation.description : operation,
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
    if (closing || unavailableCode) return
    const previous = statuses[taskId]
    if (previous?.sessionId === status.sessionId && previous?.status === status.status
      && (status.since === undefined || previous.since === status.since)) return
    let task
    try { task = table.get(taskId) }
    catch (error) {
      // A failing write can quarantine the Domain before execute() publishes
      // its unavailable event. Passive status sampling must not reject then.
      if (error?.code === 'unknown-state') return
      throw error
    }
    if (!task || task._deleted || task.activeSessionId !== status.sessionId) return
    const next = {
      sessionId: status.sessionId,
      status: status.status,
      since: status.since ?? (previous?.sessionId === status.sessionId && previous?.status === status.status
        ? previous.since : new Date().toISOString()),
    }
    statuses[taskId] = next
    notify({ type: 'status', taskId, status: next })
  }
  return { execute, watch, close, updateStatus }
}
