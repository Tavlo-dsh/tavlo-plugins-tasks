import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { StorageError } from '@deepseek-ai/dsh-storage'
import { callTask, mountHost, readTaskDatabase, writeTaskDatabase } from './fixtures.mjs'

const path = '/api/dsh-plugin-tasks/image'
const ok = result => { assert(result.ok, JSON.stringify(result)); return result.value }
const call = (host, op, input) => callTask(host.rpc, op, input)
const create = async host => ok(await call(host, 'create', { requestId: randomUUID(), title: 'Text survives' })).task.id
const query = params => '?' + new URLSearchParams(params)
const upload = (host, taskId, requestId, body, mediaType = 'image/png') => host.fetchAuthenticated(path + '/upload' + query({ taskId, requestId }), { method: 'POST', headers: { 'Content-Type': mediaType }, body })
function attachmentFixture() {
  const objects = new Map()
  return { imageLimits: { maxImageBytes: 128, mediaTypes: ['image/png', 'image/jpeg', 'image/svg+xml'] },
    async saveImage({ data, mediaType }) {
      if (data[0] !== 42) throw new Error('Decoder rejected data')
      const attachmentId = 'sha256:' + createHash('sha256').update(data).digest('hex')
      objects.set(attachmentId, data)
      return { attachmentId, bytes: data.length, mediaType, width: 2, height: 2, name: 'not retained' }
    },
    async readImage(ref) { return { data: objects.get(ref.attachmentId), ref } },
  }
}

for (const fork of [false, true]) test(`${fork ? 'fork' : 'blank'} launch retries send frozen image bytes after unlink and restart; text-only launches omit them`, async context => {
  const attachments = attachmentFixture(), prompts = [], sessions = new Set(), forks = []
  const sessionController = {
    async fork({ sessionId }) { forks.push(sessionId); const child = 'session-' + randomUUID(); sessions.add(child); return { sessionId: child } },
    async create({ sessionId }) { sessions.add(sessionId); return { sessionId } },
    async state({ sessionId }) {
      if (!sessions.has(sessionId)) throw Object.assign(new Error(), { code: 'session/not-found' })
      return { running: false, pendingInput: [], queue: [], cursor: 0 }
    },
    async prompt(input) { if (input.content[0].text !== 'Parent') prompts.push(input); if (prompts.length === 1) throw new Error('Lost reply'); return { accepted: true } },
  }
  const host = await mountHost(context, { attachments, sessionController }), taskId = await create(host)
  const parent = fork && ok(await call(host, 'launch', { taskId, expectedRevision: 1, requestId: randomUUID(), content: 'Parent' })).sessionId
  assert.equal(ok(await call(host, 'options', {})).canFork, true)
  const images = [Buffer.from([42, 1]), Buffer.from([42, 2])]
  for (const data of images) ok(await (await upload(host, taskId, randomUUID(), data)).json())
  const gallery = ok(await call(host, 'images', { taskId }))
  const input = { taskId, expectedRevision: gallery.revision, requestId: randomUUID(), content: 'Inspect both', includeImages: true,
    ...(fork ? { forkFromSessionId: parent, replaceActive: true } : {}) }
  assert.equal((await call(host, 'launch', input)).error.code, 'tasks/launch-failed')
  const [pending] = ok(await call(host, 'list', {})).tasks
  assert(!JSON.stringify(pending).includes('sha256:'))
  ok(await call(host, 'remove-image', { taskId, requestId: randomUUID(), expectedRevision: pending.revision, attachmentId: gallery.images[0].attachmentId }))
  const frozenInput = { taskId, launchRequestId: input.requestId }
  assert.deepEqual(ok(await call(host, 'images', frozenInput)).images, gallery.images)
  assert.equal(ok(await call(host, 'images', { taskId })).images.length, 1)
  const frozenUrl = path + query({ ...frozenInput, attachmentId: gallery.images[0].attachmentId })
  const frozenResponse = await host.fetchAuthenticated(frozenUrl)
  assert.equal(frozenResponse.status, 200)
  assert.equal(frozenResponse.headers.get('Cache-Control'), 'private, no-store')
  assert.deepEqual(Buffer.from(await frozenResponse.arrayBuffer()), images[0])
  assert.equal((await host.fetchAuthenticated(path + query({ taskId, launchRequestId: '', attachmentId: gallery.images[1].attachmentId }))).status, 404)
  assert.equal((await call(host, 'images', { launchRequestId: input.requestId })).error.code, 'tasks/bad-request')
  const otherId = await create(host)
  assert.equal((await call(host, 'images', { taskId: otherId, launchRequestId: input.requestId })).error.code, 'tasks/not-found')
  await host.shutdown()
  const reopened = await mountHost(context, { storageRoot: host.storageRoot, attachments, sessionController })
  const bound = ok(await call(reopened, 'resume-launch', { taskId, requestId: input.requestId })).task
  assert.equal((await call(reopened, 'images', frozenInput)).error.code, 'tasks/not-found')
  assert.equal((await reopened.fetchAuthenticated(frozenUrl)).status, 404)
  assert.deepEqual(prompts[0], prompts[1])
  assert.deepEqual(prompts[1].content, [{ type: 'text', text: input.content }, ...images.map(data => ({ type: 'image', mediaType: 'image/png', data: data.toString('base64') }))])
  assert.equal(prompts[1].sessionId, bound.activeSessionId)
  assert.deepEqual(forks, fork ? [parent] : [])
  ok(await call(reopened, 'launch', { taskId, content: 'text only', expectedRevision: bound.revision, requestId: randomUUID(), includeImages: false, replaceActive: true }))
  assert.deepEqual(prompts[2].content, [{ type: 'text', text: 'text only' }])
})

