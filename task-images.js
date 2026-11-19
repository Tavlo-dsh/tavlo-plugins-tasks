import { fileCapacity, imageTypes, maxFileBytes, uploadFile, uploadFileName, uploadImage, uploadMediaType } from './task-schema.js'

const reject = (status, code) => Response.json({ ok: false, error: { code } }, { status })
const safeContentHeaders = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "sandbox; default-src 'none'" }

function imageLimits(store) {
  const limits = store?.imageLimits
  if (!limits || !Array.isArray(limits.mediaTypes) || !Number.isSafeInteger(limits.maxImageBytes) || limits.maxImageBytes < 1 || typeof store.saveImage !== 'function' || typeof store.readImage !== 'function') return null
  const mediaTypes = imageTypes.filter(type => limits.mediaTypes.includes(type))
  return mediaTypes.length ? { mediaTypes, maxImageBytes: Math.min(maxFileBytes, limits.maxImageBytes), maxImages: fileCapacity } : null
}

function canStoreFiles(store) {
  return typeof store?.saveFile === 'function' && typeof store.readFileStream === 'function'
}

export function taskAttachments(resolve) {
  return {
    limits: () => imageLimits(resolve()),
    fileLimits() {
      const store = resolve()
      if (!canStoreFiles(store)) return null
      const images = imageLimits(store)
      return { maxFiles: fileCapacity, maxFileBytes, mediaTypes: images?.mediaTypes ?? [], maxImageBytes: images?.maxImageBytes ?? 0 }
    },
    save: (data, mediaType, name) => resolve().saveImage({ data, mediaType, ...(name ? { name } : {}) }),
    read: (ref, signal) => resolve().readImage(ref, signal),
    // DSH 0.2.2-rc.1 native files preserve exact bytes and have no MIME field or byte cap.
    saveFile: (data, name) => resolve().saveFile({ data, name }),
    async readFile({ attachmentId, bytes, name }, signal) {
      const chunks = []
      let size = 0
      for await (const chunk of resolve().readFileStream({ attachmentId, bytes, name }, signal)) {
        size += chunk.byteLength
        if (size > bytes || size > maxFileBytes) throw new Error('Unexpected file size')
        chunks.push(chunk)
      }
      // Complete the provider's digest verification before exposing any bytes.
      if (size !== bytes) throw new Error('Unexpected file size')
      return Buffer.concat(chunks, size)
    },
  }
}

function attachmentDisposition(name) {
  // A conservative ASCII fallback plus RFC 5987 UTF-8; neither can inject headers.
  const fallback = name.replace(/[^A-Za-z0-9 ._-]/gu, '_')
  const extended = encodeURIComponent(name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16).toUpperCase())
  return `attachment; filename="${fallback}"; filename*=UTF-8''${extended}`
}

export function registerAttachmentRoutes(connection, attachments, store) {
  const path = '/api/dsh-plugin-tasks/image'
  connection.fetch.register({ path, methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    const params = new URL(request.url).searchParams
    const result = await store.execute('images', { taskId: params.get('taskId'),
      ...(params.has('launchRequestId') ? { launchRequestId: params.get('launchRequestId') } : {}) }, request.signal)
    const ref = result.ok && result.value.images.find(image => image.attachmentId === params.get('attachmentId'))
    if (!ref) return reject(404, 'tasks/not-found')
    if (!attachments.limits()) return reject(503, 'tasks/images-unavailable')
    try {
      const { data } = await attachments.read(ref, request.signal)
      return new Response(data, { headers: { ...safeContentHeaders, 'Content-Type': ref.mediaType } })
    } catch { return reject(503, 'tasks/image-read-failed') }
  } })
  connection.fetch.register({ path: path + '/upload', methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    const limits = attachments.limits()
    if (!limits) return reject(503, 'tasks/images-unavailable')
    const mediaType = request.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if (!limits.mediaTypes.includes(mediaType)) return reject(415, 'tasks/invalid-image')
    return acceptUpload(request, store, uploadImage, mediaType, limits.maxImageBytes)
  } })

  const filePath = '/api/dsh-plugin-tasks/file'
  connection.fetch.register({ path: filePath, methods: ['GET'], requestBody: 'buffered', async fetch(request) {
    const params = new URL(request.url).searchParams
    const result = await store.execute('files', { taskId: params.get('taskId') }, request.signal)
    const ref = result.ok && result.value.files.find(file => file.attachmentId === params.get('attachmentId'))
    if (!ref) return reject(404, 'tasks/not-found')
    const image = ref.width !== undefined && ref.height !== undefined
    if (image ? !attachments.limits() : !attachments.fileLimits()) return reject(503, image ? 'tasks/images-unavailable' : 'tasks/files-unavailable')
    try {
      const data = image ? (await attachments.read(ref, request.signal)).data : await attachments.readFile(ref, request.signal)
      const download = !image || params.get('download') === '1'
      const headers = { ...safeContentHeaders, 'Content-Type': image ? ref.mediaType : 'application/octet-stream' }
      if (download) headers['Content-Disposition'] = attachmentDisposition(ref.name ?? `image.${ref.mediaType.split('/')[1]}`)
      return new Response(data, { headers })
    } catch { return reject(503, image ? 'tasks/image-read-failed' : 'tasks/file-read-failed') }
  } })
  connection.fetch.register({ path: filePath + '/upload', methods: ['POST'], requestBody: 'streaming', async fetch(request) {
    const limits = attachments.fileLimits()
    if (!limits) return reject(503, 'tasks/files-unavailable')
    const mediaType = uploadMediaType(request.headers.get('content-type'))
    const image = imageTypes.includes(mediaType)
    if (image && !limits.mediaTypes.includes(mediaType)) return reject(415, 'tasks/invalid-image')
    return acceptUpload(request, store, uploadFile, mediaType, image ? limits.maxImageBytes : limits.maxFileBytes)
  } })
}

async function acceptUpload(request, store, operation, mediaType, maxBytes) {
  const legacy = operation === uploadImage
  const image = imageTypes.includes(mediaType)
  const code = image ? 'tasks/invalid-image' : 'tasks/invalid-file'
  const reader = request.body?.getReader()
  if (!reader && image) return reject(400, code)
  const chunks = []
  let size = 0, expired = false
  if (reader) {
    const timeout = setTimeout(() => { expired = true; void reader.cancel().catch(() => {}) }, 30000)
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size <= maxBytes) chunks.push(value)
        else if (legacy) chunks.length = 0
        // The Host bridge closes unread bodies after sending the response.
        else return reject(413, code)
      }
    } catch { return reject(expired ? 408 : 400, expired ? 'tasks/upload-timeout' : code) }
    finally { clearTimeout(timeout); reader.releaseLock() }
  }
  if (expired) return reject(408, 'tasks/upload-timeout')
  if (size > maxBytes) return reject(413, code)
  const params = new URL(request.url).searchParams
  return Response.json(await store.execute(operation, { taskId: params.get('taskId'), requestId: params.get('requestId'), mediaType,
    data: Buffer.concat(chunks, size), ...(legacy ? {} : { name: uploadFileName(params.get('name')) }) }, request.signal, 'rpc'))
}
