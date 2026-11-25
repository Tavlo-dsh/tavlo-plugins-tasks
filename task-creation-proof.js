const nonnegativeInteger = n => Number.isSafeInteger(n) && n >= 0
const nonemptyString = s => typeof s === 'string' && s.length > 0

function ownTarget(window, sessionId, type) {
  const event = window?.target
  // readEvent({before: 0, after: 0}) returns exactly the requested raw event.
  // SessionSeq is zero-based: [0, inheritedEventCount) belongs to the parent.
  if (window?.session?.id !== sessionId || event?.type !== type
    || !nonnegativeInteger(window.inheritedEventCount) || !nonnegativeInteger(event.seq)
    || event.seq < window.inheritedEventCount || !nonnegativeInteger(event.time)
    || window.startSeq !== event.seq || window.endSeq !== event.seq
    || !Array.isArray(window.events) || window.events.length !== 1 || window.events[0]?.seq !== event.seq) return
  return event
}

function parseObject(text) {
  if (typeof text !== 'string') return
  try {
    const obj = JSON.parse(text)
    if (obj !== null && typeof obj === 'object' && !Array.isArray(obj)) return obj
  } catch { /* Invalid or truncated tool JSON cannot prove creation. */ }
}

/** Verify two exact host readEvent windows, not transcript snippets or caller-supplied events. */
export function matchesCreationProof(task, sessionId, callWindow, resultWindow) {
  const create = task?._create
  if (!nonemptyString(sessionId) || !nonemptyString(task?.id) || create?.stage !== 'doing'
    || !nonemptyString(create.requestId) || typeof task.createdAt !== 'string') return false

  const call = ownTarget(callWindow, sessionId, 'tool/call')
  const result = ownTarget(resultWindow, sessionId, 'tool/result')
  if (!call || !result || callWindow.inheritedEventCount !== resultWindow.inheritedEventCount
    || call.seq >= result.seq || call.surfaceOp !== undefined || call.sourceEventSeqs !== undefined
    || result.surfaceOp !== 'append' || !Array.isArray(result.sourceEventSeqs)
    || result.sourceEventSeqs.length !== 1 || result.sourceEventSeqs[0] !== call.seq) return false

  const invocation = call.data, outcome = result.data, message = outcome?.message
  if (invocation?.name !== 'tasks_create' || !nonemptyString(invocation.callId)
    || !nonnegativeInteger(invocation.turn) || invocation.turn !== outcome?.turn
    || !nonnegativeInteger(invocation.step) || invocation.step !== outcome?.step
    || outcome.error !== undefined || message?.role !== 'tool' || message.source?.kind !== 'tool'
    || message.source.callId !== invocation.callId || message.toolCallId !== invocation.callId
    || (message.isError !== undefined && message.isError !== false)) return false

  // An idempotent retry can return the original rev-1 task, even from another session.
  const created = Date.parse(task.createdAt)
  if (!Number.isFinite(created) || new Date(created).toISOString() !== task.createdAt
    || call.time > created || created > result.time) return false
  const args = parseObject(invocation.arguments)
  if (args?.requestId !== create.requestId) return false
  // A custom doing column may supply the stage implicitly; never use today's board mapping.
  if (args.stage === undefined ? !nonemptyString(args.columnId) || args.columnId !== create.columnId : args.stage !== 'doing') return false

  if (!Array.isArray(message.content) || message.content.length !== 1 || message.content[0]?.type !== 'text') return false
  const receipt = parseObject(message.content[0].text), original = receipt?.value?.task
  return receipt?.ok === true && receipt.error === undefined && original?.id === task.id
    && original.revision === 1 && original.stage === 'doing' && original.createdAt === task.createdAt
}