test('unreadable images and model rejection do not silently launch text-only or strand the task', async context => {
  const attachments = attachmentFixture(), readImage = attachments.readImage
  let attempts = 0
  const sessionController = { async state() { throw Object.assign(new Error(), { code: 'session/not-found' }) }, create: async input => input,
    async prompt({ content }) { attempts++; assert.equal(content[1].type, 'image'); throw Object.assign(new Error(), { code: 'session/attachment-invalid' }) } }
  const host = await mountHost(context, { attachments, sessionController }), taskId = await create(host)
  const { task } = ok(await (await upload(host, taskId, 'upload', Buffer.from([42]))).json())
  attachments.readImage = async () => { throw new Error('Storage offline') }
  const input = { taskId, requestId: 'launch', expectedRevision: task.revision, content: 'Inspect', includeImages: true }
  assert.equal((await call(host, 'launch', input)).error.code, 'tasks/prompt-image-unavailable')
  assert.equal(attempts, 0)
  attachments.readImage = readImage
  assert.equal((await call(host, 'resume-launch', { taskId, requestId: 'launch' })).error.code, 'tasks/prompt-image-rejected')
  assert.equal(attempts, 1)
  const [pending] = ok(await call(host, 'list', {})).tasks
  assert.equal(pending.launch.phase, 'created')
  ok(await call(host, 'abandon-launch', { taskId, requestId: 'launch', expectedRevision: pending.revision }))
})

test('image writes replay durably without reattaching removed images; snapshots never carry references', async context => {
  const attachments = attachmentFixture(), host = await mountHost(context, { attachments })
  const taskId = await create(host), otherId = await create(host), bytes = Buffer.from([42, 12, 70])
  const observed = [], off = await host.ctx.taskService.watch(event => observed.push(event))
  const first = ok(await (await upload(host, taskId, 'new-image', bytes)).json()).task
  assert.equal(first.imageCount, 1)
  assert.equal(ok(await (await upload(host, taskId, 'dupe', bytes)).json()).task.revision, first.revision)
  assert.equal((await (await upload(host, taskId, 'new-image', Buffer.from([42, 1]))).json()).error.code, 'tasks/request-conflict')
  const gallery = ok(await call(host, 'images', { taskId })), [ref] = gallery.images
  assert.deepEqual(Object.keys(ref).sort(), ['attachmentId', 'bytes', 'height', 'mediaType', 'width'])
  assert.deepEqual(gallery.limits, { mediaTypes: ['image/png', 'image/jpeg'], maxImageBytes: 128, maxImages: 10 })
  const read = id => host.fetchAuthenticated(path + query({ taskId: id, attachmentId: ref.attachmentId }))
  const response = await read(taskId)
  assert.equal(response.headers.get('Content-Type'), 'image/png')
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes)
  assert.equal((await read(otherId)).status, 404)
  assert.equal((await fetch(host.origin + path)).status, 401)
  assert.equal((await host.fetchAuthenticated(path, { headers: { origin: 'https://untrusted.example' } })).status, 403)
  const removal = { taskId, requestId: 'detach', expectedRevision: gallery.revision, attachmentId: ref.attachmentId }
  assert.equal((await call(host, 'remove-image', { ...removal, expectedRevision: 1 })).error.code, 'tasks/revision-conflict')
  ok(await call(host, 'remove-image', removal))
  assert.equal((await read(taskId)).status, 404)
  assert(!JSON.stringify([...observed, ok(await call(host, 'list', {}))]).includes('sha256:')); off()
  await host.shutdown()
  const reopened = await mountHost(context, { storageRoot: host.storageRoot, attachments })
  assert.equal(ok(await (await upload(reopened, taskId, 'new-image', bytes)).json()).task.imageCount, undefined)
  ok(await (await upload(reopened, taskId, 'reattach', bytes)).json())
  assert.equal(ok(await call(reopened, 'remove-image', removal)).task.imageCount, 1)
  assert.deepEqual(ok(await call(reopened, 'history', { taskId })).events.map(row => row.kind), ['image-added', 'image-removed', 'image-added', 'created'])
  ok(await call(reopened, 'delete', { taskId, expectedRevision: 4 }))
  assert.equal((await reopened.fetchAuthenticated(path + query({ taskId, attachmentId: ref.attachmentId }))).status, 404)
})

