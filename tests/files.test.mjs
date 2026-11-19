import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { callTask, mountHost, readTaskDatabase } from './fixtures.mjs'

const path = '/api/dsh-plugin-tasks/file'
const imagePath = '/api/dsh-plugin-tasks/image'
const MiB = 1024 * 1024
const idFor = data => 'sha256:' + createHash('sha256').update(data).digest('hex')
const ok = result => { assert(result.ok, JSON.stringify(result)); return result.value }
const call = (host, op, input) => callTask(host.rpc, op, input)
const create = async host => ok(await call(host, 'create', { requestId: randomUUID(), title: 'Attachment owner' })).task
const url = (base, params) => base + '?' + new URLSearchParams(params)
const upload = (host, taskId, requestId, body, mediaType, name = 'example.txt', base = path) => host.fetchAuthenticated(
  url(base + '/upload', { taskId, requestId, name }), { method: 'POST', body, ...(mediaType ? { headers: { 'Content-Type': mediaType } } : {}) })
const download = (host, taskId, attachmentId, params = {}) => host.fetchAuthenticated(url(path, { taskId, attachmentId, ...params }))
const asBytes = async response => Buffer.from(await response.arrayBuffer())

/** Match the installed DSH API: exact-byte files with a named alias and verified streamed reads. */
function attachmentFixture() {
  const files = new Map(), images = new Map()
  const counters = { savedFiles: 0, readFiles: 0, savedImages: 0 }
  return { counters, files, imageLimits: { maxImageBytes: 128, maxImagesPerMessage: 8, maxMessageImageBytes: 512, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    async saveFile(input) {
      assert.deepEqual(Object.keys(input).sort(), ['data', 'name'])
      const { data, name } = input
      const ref = { attachmentId: idFor(data), bytes: data.byteLength, name }
      files.set(`${ref.attachmentId}/${name}`, Buffer.from(data))
      counters.savedFiles++
      return ref
    },
    async *readFileStream(ref, signal) {
      assert.deepEqual(Object.keys(ref).sort(), ['attachmentId', 'bytes', 'name'])
      signal?.throwIfAborted()
      const data = files.get(`${ref.attachmentId}/${ref.name}`)
      counters.readFiles++
      if (!data) throw new Error('Object missing')
      yield data.subarray(0, 3)
      yield data.subarray(3)
      if (idFor(data) !== ref.attachmentId || data.length !== ref.bytes) throw new Error('Integrity check failed')
    },
    async saveImage({ data, mediaType, name }) {
      if (data[0] !== 42) throw new Error('Decoder rejected data')
      const ref = { attachmentId: idFor(data), mediaType, bytes: data.byteLength, width: 4, height: 3, name }
      images.set(ref.attachmentId, Buffer.from(data))
      counters.savedImages++
      return ref
    },
    async readImage(ref) { return { data: images.get(ref.attachmentId), ref } },
  }
}

test('file route enforces owner access, safe download and membership; file mutations replay after reopening', async t => {
  const attachments = attachmentFixture(), host = await mountHost(t, { attachments })
  const { id: taskId } = await create(host), { id: otherId } = await create(host)
  const bytes = Buffer.from('<script>alert(1)</script>'), filename = 'résumé _.html', requestId = 'html-upload'
  const sourceName = 'C:\\Users\\me\\résumé "\r\n.html'
  const uploadUrl = url(path + '/upload', { taskId, requestId, name: sourceName })
  assert.equal((await fetch(host.origin + uploadUrl, { method: 'POST', body: bytes })).status, 401)
  assert.equal((await host.fetchAuthenticated(uploadUrl, { method: 'POST', body: bytes, headers: { origin: 'https://untrusted.example' } })).status, 403)
  const events = [], off = await host.ctx.taskService.watch(event => events.push(event))
  const response = await upload(host, taskId, requestId, bytes, 'Text/HTML; charset=utf-8', sourceName)
  assert.equal(response.status, 200)
  const result = await response.json(), { task } = ok(result)
  assert.equal(typeof result.streamId, 'string')
  assert.equal(typeof result.sequence, 'number')
  assert.equal(task.fileCount, 1)
  assert.equal(task.imageCount, undefined)
  assert.equal(task.revision, 2)
  const ref = { attachmentId: idFor(bytes), bytes: bytes.length, name: filename, mediaType: 'text/html' }
  const list = ok(await call(host, 'files', { taskId }))
  assert.deepEqual(list, { files: [ref], limits: { maxFiles: 10, maxFileBytes: 10 * MiB,
    mediaTypes: ['image/png', 'image/jpeg', 'image/webp'], maxImageBytes: 128 }, revision: 2 })
  assert.deepEqual(ok(await call(host, 'files', {})), { files: [], limits: list.limits })
  assert.equal(ok(await call(host, 'capabilities', {})).features.taskFiles, true)
  assert.deepEqual(ok(await call(host, 'images', { taskId })).images, [])
  assert(!JSON.stringify(events).includes(ref.attachmentId)); off()
  const fileUrl = url(path, { taskId, attachmentId: ref.attachmentId })
  assert.equal((await fetch(host.origin + fileUrl)).status, 401)
  assert.equal((await host.fetchAuthenticated(fileUrl, { headers: { origin: 'https://untrusted.example' } })).status, 403)
  assert.equal((await download(host, otherId, ref.attachmentId)).status, 404)
  assert.equal((await host.fetchAuthenticated(url(imagePath, { taskId, attachmentId: ref.attachmentId }))).status, 404)
  assert.equal(attachments.counters.readFiles, 0)
  const downloaded = await download(host, taskId, ref.attachmentId, { download: 0 })
  assert.equal(downloaded.status, 200)
  assert.equal(downloaded.headers.get('content-type'), 'application/octet-stream')
  assert.equal(downloaded.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(downloaded.headers.get('cache-control'), 'private, no-store')
  assert.equal(downloaded.headers.get('content-security-policy'), "sandbox; default-src 'none'")
  assert.equal(downloaded.headers.get('content-disposition'), `attachment; filename="r_sum_ _.html"; filename*=UTF-8''r%C3%A9sum%C3%A9%20_.html`)
  assert.deepEqual(await asBytes(downloaded), bytes)
  attachments.files.set(`${ref.attachmentId}/${ref.name}`, Buffer.alloc(bytes.length))
  assert.equal((await download(host, taskId, ref.attachmentId)).status, 503)
  attachments.files.set(`${ref.attachmentId}/${ref.name}`, bytes)

  assert.equal(ok(await (await upload(host, taskId, requestId, bytes, 'text/html', sourceName)).json()).task.revision, 2)
  assert.equal((await (await upload(host, taskId, requestId, bytes, 'text/html', 'changed.html')).json()).error.code, 'tasks/request-conflict')
  assert.equal((await (await upload(host, taskId, requestId, bytes, 'text/plain', sourceName)).json()).error.code, 'tasks/request-conflict')
  assert.equal((await (await upload(host, taskId, requestId, Buffer.from('other'), 'text/html', sourceName)).json()).error.code, 'tasks/request-conflict')
  assert.equal(attachments.counters.savedFiles, 1)
  const removal = { taskId, attachmentId: ref.attachmentId, requestId: 'detach-file', expectedRevision: 2 }
  assert.equal(ok(await call(host, 'remove-image', { ...removal, requestId: 'legacy-remove-noop' })).task.fileCount, 1)
  assert.equal((await call(host, 'remove-file', { ...removal, expectedRevision: 1 })).error.code, 'tasks/revision-conflict')
  assert.equal(ok(await call(host, 'remove-file', removal)).task.fileCount, undefined)
  assert.equal((await download(host, taskId, ref.attachmentId)).status, 404)
  await host.shutdown()

  const reopened = await mountHost(t, { storageRoot: host.storageRoot, attachments })
  assert.equal(ok(await (await upload(reopened, taskId, requestId, bytes, 'text/html', sourceName)).json()).task.fileCount, undefined)
  assert.equal(attachments.counters.savedFiles, 1)
  const reattached = ok(await (await upload(reopened, taskId, 'reattached', bytes, 'text/html', sourceName)).json()).task
  assert.equal(reattached.fileCount, 1)
  assert.equal(ok(await call(reopened, 'remove-file', removal)).task.revision, reattached.revision)
  assert.deepEqual(await asBytes(await download(reopened, taskId, ref.attachmentId)), bytes)
  const history = ok(await call(reopened, 'history', { taskId })).events.map(({ kind, name }) => [kind, name])
  assert.deepEqual(history, [['file-added', filename], ['file-removed', filename], ['file-added', filename], ['created', undefined]])
  ok(await call(reopened, 'delete', { taskId, expectedRevision: reattached.revision }))
  assert.equal((await download(reopened, taskId, ref.attachmentId)).status, 404)
})

test('mixed attachments share the count cap while legacy and generalized image operations remain compatible', async t => {
  const attachments = attachmentFixture(), host = await mountHost(t, { attachments }), taskId = (await create(host)).id
  const legacy = Buffer.from([42, 1]), modern = Buffer.from([42, 2])
  ok(await (await upload(host, taskId, 'legacy', legacy, 'image/png', 'ignored.png', imagePath)).json())
  ok(await (await upload(host, taskId, 'modern', modern, 'image/png', 'modern.png')).json())
  const gallery = ok(await call(host, 'images', { taskId }))
  assert.deepEqual(gallery.images, [
    { attachmentId: idFor(legacy), bytes: 2, mediaType: 'image/png', width: 4, height: 3 },
    { attachmentId: idFor(modern), bytes: 2, mediaType: 'image/png', width: 4, height: 3, name: 'modern.png' },
  ])
  const legacyPreview = await download(host, taskId, idFor(legacy))
  assert.equal(legacyPreview.headers.get('content-disposition'), null)
  assert.equal(legacyPreview.headers.get('content-type'), 'image/png')
  assert.deepEqual(await asBytes(legacyPreview), legacy)
  const modernDownload = await download(host, taskId, idFor(modern), { download: 1 })
  assert.match(modernDownload.headers.get('content-disposition'), /^attachment; filename="modern\.png"/)
  assert.deepEqual(await asBytes(modernDownload), modern)
  assert.deepEqual(await asBytes(await host.fetchAuthenticated(url(imagePath, { taskId, attachmentId: idFor(modern) }))), modern)
  assert.equal((await upload(host, taskId, 'image-size', Buffer.alloc(129, 42), 'image/png')).status, 413)
  assert.equal((await (await upload(host, taskId, 'bad-image', Buffer.from('bogus'), 'image/png')).json()).error.code, 'tasks/image-save-failed')
  assert.equal((await upload(host, taskId, 'file-size', Buffer.alloc(10 * MiB + 1))).status, 413)
  const raw = ok(await (await upload(host, taskId, 'empty', Buffer.alloc(0), undefined, 'empty.bin')).json()).task
  assert.equal(raw.fileCount, 3)
  const empty = ok(await call(host, 'files', { taskId })).files.find(row => row.bytes === 0)
  assert.equal(empty.mediaType, 'application/octet-stream')
  assert.deepEqual(await asBytes(await download(host, taskId, empty.attachmentId)), Buffer.alloc(0))
  const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => (await upload(host, taskId,
    `concurrent-${index}`, Buffer.from([index]), 'text/plain')).json()))
  assert.equal(results.filter(row => row.ok).length, 7)
  assert.ok(results.some(row => !row.ok && row.error.code === 'tasks/file-limit'))
  const over = await (await upload(host, taskId, 'full', Buffer.from([42, 3]), 'image/png', '', imagePath)).json()
  assert.equal(over.error.code, 'tasks/image-limit')
  const { files, revision } = ok(await call(host, 'files', { taskId }))
  assert.equal(files.length, 10)
  assert.deepEqual(files.filter(file => file.width !== undefined), gallery.images)
  const removed = ok(await call(host, 'remove-file', { taskId, requestId: 'detach-image', attachmentId: idFor(legacy), expectedRevision: revision })).task
  assert.equal(removed.fileCount, 9)
  assert.equal(removed.imageCount, 1)
  assert.deepEqual(ok(await call(host, 'images', { taskId })).images, gallery.images.slice(1))
  assert.equal((await download(host, taskId, idFor(legacy))).status, 404)
  const history = ok(await call(host, 'history', { taskId })).events
  assert.equal(history[0].kind, 'file-removed')
  assert.equal(history.at(-2).kind, 'image-added')
})

