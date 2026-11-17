/** Serialized task operations over a caller-owned Storage Domain. */
import { randomUUID } from 'node:crypto'
import { createInputSchemas } from './task-schema.js'

class TaskFailure extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.code = code
    this.details = details
  }
}

const failure = (code, message, details = {}) => ({ ok: false, error: { code, message, details } })

function publicTask(record) {
  const { _create, _launches, ...task } = record
  return structuredClone(task)
}

/**
 * Own a validated domain, deduplication index, and operation queue.
 * @param domain - freshly opened taskDomain; ownership transfers on success.
 * @param limits - resolved plugin Config.
 * @param reportError - diagnostic sink for unexpected storage errors.
 * @param options - optional live workspace/model lookup and binding validation.
 * @returns execute(), watch() with a subscription disposer, and idempotent close().
 */
export function createTaskStore(domain, limits, reportError = () => {}, options, sessions) {
  const table = domain.table('tasks')
  const requests = new Map()
  const { operations: schemas, creationReplay, launchReplay } = createInputSchemas(limits)
  let nextPosition = 0
  // Domain.open validates individual values. These checks validate relationships.
  for (const [key, record] of table.entries()) {
    const requestId = record._deleted?.requestId ?? record._create.requestId
    if (key !== record.id || requests.has(requestId)) {
      throw new Error(`tasks: inconsistent record identity or duplicate creation request at '${key}'`)
    }
    requests.set(requestId, key)
    if (record._deleted) continue
    const receipts = record._launches ?? []
    if (receipts.some(row => row.input.taskId !== key)
      || new Set(receipts.map(row => row.input.requestId)).size !== receipts.length
      || JSON.stringify(record.launch) !== JSON.stringify(receipts.at(-1))) {
      throw new Error(`tasks: inconsistent launch history at '${key}'`)
    }
    nextPosition = Math.max(nextPosition, Math.floor(record.position) + 1)
  }

  let chain = Promise.resolve()
  let closing = false
  let disposal
  let sequence = 0
  const streamId = randomUUID()
  let unavailableCode
  const observers = new Set()
  const statuses = {}

  function listTasks() {
    const records = [...table.entries()].map(([, record]) => record).filter(record => !record._deleted)
    records.sort((a, b) => a.position - b.position || a.id.localeCompare(b.id))
    return records.map(publicTask)
  }

  function notify(event) {
    sequence++
    for (const observer of [...observers]) {
      try { observer({ ...event, sequence, streamId }) } catch (error) { reportError(error) }
    }
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
      if ((existing._create.stage ?? 'todo') !== input.stage
        || existing._create.workspaceId !== input.workspaceId || !sameModel(existing._create.model, input.model)) {
        throw new TaskFailure('tasks/request-conflict', 'Creation request was already used with different bindings', {
          requestId: input.requestId, taskId: existingId,
        })
      }
      return { task: publicTask(existing) }
    }
    if (input.workspaceId || input.model) {
      const error = options ? await options.validate(input) : { code: 'tasks/options-unavailable', message: 'Task options unavailable' }
      if (error) throw new TaskFailure(error.code, error.message)
    }
    if ([...table.entries()].filter(([, record]) => !record._deleted).length >= limits.maxTasks) {
      throw new TaskFailure('tasks/limit-reached', 'Task limit reached', { resource: 'tasks', limit: limits.maxTasks })
    }
    if (!Number.isSafeInteger(nextPosition)) {
      throw new TaskFailure('tasks/limit-reached', 'Task ordering capacity reached', { resource: 'position' })
    }
    const now = new Date().toISOString()
    const record = {
      id: randomUUID(), revision: 1, title: input.title,
      ...(input.brief === '' ? {} : { brief: input.brief }),
      stage: input.stage, position: nextPosition, createdAt: now, updatedAt: now,
      ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
      ...(input.model ? { model: input.model } : {}),
      _create: { ...input },
    }
    await table.put(record.id, record)
    // Commit the index and ordering only after the record is durable.
    requests.set(input.requestId, record.id)
    nextPosition++
    notify({ type: 'upsert', task: publicTask(record) })
    return { task: publicTask(record) }
  }

  async function setStage(input) {
    const next = await table.update(input.taskId, current => {
      if (current._deleted) throw new TaskFailure('tasks/not-found', 'Task does not exist')
      if (current.revision !== input.expectedRevision) {
        throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded', {
          taskId: input.taskId, currentRevision: current.revision,
        })
      }
      if (current.revision === Number.MAX_SAFE_INTEGER) {
        throw new TaskFailure('tasks/limit-reached', 'Task revision capacity reached', { resource: 'revision' })
      }
      return { ...current, stage: input.stage, revision: current.revision + 1, updatedAt: new Date().toISOString() }
    })
    notify({ type: 'upsert', task: publicTask(next) })
    return { task: publicTask(next) }
  }

  async function deleteTask(input) {
    const current = table.get(input.taskId)
    if (!current) throw new TaskFailure('tasks/not-found', 'Task does not exist')
    if (current._deleted) return { taskId: current.id, revision: current._deleted.revision }
    if (current.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded')
    if (current.launch && !['complete', 'abandoned'].includes(current.launch.phase)) {
      throw new TaskFailure('tasks/launch-pending', 'Resolve the pending launch before deleting this task')
    }
    if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Task revision capacity reached')
    const revision = current.revision + 1
    await table.put(current.id, { id: current.id, _deleted: { requestId: current._create.requestId, revision, at: new Date().toISOString() } })
    delete statuses[current.id]
    notify({ type: 'remove', taskId: current.id, revision })
    return { taskId: current.id, revision }
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
    } else {
      if (resume) throw new TaskFailure('tasks/not-found', 'Launch request does not exist')
      if (record.launch && !['complete', 'abandoned'].includes(record.launch.phase)) throw new TaskFailure('tasks/launch-pending', 'Resume the pending launch first')
      if (record.revision !== input.expectedRevision) throw new TaskFailure('tasks/revision-conflict', 'Task changed since it was loaded')
      if (!sessions) throw new TaskFailure('tasks/session-unavailable', 'Session service unavailable')
      const invalid = await options?.validate(input)
      if (invalid) throw new TaskFailure(invalid.code, invalid.message)
      await sessions.checkLaunch(record, input)
      if ((record._launches?.length ?? 0) >= (limits.maxLaunchesPerTask ?? 1000)) throw new TaskFailure('tasks/limit-reached', 'Launch history limit reached')
      receipt = { input, sessionId: randomUUID(), phase: 'prepared' }
      record = await save(receipt)
    }
    if (!sessions) throw new TaskFailure('tasks/session-unavailable', 'Session service unavailable')
    // Persist each boundary before the next external side effect. Prompt admission
    // is replayed with the same DSH request id when the final task write is lost.
    if (receipt.phase === 'prepared') {
      await sessions.create(receipt)
      receipt = { ...receipt, phase: 'created' }
      record = await save(receipt)
    }
    if (receipt.phase === 'created') {
      await sessions.select(receipt)
      receipt = { ...receipt, phase: 'sending' }
      record = await save(receipt)
    }
    await sessions.prompt(receipt)
    receipt = { ...receipt, phase: 'complete' }
    record = await save(receipt, true)
    return { task: publicTask(record), sessionId: receipt.sessionId }

    async function save(nextReceipt, bind = false) {
      const next = await table.update(input.taskId, current => {
        if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision limit reached')
        const receipts = [...(current._launches ?? [])]
        const index = receipts.findIndex(row => row.input.requestId === input.requestId)
        if (index < 0) receipts.push(nextReceipt)
        else receipts[index] = nextReceipt
        return {
          ...current, launch: nextReceipt, _launches: receipts,
          ...(bind ? {
            activeSessionId: nextReceipt.sessionId,
            previousSessionIds: [...new Set([...(current.previousSessionIds ?? []), ...(current.activeSessionId ? [current.activeSessionId] : [])])],
            stage: current.stage === 'todo' ? 'doing' : current.stage,
          } : {}),
          revision: current.revision + 1, updatedAt: new Date().toISOString(),
        }
      })
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
      if (!['prepared', 'created'].includes(receipt.phase)) throw new TaskFailure('tasks/launch-pending', 'Prompt may already be accepted; resume this launch')
      if (current.revision >= Number.MAX_SAFE_INTEGER) throw new TaskFailure('tasks/limit-reached', 'Revision limit reached')
      const ended = { ...receipt, phase: 'abandoned' }
      return { ...current, launch: ended,
        _launches: current._launches.map(row => row.input.requestId === input.requestId ? ended : row),
        previousSessionIds: [...new Set([...(current.previousSessionIds ?? []), receipt.sessionId])],
        revision: current.revision + 1, updatedAt: new Date().toISOString(),
      }
    })
    notify({ type: 'upsert', task: publicTask(next) })
    return { task: publicTask(next) }
  }

  function execute(operation, input, signal) {
    if (closing) return Promise.resolve(failure('tasks/unavailable', 'Task store is closing'))
    if (unavailableCode) return Promise.resolve(failure(unavailableCode, 'Task storage must be reopened'))
    // A committed request remains replayable after limits are lowered.
    const schema = operation === 'create' && requests.has(input?.requestId)
      ? creationReplay : operation === 'launch' && typeof input?.taskId === 'string'
        && table.get(input.taskId)?._launches?.some(row => row.input.requestId === input?.requestId)
        ? launchReplay : schemas.get(operation)
    if (schema === undefined) {
      return Promise.resolve(failure('tasks/not-found', 'Unknown operation', { endpoint: operation }))
    }
    const parsed = schema.safeParse(input)
    if (!parsed.success) {
      return Promise.resolve(failure('tasks/bad-request', 'Invalid task input', {
        issues: parsed.error.issues.map(({ code, path, message }) => ({ code, path, message })),
      }))
    }
    const result = chain.then(async () => {
      if (signal?.aborted) return failure('gateway/cancelled', 'Request cancelled')
      if (unavailableCode) return failure(unavailableCode, 'Task storage must be reopened')
      try {
        let value
        if (operation === 'list') {
          value = { tasks: listTasks() }
        } else if (operation === 'create') {
          value = await create(parsed.data)
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
          return failure('tasks/not-found', 'Task does not exist', { taskId: parsed.data.taskId })
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
  function watch(observer, signal) {
    if (closing) return Promise.reject(new TaskFailure('tasks/unavailable', 'Task store is closing'))
    const ready = chain.then(() => {
      if (signal?.aborted) throw new TaskFailure('gateway/cancelled', 'Request cancelled')
      if (unavailableCode) throw new TaskFailure(unavailableCode, 'Task storage must be reopened')
      observer({ type: 'snapshot', sequence, streamId, tasks: listTasks(), statuses: { ...statuses } })
      observers.add(observer)
      return () => { observers.delete(observer) }
    })
    chain = ready.then(() => {}, () => {})
    return ready
  }

  function close() {
    if (disposal === undefined) {
      closing = true
      observers.clear()
      // Drain the plugin queue first: its accepted jobs may not have entered
      // the Domain write queue yet. Domain.close then drains and releases it.
      disposal = chain.then(() => domain.close())
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
