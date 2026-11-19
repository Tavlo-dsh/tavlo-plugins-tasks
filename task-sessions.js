/** Published Session APIs: durable launch recovery and passive board status. */
import { z } from 'zod'
import { sessionId as sessionIdSchema } from './task-schema.js'

function refusal(code, message, details = {}) {
  return Object.assign(new Error(message), { code, details, taskSessionFailure: true })
}

export function createTaskSessions(ctx) {
  const lifetime = new AbortController()
  const signal = lifetime.signal
  const controller = () => {
    const value = ctx.get('sessionController')
    if (!value) throw refusal('tasks/session-unavailable', 'Session service unavailable')
    return value
  }
  const archived = id => ctx.get('workspaceRegistry')?.archivedSessionIds?.includes(id) ?? false
  async function remote(operation) {
    try { return await operation(controller()) }
    catch (error) {
      if (error?.taskSessionFailure) throw error
      throw refusal('tasks/launch-failed', 'Session operation failed; resume the saved launch', { ...(error?.code ? { causeCode: error.code } : {}) })
    }
  }
  async function state(id) {
    try { return await controller().state({ sessionId: id }, signal) }
    catch (error) { if (error?.code === 'session/not-found') return null; throw error }
  }
  return {
    async checkLaunch(task, input) {
      if (input.forkFromSessionId && typeof ctx.get('sessionController')?.fork !== 'function') {
        throw refusal('tasks/fork-unavailable', 'Native session fork is unavailable')
      }
      controller()
      if (input.agentPreset) {
        const presets = await remote(() => ctx.get('agentPresets')?.list())
        if (!presets?.some(row => row.id === input.agentPreset && !row.broken)) throw refusal('tasks/preset-unavailable', 'Preset unavailable')
      }
      if (!task.activeSessionId) return
      if (!input.replaceActive) throw refusal('tasks/session-exists', 'Open the existing conversation or explicitly start a new one')
      await remote(async () => {
        let current
        try { current = await state(task.activeSessionId) }
        catch (error) {
          if (!input.forkFromSessionId) throw error
          throw refusal('tasks/fork-unavailable', 'Could not read the fork source')
        }
        if (!current && input.forkFromSessionId) throw refusal('tasks/fork-unavailable', 'Fork source no longer exists')
        if (current && (current.running || current.pendingInput.length || current.queue?.length)) throw refusal('tasks/session-busy', 'The existing conversation is still active')
      })
    },
    async fork(parent) {
      const service = ctx.get('sessionController')
      if (typeof service?.fork !== 'function') throw refusal('tasks/fork-unavailable', 'Native session fork is unavailable')
      let child, attachWorkspaceId
      try { child = (await service.fork({ sessionId: parent, allowMigration: false }))?.sessionId }
      catch (error) {
        if (['session/not-found', 'session/fork-unavailable', 'session/migration-required'].includes(error?.code)) {
          throw refusal('tasks/fork-unavailable', 'Source cannot be forked', { causeCode: error.code })
        }
        // Only this specific Host failure identifies an already-created child.
        if (error?.code === 'session/workspace-attach-failed' && z.uuid().safeParse(error.details?.workspaceId).success) {
          child = error.details.sessionId
          attachWorkspaceId = error.details.workspaceId
        }
      }
      if (!sessionIdSchema.safeParse(child).success || child === parent) {
        throw refusal('tasks/fork-unknown', 'Fork may have created a conversation; no first message was sent')
      }
      return { sessionId: child, ...(attachWorkspaceId ? { attachWorkspaceId } : {}) }
    },
    async repairForkAttachment({ sessionId, attachWorkspaceId }) {
      try {
        const workspace = ctx.get('workspaceRegistry')?.get(attachWorkspaceId)
        if (!workspace) throw new Error('Missing workspace')
        if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
      } catch { throw refusal('tasks/fork-attach-failed', 'Could not attach the saved fork to its workspace') }
    },
    async forkWorkspace(sessionId) {
      return remote(() => ctx.get('workspaceRegistry')?.list().find(workspace => workspace.sessionIds.includes(sessionId))?.id)
    },
    async create(receipt) {
      await remote(async service => {
        const { sessionId, input } = receipt
        if (archived(sessionId)) throw refusal('tasks/session-archived', 'Unarchive the saved conversation before resuming')
        // Do not call create again on an existing Session: DSH may mint a new ID
        // when the named Session is no longer blank.
        if (!await state(sessionId)) {
          const created = await service.create({ sessionId, ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}), ...(input.agentPreset ? { agentPreset: input.agentPreset } : {}) })
          if (created.sessionId !== sessionId) throw refusal('tasks/session-changed', 'Session identity changed', { sessionId: created.sessionId })
        }
        if (input.workspaceId) {
          const workspace = ctx.get('workspaceRegistry')?.get(input.workspaceId)
          if (!workspace) throw refusal('tasks/workspace-unavailable', 'Workspace unavailable')
          if (!workspace.sessionIds.includes(sessionId)) await workspace.attachSession(sessionId)
        }
      })
    },
    async select({ sessionId, input }) {
      if (archived(sessionId)) throw refusal('tasks/session-archived', 'Unarchive the saved conversation before resuming')
      if (input.model) await remote(service => service.selectModel({ sessionId, ...input.model }))
    },
    async imageParts(images) {
      const attachments = ctx.get('attachments'), limits = attachments?.imageLimits
      if (!limits || typeof attachments.readImage !== 'function') throw refusal('tasks/prompt-image-unavailable', 'Image storage unavailable')
      if (images.length > limits.maxImagesPerMessage || images.reduce((sum, ref) => sum + ref.bytes, 0) > limits.maxMessageImageBytes
        || images.some(ref => ref.bytes > limits.maxImageBytes || !limits.mediaTypes.includes(ref.mediaType))) {
        throw refusal('tasks/prompt-image-rejected', 'Images exceed the session attachment limits')
      }
      const parts = []
      for (const ref of images) {
        try {
          const { data } = await attachments.readImage(ref, signal)
          if (!(data instanceof Uint8Array) || data.byteLength !== ref.bytes) throw new Error('Incomplete attachment')
          parts.push({ type: 'image', mediaType: ref.mediaType, data: Buffer.from(data).toString('base64') })
        } catch { throw refusal('tasks/prompt-image-unavailable', 'Could not read saved task image') }
      }
      return parts
    },
    async prompt({ sessionId, input }, images = []) {
      if (archived(sessionId)) throw refusal('tasks/session-archived', 'Unarchive the saved conversation before resuming')
      await remote(service => service.prompt({ sessionId, requestId: 'tasks.' + input.requestId, mode: 'queue', content: [{ type: 'text', text: input.content }, ...images] }, signal))
    },
    /** One Host observer, independent of browser count; pending-input changes also get sampled. */
    async watch(store, intervalMs) {
      const tasks = new Map()
      const endings = new Map()
      let closed = false
      let running = false
      let dirty = false
      async function refresh() {
        if (closed) return
        if (running) { dirty = true; return }
        running = true
        try {
          do {
            dirty = false
            const bySession = new Map()
            for (const task of tasks.values()) {
              if (!task.activeSessionId) continue
              const ids = bySession.get(task.activeSessionId) ?? []
              ids.push(task.id)
              bySession.set(task.activeSessionId, ids)
            }
            for (const [sessionId, ids] of bySession) {
              let status
              try {
                const current = await state(sessionId)
                if (!current) status = 'missing'
                else if (archived(sessionId)) status = 'archived'
                else if (current.pendingInput.includes('approval')) status = 'approval'
                else if (current.pendingInput.includes('question')) status = 'question'
                else if (current.running || current.queue?.length) status = 'running'
                else {
                  let end = endings.get(sessionId)
                  if (!end || end.cursor !== current.cursor) {
                    const observation = await ctx.get('sessionQuery').observeSession(sessionId, { signal })
                    try {
                      const last = observation.events.findLast(event => event.type === 'turn/end')
                      end = { cursor: current.cursor, error: last?.data.reason.kind === 'error' }
                      endings.set(sessionId, end)
                    } finally { observation[Symbol.dispose]() }
                  }
                  status = end.error ? 'error' : 'idle'
                }
              } catch { status = 'unknown' }
              if (closed) break
              for (const id of ids) if (tasks.get(id)?.activeSessionId === sessionId) store.updateStatus(id, { sessionId, status })
            }
            for (const id of endings.keys()) if (!bySession.has(id)) endings.delete(id)
          } while (dirty && !closed)
        } finally { running = false }
      }
      const unwatch = await store.watch(event => {
        if (event.type === 'snapshot') { tasks.clear(); for (const task of event.tasks) tasks.set(task.id, task) }
        if (event.type === 'upsert') tasks.set(event.task.id, event.task)
        if (event.type === 'remove') tasks.delete(event.taskId)
        if (['snapshot', 'upsert', 'remove'].includes(event.type)) void refresh()
      })
      const disposers = ['session/event', 'agent/status', 'session/disposed'].map(name => ctx.on(name, () => { void refresh() }, { global: true }))
      const timer = setInterval(() => { void refresh() }, intervalMs)
      return () => { closed = true; clearInterval(timer); unwatch(); for (const dispose of disposers) dispose() }
    },
    close() { lifetime.abort() },
  }
}
