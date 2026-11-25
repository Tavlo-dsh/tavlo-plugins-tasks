import assert from 'node:assert/strict'
import test from 'node:test'
import { matchesCreationProof } from '../task-creation-proof.js'

const session = 'session-2aba3f34-f945-4633-b01a-7cb37053656c'
const id = '9330d46b-03ad-49e0-9883-1594e88c46d7'
const createdAt = '2026-01-01T00:00:00.000Z', ms = Date.parse(createdAt)
const callId = 'example-call', requestId = 'example-intent'
const windowOf = (target, inheritedEventCount = 0) => ({ session: { id: session }, inheritedEventCount,
  startSeq: target.seq, endSeq: target.seq, events: [target], target })

// Same shape as two exact V4 readEvent results. Nothing here is read from a profile.
function example() {
  const args = { requestId, title: 'Example', stage: 'doing' }
  const task = { id, createdAt, stage: 'done', revision: 8, _create: { ...args, brief: '' } }
  const call = { type: 'tool/call', seq: 371, time: ms - 1,
    data: { name: 'tasks_create', callId, turn: 10, step: 2, arguments: JSON.stringify(args) } }
  const original = { id, revision: 1, stage: 'doing', createdAt }
  const receipt = { ok: true, value: { task: original }, streamId: 'test', sequence: 1 }
  const msg = { id: 'example-message', role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId,
    isError: false, content: [{ type: 'text', text: JSON.stringify(receipt) }] }
  const result = { type: 'tool/result', seq: 372, time: ms + 1, surfaceOp: 'append',
    sourceEventSeqs: [371], data: { turn: 10, step: 2, message: msg } }
  const cw = windowOf(call), rw = windowOf(result)
  return { task, call, result, msg, cw, rw, args, original, receipt,
    setArgs: a => { call.data.arguments = JSON.stringify(a) },
    setReceipt: r => { msg.content[0].text = JSON.stringify(r) },
    verify: () => matchesCreationProof(task, session, cw, rw) }
}

test('accepts a direct native creation even after changes to the task', () => {
  const ex = example()
  assert.equal(ex.verify(), true)
  // Neither adjacency nor distinct milliseconds is required by ToolRuntime.
  ex.result.seq = ex.rw.startSeq = ex.rw.endSeq = 380
  ex.call.time = ex.result.time = ms
  delete ex.msg.isError
  assert.equal(ex.verify(), true)
})

test('handles a doing stage originally inferred from the stored column', () => {
  const ex = example()
  delete ex.args.stage
  ex.args.columnId = ex.task._create.columnId = '7eed1f2c-61e3-491d-99b9-8d21cd661cd8'
  ex.setArgs(ex.args)
  assert.equal(ex.verify(), true)
  ex.task._create.columnId = 'different-column'
  assert.equal(ex.verify(), false)
})

test('zero-based readEvent seq: the last inherited event is excluded; the first own event is eligible', () => {
  const { cw, rw, verify } = example()
  cw.inheritedEventCount = rw.inheritedEventCount = 372 // call at 371 is inherited, result at 372 is own
  assert.equal(verify(), false)
  cw.inheritedEventCount = rw.inheritedEventCount = 371 // inherited seqs are 0..370
  assert.equal(verify(), true)
})

const reject = (label, change) => test(`rejects ${label}`, () => {
  const ex = example()
  change(ex)
  assert.equal(ex.verify(), false)
})

