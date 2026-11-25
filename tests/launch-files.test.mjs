import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { callTask, mountHost, readTaskDatabase } from './fixtures.mjs'

const filePath = '/api/dsh-plugin-tasks/file'
const imagePath = '/api/dsh-plugin-tasks/image'
const idFor = data => 'sha256:' + createHash('sha256').update(data).digest('hex')
const ok = result => { assert(result.ok, JSON.stringify(result)); return result.value }
const call = (host, operation, input) => callTask(host.rpc, operation, input)
const query = params => '?' + new URLSearchParams(params)
const create = async host => ok(await call(host, 'create', { requestId: randomUUID(), title: 'Prompt files' })).task
const uploadFile = (host, taskId, requestId, data, name) => host.fetchAuthenticated(filePath + '/upload' + query({ taskId, requestId, name }), {
  method: 'POST', body: data,
})
const uploadImage = (host, taskId, requestId, data) => host.fetchAuthenticated(imagePath + '/upload' + query({ taskId, requestId }), {
  method: 'POST', headers: { 'Content-Type': 'image/png' }, body: data,
})

function attachmentFixture() {
  const files = new Map(), images = new Map()
  return {
    files,
    imageLimits: { maxImageBytes: 128, maxImagesPerMessage: 8, maxMessageImageBytes: 512, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    async saveFile({ data, name }) {
      const ref = { attachmentId: idFor(data), bytes: data.byteLength, name }
      files.set(`${ref.attachmentId}/${name}`, Buffer.from(data))
      return ref
    },
    async *readFileStream(ref, signal) {
      signal?.throwIfAborted()
      const data = files.get(`${ref.attachmentId}/${ref.name}`)
      if (!data) throw new Error('Stored file is missing')
      yield data.subarray(0, 2)
      yield data.subarray(2)
      if (idFor(data) !== ref.attachmentId || data.byteLength !== ref.bytes) throw new Error('Stored file integrity check failed')
    },
    async saveImage({ data, mediaType, name }) {
      if (data[0] !== 42) throw new Error('Decoder rejected data')
      const ref = { attachmentId: idFor(data), mediaType, bytes: data.byteLength, width: 3, height: 2, name }
      images.set(ref.attachmentId, Buffer.from(data))
      return ref
    },
    async readImage(ref) { return { data: images.get(ref.attachmentId), ref } },
  }
}

/** Native upload receipts are deliberately unique per session and staging call. */
function sessionFixture({ loseFirstFilePrompt = false, rejectFilePrompt = false } = {}) {
  const sessions = new Map(), receiptsBySession = new Map(), admitted = new Set()
  const staged = [], prompts = []
  let loseNext = loseFirstFilePrompt
  const notFound = () => Object.assign(new Error('Session not found'), { code: 'session/not-found' })
  const controller = {
    async state({ sessionId }) {
      const state = sessions.get(sessionId)
      if (!state) throw notFound()
      return state
    },
    async create({ sessionId }) {
      sessions.set(sessionId, { running: false, pendingInput: [], queue: [], cursor: 0 })
      return { sessionId }
    },
    async fork({ sessionId }) {
      assert(sessions.has(sessionId), 'fork source should exist')
      const child = 'session-' + randomUUID()
      sessions.set(child, structuredClone(sessions.get(sessionId)))
      return { sessionId: child }
    },
    async prompt(input) {
      prompts.push(structuredClone(input))
      const key = `${input.sessionId}/${input.requestId}`
      if (!admitted.has(key)) admitted.add(key)
      if (rejectFilePrompt && input.content.some(part => part.type === 'file')) {
        throw Object.assign(new Error('Native session rejected its file'), { code: 'session/attachment-invalid' })
      }
      if (loseNext && input.content.some(part => part.type === 'file')) {
        loseNext = false
        throw new Error('Lost prompt acknowledgement')
      }
      return { accepted: true }
    },
  }
  const fileUploads = {
    fail: false,
    async uploadStream({ sessionId, data, name, signal }) {
      if (this.fail) throw new Error('Native staging failed')
      const chunks = []
      for await (const chunk of data) {
        signal?.throwIfAborted()
        chunks.push(Buffer.from(chunk))
      }
      const bytes = Buffer.concat(chunks)
      const count = (receiptsBySession.get(sessionId) ?? 0) + 1
      receiptsBySession.set(sessionId, count)
      const receiptId = `native-${sessionId}-${count}`
      const file = { attachmentId: idFor(bytes), bytes: bytes.byteLength, name }
      staged.push({ sessionId, receiptId, name, file, data: bytes })
      return { receiptId, file }
    },
  }
  return { controller, fileUploads, staged, prompts, admitted }
}

async function mount(t, attachments, sessions, options = {}) {
  const host = await mountHost(t, { attachments, sessionController: sessions.controller, ...options })
  // The file-upload provider is intentionally resolved at call time by the task plugin.
  host.ctx.provide('fileUploads', sessions.fileUploads)
  return host
}

async function attachFile(host, taskId, requestId, data, name) {
  const response = await uploadFile(host, taskId, requestId, data, name)
  assert.equal(response.status, 200)
  return ok(await response.json()).task
}

async function attachImage(host, taskId, requestId, data) {
  const response = await uploadImage(host, taskId, requestId, data)
  assert.equal(response.status, 200)
  return ok(await response.json()).task
}

function launchInput(task, overrides = {}) {
  return { taskId: task.id, expectedRevision: task.revision, requestId: randomUUID(), content: 'Inspect these attachments', ...overrides }
}

test('includeFiles stages empty and named files byte-for-byte, after validated images', async t => {
  const attachments = attachmentFixture(), sessions = sessionFixture(), host = await mount(t, attachments, sessions), task = await create(host)
  const raster = Buffer.from([42, 3, 5, 8]), empty = Buffer.alloc(0), text = Buffer.from('exact file bytes\n\x00tail')
  await attachImage(host, task.id, 'image', raster)
  await attachFile(host, task.id, 'empty-file', empty, 'empty.bin')
  const latest = await attachFile(host, task.id, 'named-file', text, 'résumé-notes.txt')
  const input = launchInput(latest, { includeFiles: true })

  const launched = ok(await call(host, 'launch', input))
  assert.equal(launched.task.launch.phase, 'complete')
  assert.equal(sessions.staged.length, 2)
  assert.deepEqual(sessions.staged.map(({ name, data }) => [name, data]), [
    ['empty.bin', empty], ['résumé-notes.txt', text],
  ])
  assert.deepEqual(sessions.prompts[0].content, [
    { type: 'text', text: input.content },
    { type: 'image', mediaType: 'image/png', data: raster.toString('base64') },
    { type: 'file', receiptId: sessions.staged[0].receiptId },
    { type: 'file', receiptId: sessions.staged[1].receiptId },
  ])
  assert.equal(sessions.prompts[0].requestId, `tasks.${input.requestId}`)
  assert.equal(sessions.prompts[0].sessionId, launched.sessionId)
})

test('omitted includeFiles sends no files; includeImages remains images-only', async t => {
  const attachments = attachmentFixture(), sessions = sessionFixture(), host = await mount(t, attachments, sessions), task = await create(host)
  const raster = Buffer.from([42, 12]), file = Buffer.from('not part of an image-only launch')
  await attachImage(host, task.id, 'image', raster)
  const latest = await attachFile(host, task.id, 'file', file, 'private.txt')

  const omitted = launchInput(latest)
  const first = ok(await call(host, 'launch', omitted))
  assert.deepEqual(sessions.prompts[0].content, [{ type: 'text', text: omitted.content }])
  assert.equal(sessions.staged.length, 0)

  const imageOnly = launchInput(first.task, { includeFiles: false, includeImages: true, replaceActive: true })
  ok(await call(host, 'launch', imageOnly))
  assert.deepEqual(sessions.prompts[1].content, [
    { type: 'text', text: imageOnly.content },
    { type: 'image', mediaType: 'image/png', data: raster.toString('base64') },
  ])
  assert.equal(sessions.staged.length, 0)
})

test('missing file bytes and native staging failures never fall back to a text-only prompt', async t => {
  for (const failure of ['missing-bytes', 'staging']) {
    await t.test(failure, async subtest => {
      const attachments = attachmentFixture(), sessions = sessionFixture(), host = await mount(subtest, attachments, sessions)
      const task = await create(host), data = Buffer.from('must not be silently omitted')
      const latest = await attachFile(host, task.id, 'file', data, 'required.txt')
      if (failure === 'missing-bytes') attachments.files.delete(`${idFor(data)}/required.txt`)
      else sessions.fileUploads.fail = true

      const input = launchInput(latest, { includeFiles: true })
      assert.equal((await call(host, 'launch', input)).error.code, 'tasks/prompt-file-unavailable')
      assert.equal(sessions.prompts.length, 0)
      assert.equal(sessions.staged.length, 0)
    })
  }
})

test('native file rejection returns prompt-file-rejected and leaves the launch resumable', async t => {
  const attachments = attachmentFixture(), sessions = sessionFixture({ rejectFilePrompt: true }), host = await mount(t, attachments, sessions), task = await create(host)
  const latest = await attachFile(host, task.id, 'file', Buffer.from('rejected'), 'rejected.txt')
  const input = launchInput(latest, { includeFiles: true })
  assert.equal((await call(host, 'launch', input)).error.code, 'tasks/prompt-file-rejected')
  assert.equal(sessions.prompts.length, 1)
  assert.equal(sessions.prompts[0].content[1].type, 'file')
  const pending = ok(await call(host, 'get', { taskId: task.id })).task
  assert.equal(pending.launch.phase, 'created')
})

for (const fork of [false, true]) test(`${fork ? 'fork' : 'blank'} launch freezes files across unlink and restart; native receipts are restaged`, async t => {
  const attachments = attachmentFixture(), sessions = sessionFixture({ loseFirstFilePrompt: true })
  let host = await mount(t, attachments, sessions), task = await create(host)
  let parentSessionId
  if (fork) {
    const parent = ok(await call(host, 'launch', launchInput(task, { content: 'Create a fork source' })))
    task = parent.task
    parentSessionId = parent.sessionId
  }
  const bytes = Buffer.from([0, 255, 9, 0, 17])
  const current = await attachFile(host, task.id, 'frozen-file', bytes, 'snapshot.bin')
  const input = launchInput(current, { includeFiles: true, ...(fork ? { replaceActive: true, forkFromSessionId: parentSessionId } : {}) })
  assert.equal((await call(host, 'launch', input)).error.code, 'tasks/launch-failed')
  const firstPrompt = sessions.prompts.at(-1)
  const saved = readTaskDatabase(host.storageRoot).tables.tasks[task.id]._launches.find(row => row.input.requestId === input.requestId)
  assert.deepEqual(saved.files, [{ attachmentId: idFor(bytes), bytes: bytes.length, name: 'snapshot.bin', mediaType: 'application/octet-stream' }])

  let pending = ok(await call(host, 'get', { taskId: task.id })).task
  const remove = { taskId: task.id, requestId: 'unlink-snapshotted-file', attachmentId: idFor(bytes), expectedRevision: pending.revision }
  pending = ok(await call(host, 'remove-file', remove)).task
  assert.equal(ok(await call(host, 'files', { taskId: task.id })).files.length, 0)
  const changedBytes = Buffer.from('replacement with the same name')
  await attachFile(host, task.id, 'changed-file', changedBytes, 'snapshot.bin')
  const currentFiles = ok(await call(host, 'files', { taskId: task.id })).files
  assert.deepEqual(currentFiles.map(({ attachmentId, name }) => ({ attachmentId, name })), [
    { attachmentId: idFor(changedBytes), name: 'snapshot.bin' },
  ])
  const frozen = ok(await call(host, 'files', { taskId: task.id, launchRequestId: input.requestId }))
  assert.equal(frozen.launchRequestId, input.requestId)
  assert.deepEqual(frozen.files, saved.files)

  const targetSessionId = firstPrompt.sessionId
  await host.shutdown()
  host = await mount(t, attachments, sessions, { storageRoot: host.storageRoot })
  ok(await call(host, 'resume-launch', { taskId: task.id, requestId: input.requestId }))
  const secondPrompt = sessions.prompts.at(-1)
  assert.equal(secondPrompt.sessionId, targetSessionId)
  assert.equal(secondPrompt.requestId, `tasks.${input.requestId}`)
  assert.notEqual(firstPrompt.content.find(part => part.type === 'file').receiptId,
    secondPrompt.content.find(part => part.type === 'file').receiptId)
  assert.deepEqual(sessions.staged.filter(row => row.name === 'snapshot.bin').map(row => row.data), [bytes, bytes])
  assert.equal(sessions.admitted.size, fork ? 2 : 1)
  assert.equal((await call(host, 'files', { taskId: task.id, launchRequestId: input.requestId })).error.code, 'tasks/not-found')
})
