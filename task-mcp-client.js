/** Independent API authentication for stdio MCP clients; never reads a browser cookie jar. */
import { randomUUID } from 'node:crypto'
import WebSocket from 'ws'

export async function connectTaskHost(baseUrl, token) {
  const base = new URL(baseUrl)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('DSH_TASKS_URL must be a plain HTTP(S) Host base URL without credentials, query or fragment')
  }
  if (!base.pathname.endsWith('/')) base.pathname += '/'
  if (!token) throw new Error('Set DSH_TASKS_TOKEN to the current Host launch token')
  const connectUrl = new URL('connect', base)
  connectUrl.searchParams.set('token', token)
  connectUrl.searchParams.set('interactions', 'none')
  const response = await fetch(connectUrl, { redirect: 'manual', signal: AbortSignal.timeout(10000) })
  await response.body?.cancel()
  const cookie = response.headers.get('set-cookie')?.split(';')[0]
  const location = response.headers.get('location')
  if (response.status !== 302 || !cookie || !location) throw new Error(`Host API authentication failed (HTTP ${response.status})`)
  const socketUrl = new URL(location, connectUrl)
  if (socketUrl.origin !== base.origin || socketUrl.username || socketUrl.password) throw new Error('Host returned an invalid API connection destination')
  socketUrl.protocol = socketUrl.protocol === 'https:' ? 'wss:' : 'ws:'
  const socket = new WebSocket(socketUrl, { headers: { cookie }, handshakeTimeout: 10000, followRedirects: false })
  // Keep the API peer owned by this socket; the Host revokes it when the bridge exits.
  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', () => reject(new Error('Host API WebSocket connection failed; check that the Gateway is enabled')))
  })
  // The socket owns only lifetime. Task operations use authenticated HTTP.
  socket.on('error', () => {})
  return {
    async execute(operation, input, signal) {
      if (socket.readyState !== WebSocket.OPEN) return unavailable('Host connection closed; restart the MCP bridge')
      try {
        const rpcId = randomUUID()
        const response = await fetch(new URL('api/dsh-plugin-tasks/rpc', base), {
          method: 'POST', redirect: 'error', headers: { cookie, 'content-type': 'application/json' },
          signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
          body: JSON.stringify({ type: 'client-request', rpcId, method: 'dsh-plugin-tasks/rpc', payload: { operation, input } }),
        })
        if (!response.ok) {
          await response.body?.cancel()
          return unavailable(`Host task endpoint returned HTTP ${response.status}`)
        }
        const body = await response.json()
        if (body.type !== 'server-response' || body.rpcId !== rpcId || typeof body.result?.ok !== 'boolean') throw new Error('Invalid RPC response')
        return body.result
      } catch {
        return { ok: false, error: { code: 'tasks/transport-unknown',
          message: 'No confirmed Host result. A write may have committed. For requestId writes, reuse the original input. For revision-only writes, re-read the task or board before retrying.', details: {} } }
      }
    },
    close() {
      if (socket.readyState === WebSocket.CLOSED) return Promise.resolve()
      return new Promise(resolve => {
        const timer = setTimeout(() => socket.terminate(), 1000)
        socket.once('close', () => { clearTimeout(timer); resolve() })
        socket.close()
      })
    },
  }
}

function unavailable(message) {
  return { ok: false, error: { code: 'tasks/unavailable', message, details: {} } }
}