test('media, byte and count limits and failed decoding do not alter text or create history', async context => {
  const host = await mountHost(context, { attachments: attachmentFixture() }), taskId = await create(host)
  assert.equal((await upload(host, taskId, 'svg', '<svg/>', 'image/svg+xml')).status, 415)
  assert.equal((await upload(host, taskId, 'oversized', Buffer.alloc(129))).status, 413)
  assert.equal((await (await upload(host, taskId, 'bad', Buffer.from([1]))).json()).error.code, 'tasks/image-save-failed')
  assert.equal(ok(await call(host, 'history', { taskId })).events.length, 1)
  const results = await Promise.all(Array.from({ length: 11 }, async (_, index) => (await upload(host, taskId, String(index), Buffer.from([42, index]))).json()))
  assert.equal(results.filter(row => row.ok).length, 10)
  assert.equal(results.find(row => !row.ok).error.code, 'tasks/image-limit')
  assert.equal(ok(await call(host, 'get', { taskId })).task.imageCount, 10)
  assert.equal((await call(host, 'upload-image', { taskId })).error.code, 'tasks/not-found')
})

test('v7 text records open unchanged without the optional image service', async context => {
  const old = await mountHost(context), taskId = await create(old)
  await old.shutdown()
  const disk = readTaskDatabase(old.storageRoot); disk.unit.version = 7; writeTaskDatabase(old.storageRoot, disk)
  const host = await mountHost(context, { storageRoot: old.storageRoot })
  assert.deepEqual(readTaskDatabase(old.storageRoot).tables, disk.tables)
  assert.deepEqual(ok(await call(host, 'images', { taskId })), { limits: null, images: [], revision: 1 })
  assert.equal((await upload(host, taskId, 'noop', Buffer.from([42]))).status, 503)
  assert.equal(ok(await call(host, 'update', { taskId, requestId: 'edit', expectedRevision: 1, patch: { brief: 'Still editable' } })).task.brief, 'Still editable')
})

test('attachment storage and SQLite interruption never expose a partial task mutation', async context => {
  const attachments = attachmentFixture(), bytes = Buffer.from([42, 99]); let fault
  const host = await mountHost(context, { attachments, wrapUnit: unit => new Proxy(unit, { get(target, key) {
    if (key === 'putRecord') return async (...args) => {
      if (fault === 'reject') throw new Error('simulated disk full')
      await target.putRecord(...args)
      if (fault === 'unknown') throw new StorageError('unknown-state', 'lost SQLite acknowledgement')
    }
    const value = Reflect.get(target, key)
    return typeof value === 'function' ? value.bind(target) : value
  } }) })
  const taskId = await create(host), send = async target => (await upload(target, taskId, 'recover', bytes)).json()
  fault = 'reject'
  assert.equal((await send(host)).error.code, 'tasks/persistence-failed')
  assert.equal(ok(await call(host, 'images', { taskId })).images.length, 0)
  assert.deepEqual(ok(await call(host, 'history', { taskId })).events.map(row => row.kind), ['created'])
  fault = 'unknown'
  assert.equal((await send(host)).error.code, 'tasks/persistence-unknown')
  await host.shutdown()
  const reopened = await mountHost(context, { storageRoot: host.storageRoot, attachments })
  assert.equal(ok(await send(reopened)).task.imageCount, 1)
  assert.deepEqual(ok(await call(reopened, 'history', { taskId })).events.map(row => row.kind), ['image-added', 'created'])
})