reject('missing call header id', ({ cw }) => { delete cw.session.id })
reject('a result read from another session', ({ rw }) => { rw.session.id = 'other' })
reject('missing fork boundary', ({ cw }) => { delete cw.inheritedEventCount })
reject('negative fork boundary', ({ cw, rw }) => { cw.inheritedEventCount = rw.inheritedEventCount = -1 })
reject('inconsistent fork boundaries', ({ rw }) => { rw.inheritedEventCount = 1 })
reject('a broader-than-requested window', ({ rw }) => { rw.events.push({ seq: ++rw.endSeq }) })
reject('a malformed exact window', ({ cw }) => { cw.events = [] })
reject('an out-of-order result', ({ result, rw }) => { result.seq = rw.startSeq = rw.endSeq = 370 })
reject('a user message containing a call payload', ({ call }) => { call.type = 'user/message' })
reject('an MCP tool with the same unqualified name', ({ call }) => { call.data.name = 'mcp__dsh_tasks__tasks_create' })
reject('an assistant message quoting a result', ({ result }) => { result.type = 'assistant/message' })
reject('a replacement instead of the original tool result', ({ result }) => { result.surfaceOp = { op: 'replace', startSeq: 371, endSeq: 371 } })
reject('a result without a source seq', ({ result }) => { delete result.sourceEventSeqs })
reject('a result sourced from another call', ({ result }) => { result.sourceEventSeqs = [370] })
reject('ambiguous source seqs', ({ result }) => { result.sourceEventSeqs.unshift(370) })
reject('a missing call id even if the result also lacks ids', ({ call, msg }) => { delete call.data.callId; delete msg.toolCallId; delete msg.source.callId })
reject('a different result source id', ({ msg }) => { msg.source.callId = 'another-call' })
reject('a different tool call id', ({ msg }) => { msg.toolCallId = 'another-call' })
reject('a non-tool result source', ({ msg }) => { msg.source.kind = 'user' })
reject('a non-tool result role', ({ msg }) => { msg.role = 'assistant' })
reject('a different invocation step', ({ result }) => { result.data.step++ })
reject('malformed call arguments', ({ call }) => { call.data.arguments = '{' })
reject('a different request id', ({ args, setArgs }) => { setArgs({ ...args, requestId: 'other' }) })
reject('a public task record without its creation inputs', ({ task }) => { delete task._create })
reject('a task only moved to doing later', ({ task }) => { task.stage = 'doing'; task._create.stage = 'todo' })
reject('an implicit historical default stage', ({ task }) => { delete task._create.stage })
reject('contradictory call stage', ({ args, setArgs }) => { setArgs({ ...args, stage: 'todo' }) })
reject('a later rev-1 idempotent replay', ({ call, result }) => { call.time = ms + 10; result.time = ms + 11 })
reject('a result that predates the creation instant', ({ result }) => { result.time = ms - 1 })
reject('a nonnumeric timestamp', ({ call }) => { call.time = String(ms) })
reject('an invalid stored creation instant', ({ task, original, receipt, setReceipt }) => { task.createdAt = original.createdAt = 'invalid'; setReceipt(receipt) })
reject('a runtime error with success-looking text', ({ msg }) => { msg.isError = true })
reject('a tool failure outside the message', ({ result }) => { result.data.error = { name: 'Error', code: 'failed' } })
reject('multiple result blocks', ({ msg }) => { msg.content.push({ type: 'text', text: 'more' }) })
reject('an image block with a text property', ({ msg }) => { msg.content[0].type = 'image' })
reject('malformed result text', ({ msg }) => { msg.content[0].text = 'tool said ok' })
reject('a failure envelope', ({ receipt, setReceipt }) => { setReceipt({ ...receipt, ok: false }) })
reject('another task id', ({ receipt, original, setReceipt }) => { original.id = 'other'; setReceipt(receipt) })
reject('a later result revision', ({ receipt, original, setReceipt }) => { original.revision++; setReceipt(receipt) })
reject('a different result creation instant', ({ receipt, original, setReceipt }) => { original.createdAt = new Date(ms + 1).toISOString(); setReceipt(receipt) })
reject('a result from a different original stage', ({ receipt, original, setReceipt }) => { original.stage = 'todo'; setReceipt(receipt) })

test('missing proof data returns false', () => {
  const { task, cw, rw } = example()
  assert.equal(matchesCreationProof(null, session, cw, rw), false)
  assert.equal(matchesCreationProof(task, undefined, cw, rw), false)
  assert.equal(matchesCreationProof(task, session, undefined, rw), false)
  assert.equal(matchesCreationProof(task, session, cw, {}), false)
})