test('only validated raster images are frozen into a pending launch; active files never enter the prompt', async t => {
  const attachments = attachmentFixture(), prompts = []
  const sessionController = {
    async state() { throw Object.assign(new Error(), { code: 'session/not-found' }) },
    async create(input) { return input },
    async prompt(input) { prompts.push(input); if (prompts.length === 1) throw new Error('Lost response') },
  }
  const host = await mountHost(t, { attachments, sessionController }), taskId = (await create(host)).id
  const raster = Buffer.from([42, 27]), svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>')
  ok(await (await upload(host, taskId, 'svg', svg, 'image/svg+xml', 'graphic.svg')).json())
  const { task } = ok(await (await upload(host, taskId, 'png', raster, 'image/png', 'graphic.png')).json())
  const input = { taskId, expectedRevision: task.revision, requestId: 'launch', includeImages: true, content: 'Review' }
  assert.equal((await call(host, 'launch', input)).error.code, 'tasks/launch-failed')
  const frozen = ok(await call(host, 'images', { taskId, launchRequestId: input.requestId }))
  assert.equal(frozen.images.length, 1)
  assert.equal(frozen.images[0].attachmentId, idFor(raster))
  const storage = readTaskDatabase(host.storageRoot).tables.tasks[taskId]
  assert(!JSON.stringify(storage._launches).includes(idFor(svg)))
  ok(await call(host, 'remove-file', { taskId, requestId: 'remove-raster', attachmentId: idFor(raster), expectedRevision: frozen.revision }))
  const activeFile = await download(host, taskId, idFor(svg))
  assert.match(activeFile.headers.get('content-disposition'), /^attachment;/)
  await host.shutdown()
  const reopened = await mountHost(t, { storageRoot: host.storageRoot, attachments, sessionController })
  ok(await call(reopened, 'resume-launch', { taskId, requestId: input.requestId }))
  assert.deepEqual(prompts[1], prompts[0])
  assert.deepEqual(prompts[1].content, [{ type: 'text', text: 'Review' }, { type: 'image', mediaType: 'image/png', data: raster.toString('base64') }])
  assert.equal((await download(reopened, taskId, idFor(raster))).status, 404)
})

test('general capability is optional and persisted refs stay visible and removable when the file provider is absent', async t => {
  const host = await mountHost(t, { attachments: attachmentFixture() }), taskId = (await create(host)).id
  const data = Buffer.from('keep the reference')
  ok(await (await upload(host, taskId, 'bytes', data)).json())
  await host.shutdown()
  const reopened = await mountHost(t, { storageRoot: host.storageRoot })
  const gallery = ok(await call(reopened, 'files', { taskId }))
  assert.equal(gallery.limits, null)
  assert.equal(gallery.files.length, 1)
  assert.equal(ok(await call(reopened, 'capabilities', {})).features.taskFiles, false)
  assert.equal((await download(reopened, taskId, idFor(data))).status, 503)
  assert.equal((await upload(reopened, taskId, 'unavailable', data)).status, 503)
  const result = ok(await call(reopened, 'remove-file', { taskId, requestId: 'unlink', attachmentId: idFor(data), expectedRevision: gallery.revision }))
  assert.equal(result.task.fileCount, undefined)
})
