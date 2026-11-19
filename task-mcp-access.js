import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'

const address = '127.0.0.1'
const path = '/mcp'
const recordKey = 'tavlo-tasks/local-mcp'
const keyPattern = /^Bearer (dsh_tasks_[A-Za-z0-9_-]{43})$/
const maxBodyBytes = 1024 * 1024
const hash = key => createHash('sha256').update(key).digest()
const success = value => ({ ok: true, value })
const failure = (code, message) => ({ ok: false, error: { code, message, details: {} } })

/** Own a separate IPv4 loopback MCP listener and its task-only credential. */
export function createLocalTaskMcpAccess({ credentials, port, open }) {
  const enabled = !!(open && typeof credentials?.readRecord === 'function'
    && typeof credentials.modifyRecord === 'function' && typeof credentials.deleteRecord === 'function')
  let closed = false, server, url
  let queue = Promise.resolve()

  async function digest() {
    const record = await credentials.readRecord(recordKey)
    if (record === undefined) return undefined
    const value = record.payload?.digest
    if (record.kind !== 'grant' || record.payload?.version !== 1
      || typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) throw new Error('Invalid local task MCP credential record')
    return Buffer.from(value, 'hex')
  }

  async function authorized(candidate) {
    if (closed || !candidate) return false
    const current = await digest()
    return !closed && !!current && timingSafeEqual(candidate, current)
  }

  function reject(res, status, headers) {
    res.writeHead(status, { 'cache-control': 'no-store', connection: 'close', ...headers })
    res.end()
  }

  async function serve(req, res) {
    if (req.socket.remoteAddress !== address || !url || req.headers.host !== url.host
      || req.headers.origin !== undefined || req.headers.forwarded !== undefined
      || req.headers['x-forwarded-for'] !== undefined || req.headers['x-forwarded-host'] !== undefined) return reject(res, 403)
    if (req.url !== path) return reject(res, 404)
    if (req.method !== 'POST') return reject(res, 405, { allow: 'POST' })
    const key = keyPattern.exec(req.headers.authorization ?? '')?.[1]
    const candidate = key ? hash(key) : undefined
    if (!(await authorized(candidate))) return reject(res, 401)
    const contentType = req.headers['content-type']
    if (contentType?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return reject(res, 415)
    if (Number(req.headers['content-length']) > maxBodyBytes) return reject(res, 413)
    const abort = new AbortController()
    res.once('close', () => abort.abort())
    const chunks = []
    let size = 0
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length
      if (size > maxBodyBytes) return reject(res, 413)
      chunks.push(chunk)
    }
    if (abort.signal.aborted) return
    // A request that was still uploading when the key changed is not admitted.
    if (!(await authorized(candidate))) return reject(res, 401)
    const headers = {}
    for (const name of ['content-type', 'accept', 'mcp-protocol-version', 'mcp-session-id']) {
      if (typeof req.headers[name] === 'string') headers[name] = req.headers[name]
    }
    const response = await open(new Request(url, { method: 'POST', headers, body: Buffer.concat(chunks, size), signal: abort.signal }))
    const body = Buffer.from(await response.arrayBuffer())
    if (abort.signal.aborted) return
    res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'cache-control': 'no-store' })
    res.end(body)
  }

  async function listen() {
    if (server) return true
    const instance = createServer({ requestTimeout: 10000, headersTimeout: 5000, connectionsCheckingInterval: 1000 }, (req, res) => {
      void serve(req, res).catch(() => {
        if (res.destroyed) return
        if (res.headersSent) res.destroy()
        else reject(res, 503)
      })
    })
    const ready = await new Promise(resolve => {
      instance.once('error', () => resolve(false))
      instance.listen({ host: address, port, exclusive: true }, () => resolve(true))
    })
    if (!ready) return false
    server = instance
    url = new URL(`http://${address}:${instance.address().port}${path}`)
    return true
  }

  function settings(active, listenFailed = false) {
    return { enabled, active, ...(url ? { url: url.href } : {}), ...(listenFailed ? { listenFailed: true } : {}) }
  }

  function manage(input) {
    const action = input?.action
    if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1
      || !['status', 'generate', 'revoke'].includes(action)) {
      return Promise.resolve(failure('tasks/bad-request', 'Invalid MCP access action'))
    }
    const result = queue.then(async () => {
      if (!enabled || closed) return action === 'status' ? success(settings(false))
        : failure('tasks/mcp-unavailable', 'Local task MCP access is unavailable')
      if (action === 'status') {
        const active = !!(await digest())
        return success(settings(active, active && !(await listen())))
      }
      if (action === 'revoke') {
        await credentials.deleteRecord(recordKey)
        return success(settings(false))
      }
      if (!(await listen())) return failure('tasks/mcp-listen-failed', 'Could not open the local task MCP port')
      const key = 'dsh_tasks_' + randomBytes(32).toString('base64url')
      await credentials.modifyRecord(recordKey, async () => ({ kind: 'grant', payload: { version: 1, digest: hash(key).toString('hex') } }))
      return success({ ...settings(true), key })
    }).catch(() => failure('tasks/mcp-unavailable', 'Local task MCP credential storage is unavailable'))
    queue = result.then(() => {})
    return result
  }

  let disposal
  return { manage, close() {
    closed = true
    return disposal ??= queue.then(() => {
      if (!server) return
      return new Promise(resolve => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
    })
  } }
}
