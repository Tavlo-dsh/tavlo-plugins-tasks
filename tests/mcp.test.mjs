import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer, request } from 'node:http'
import { Service } from '@deepseek-ai/cordis'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WebSocketServer } from 'ws'
import { callTask, mountHost, readTaskDatabase } from './fixtures.mjs'

const path = '/api/dsh-plugin-tasks/mcp'
const value = result => { assert(!result.isError, JSON.stringify(result)); return result.structuredContent.value }
async function connect(host) {
  const client = new Client({ name: 'tasks-test-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(path, host.origin), { fetch: host.fetchAuthenticated }))
  return client
}

test('standard MCP HTTP initialize/list/call shares tasks with Host service and persists retries', async t => {
  const host = await mountHost(t)
  const client = await connect(host)
  try {
    const tools = await client.listTools()
    assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['tasks_capabilities', 'tasks_options', 'tasks_list', 'tasks_get', 'tasks_create', 'tasks_update', 'tasks_set_stage', 'tasks_board', 'tasks_edit_labels', 'tasks_edit_priorities', 'tasks_history', 'tasks_move', 'tasks_comment'].sort())
    assert(!tools.tools.some(tool => /launch|delete/.test(tool.name)))
    const schema = name => tools.tools.find(tool => tool.name === name).inputSchema
    for (const field of ['labelId', 'priority', 'dueDate']) assert(schema('tasks_create').properties[field].description)
    assert.deepEqual(schema('tasks_edit_labels').properties.action.enum, ['add', 'edit', 'remove'])
    assert.deepEqual(schema('tasks_edit_priorities').properties.action.enum, ['add', 'edit', 'remove', 'reorder'])
    const capabilities = value(await client.callTool({ name: 'tasks_capabilities', arguments: {} }))
    assert.equal(capabilities.contractVersion, 1)
    const input = { requestId: 'mcp-create', title: 'Agent created task', brief: 'A real MCP call' }
    const task = value(await client.callTool({ name: 'tasks_create', arguments: input })).task
    assert(!task.activeSessionId)
    assert.deepEqual((await callTask(host.rpc, 'get', { taskId: task.id })).value.task, task)
    assert.equal(value(await client.callTool({ name: 'tasks_create', arguments: input })).task.id, task.id)
    const update = { requestId: 'mcp-update', taskId: task.id, expectedRevision: 1, patch: { title: 'Updated via MCP' } }
    const changed = value(await client.callTool({ name: 'tasks_update', arguments: update })).task
    assert.equal(changed.revision, 2)
    assert.equal(value(await client.callTool({ name: 'tasks_update', arguments: update })).mutation.replayed, true)
    const conflict = await client.callTool({ name: 'tasks_update', arguments: { ...update, requestId: 'new-request' } })
    assert.equal(conflict.isError, true)
    assert.equal(conflict.structuredContent.error.code, 'tasks/revision-conflict')
    assert(!JSON.stringify(changed).includes('_updates'))
    assert.equal(value(await client.callTool({ name: 'tasks_list', arguments: {} })).total, 1)
    assert.equal(readTaskDatabase(host.storageRoot).tables.tasks[task.id].title, changed.title)
    const board = value(await client.callTool({ name: 'tasks_board', arguments: {} })).board
    value(await client.callTool({ name: 'tasks_move', arguments: { taskId: task.id, expectedRevision: 2, columnId: board.columns[1].id } }))
    value(await client.callTool({ name: 'tasks_comment', arguments: { taskId: task.id, requestId: 'handover', text: 'Ready to verify' } }))
    const events = value(await client.callTool({ name: 'tasks_history', arguments: { taskId: task.id } })).events
    assert.deepEqual(events.map(event => event.kind), ['comment', 'moved', 'updated', 'created'])
    assert(events.every(event => event.source === 'agent'))
  } finally { await client.close() }
})

test('MCP manages board metadata and assigns label, priority and due date to a task', async t => {
  const host = await mountHost(t)
  const client = await connect(host)
  const call = (name, args = {}) => client.callTool({ name: 'tasks_' + name, arguments: args })
  const error = async (name, args, code) => {
    const result = await call(name, args)
    assert.equal(result.isError, true)
    assert.equal(result.structuredContent.error.code, code)
  }
  try {
    const column = (await callTask(host.rpc, 'edit-columns', { action: 'add', expectedRevision: 1, stage: 'doing', name: 'Review' })).value.board.columns.at(-1)
    let { board } = value(await call('board'))
    assert.deepEqual(board.priorities.map(row => row.key), ['P0', 'P1', 'P2'])
    const label = { name: 'Release', color: '#123abc' }
    await error('edit_labels', { action: 'add', expectedRevision: board.revision, name: label.name }, 'tasks/bad-request')
    ;({ board } = value(await call('edit_labels', { action: 'add', expectedRevision: board.revision, ...label })))
    const labelId = board.labels[0].id
    await error('edit_priorities', { action: 'add', expectedRevision: board.revision - 1, key: 'blocked', name: 'Release blocker' }, 'tasks/revision-conflict')
    ;({ board } = value(await call('edit_priorities', { action: 'add', expectedRevision: board.revision, key: 'blocked', name: 'Release blocker' })))
    const input = { requestId: 'release-task', title: 'Prepare release', labelId, priority: 'blocked', dueDate: '2028-02-29', columnId: column.id }
    const { task } = value(await call('create', input))
    assert.equal(task.stage, 'doing', 'stage must be inferred from columnId')
    assert.deepEqual(value(await call('list', { labelId, priority: input.priority, dueDate: input.dueDate })).tasks, [task])
    assert.deepEqual(value(await call('list', { due: 'today', today: input.dueDate })).tasks, [task])
    assert.equal(task.labelId, labelId)
    assert.equal(task.priority, input.priority)
    assert.equal(task.dueDate, input.dueDate)
    assert.deepEqual((await callTask(host.rpc, 'get', { taskId: task.id })).value.task, task)
    await error('edit_labels', { action: 'remove', expectedRevision: board.revision, labelId }, 'tasks/label-in-use')
    await error('edit_priorities', { action: 'remove', expectedRevision: board.revision, key: input.priority }, 'tasks/priority-in-use')
    ;({ board } = value(await call('edit_labels', { action: 'edit', expectedRevision: board.revision, labelId, name: 'QA', color: label.color })))
    ;({ board } = value(await call('edit_priorities', { action: 'edit', expectedRevision: board.revision, key: input.priority, name: 'Blocker' })))
    ;({ board } = value(await call('edit_priorities', { action: 'reorder', expectedRevision: board.revision, key: input.priority, before: 'P0' })))
    assert.deepEqual(board.priorities[0], { key: 'blocked', name: 'Blocker' })
    assert.equal(value(await call('get', { taskId: task.id })).task.revision, task.revision, 'catalog edits do not rewrite tasks')
    const changed = value(await call('update', { taskId: task.id, expectedRevision: task.revision, requestId: 'release-clear', patch: { labelId: null, priority: null, dueDate: null } })).task
    for (const key of ['labelId', 'priority', 'dueDate']) assert(!Object.hasOwn(changed, key))
    ;({ board } = value(await call('edit_labels', { action: 'remove', expectedRevision: board.revision, labelId })))
    ;({ board } = value(await call('edit_priorities', { action: 'remove', expectedRevision: board.revision, key: input.priority })))
    assert.deepEqual(board.labels, [])
    assert.deepEqual(board.priorities.map(row => row.key), ['P0', 'P1', 'P2'])
    assert.equal(value(await call('create', input)).task.id, task.id, 'original create intent still replays after definitions are removed')
  } finally { await client.close() }
})

test('DSH agents get native tools when the registry is present, without configuring or connecting MCP', async t => {
  const host = await mountHost(t)
  const definitions = new Map()
  class ScopedTools extends Service {
    constructor(ctx) { super(ctx, 'tools') }
    register(definition) {
      return this.ctx.effect(() => {
        assert(!definitions.has(definition.name))
        definitions.set(definition.name, definition)
        return () => { definitions.delete(definition.name) }
      })
    }
  }
  await host.own(host.ctx.plugin(ScopedTools)).await()
  const exec = { signal: new AbortController().signal }
  const tool = definitions.get('tasks_create')
  assert.equal(tool.parameters.properties.dueDate.format, 'date')
  const initial = await definitions.get('tasks_board').execute({}, exec)
  const label = await definitions.get('tasks_edit_labels').execute({ action: 'add', expectedRevision: initial.value.board.revision, name: 'Native', color: '#123abc' }, exec)
  const labelId = label.value.board.labels[0].id
  const result = await tool.execute({ requestId: 'native-task', title: 'From DSH', labelId, priority: 'P1', dueDate: '2028-02-29' }, exec)
  assert(result.ok)
  assert.deepEqual(JSON.parse(tool.output.render({}, result)[0].text), result)
  const client = await connect(host)
  try {
    const tools = (await client.listTools()).tools
    assert.deepEqual([...definitions.keys()].sort(), tools.map(tool => tool.name).sort())
    assert.deepEqual(value(await client.callTool({ name: 'tasks_get', arguments: { taskId: result.value.task.id } })).task, result.value.task)
    assert.equal(value(await client.callTool({ name: 'tasks_history', arguments: { taskId: result.value.task.id } })).events[0].source, 'agent')
  } finally { await client.close() }
  await host.plugin.dispose()
  assert.equal(definitions.size, 0)
  const disabled = await mountHost(t, { config: { mcpEnabled: false } })
  await disabled.own(disabled.ctx.plugin(ScopedTools)).await()
  assert.equal(definitions.size, 0)
})

test('MCP retains owner and Origin fences, supports disabling, and removes its route on unload', async t => {
  const host = await mountHost(t)
  assert.equal((await fetch(new URL(path, host.origin), { method: 'POST' })).status, 401)
  assert.equal((await host.fetchAuthenticated(path, { method: 'POST', headers: { origin: 'https://evil.example' } })).status, 403)
  const connection = host.ctx.get('connection')
  const guest = connection.createPeer({ principal: { kind: 'guest' } })
  try {
    const response = await connection.createSharedFetchHandler('/api').fetch(new Request(new URL(path, host.origin), { method: 'POST' }), guest)
    assert.equal(response.status, 403)
  } finally { await guest.dispose() }
  assert.equal((await host.fetchAuthenticated(path)).status, 405)
  await host.plugin.dispose()
  assert.equal((await host.fetchAuthenticated(path, { method: 'POST' })).status, 404)
  const disabled = await mountHost(t, { config: { mcpEnabled: false } })
  assert.equal((await disabled.fetchAuthenticated(path, { method: 'POST' })).status, 404)
  assert((await callTask(disabled.rpc, 'list', {})).ok)
})

const manage = (host, action) => callTask(host.rpc, 'mcp-access', { action })
const auth = key => ({ authorization: `Bearer ${key}` })

async function connectLocal({ url, key }) {
  const client = new Client({ name: 'local-mcp-client', version: '1.0.0' })
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: auth(key) } }))
  return client
}

test('local task MCP key is optional, task-only, survives Host restart, and rotates or revokes immediately', async t => {
  const credentialRecords = new Map()
  const first = await mountHost(t, { config: { mcpLocalPort: 0 }, credentialRecords })
  assert.deepEqual((await manage(first, 'status')).value, { enabled: true, active: false })
  assert.equal((await callTask(first.rpc, 'mcp-access', { action: 'generate', key: 'bad' })).error.code, 'tasks/bad-request')
  const connection = first.ctx.get('connection')
  const guest = connection.createPeer({ principal: { kind: 'guest' } })
  const generate = JSON.stringify({ type: 'client-request', rpcId: 'test', method: 'dsh-plugin-tasks/rpc', payload: { operation: 'mcp-access', input: { action: 'generate' } } })
  try {
    const denied = await connection.createSharedFetchHandler('/api').fetch(new Request(new URL('/api/dsh-plugin-tasks/rpc', first.origin), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: generate,
    }), guest)
    assert.equal(denied.status, 403)
  } finally { await guest.dispose() }
  const issued = (await manage(first, 'generate')).value
  assert.match(issued.key, /^dsh_tasks_[A-Za-z0-9_-]{43}$/)
  assert.match(issued.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  assert.deepEqual((await manage(first, 'status')).value, { enabled: true, active: true, url: issued.url })
  const stored = credentialRecords.get('tavlo-tasks/local-mcp')
  assert.equal(stored.kind, 'grant')
  assert.match(stored.payload.digest, /^[a-f0-9]{64}$/)
  assert(!JSON.stringify(stored).includes(issued.key))

  const check = (headers, url = issued.url, body) => fetch(url, { method: 'POST', headers: { connection: 'close', ...headers }, body })
  assert.equal((await check({})).status, 401)
  assert.equal((await check({ ...auth(issued.key), origin: 'http://127.0.0.1' })).status, 403)
  assert.equal((await check({ ...auth(issued.key), 'x-forwarded-for': '198.51.100.1' })).status, 403)
  assert.equal((await check(auth(issued.key), issued.url + '?x=1')).status, 404)
  assert.equal((await check(auth(issued.key), issued.url.replace('/mcp', '/api/dsh-plugin-tasks/rpc'))).status, 404)
  assert.equal((await check(auth(issued.key), new URL('/api/dsh-plugin-tasks/rpc', first.origin), generate)).status, 401)
  assert.equal((await check(auth(issued.key), new URL(path, first.origin))).status, 401)
  // The server rejects the declared size before the client uploads any bytes.
  const oversized = await new Promise((resolve, reject) => {
    const req = request(issued.url, { method: 'POST', headers: { ...auth(issued.key), 'content-type': 'application/json', 'content-length': 1024 * 1024 + 1 } }, res => {
      res.resume(); resolve(res.statusCode)
    })
    req.on('error', reject)
    req.flushHeaders()
  })
  assert.equal(oversized, 413)

  let client = await connectLocal(issued)
  let task
  try {
    assert(!(await client.listTools()).tools.some(tool => /launch|delete|mcp_access/.test(tool.name)))
    task = value(await client.callTool({ name: 'tasks_create', arguments: { title: 'Local connector', requestId: 'local-key' } })).task
    assert.equal((await callTask(first.rpc, 'get', { taskId: task.id })).value.task.title, task.title)
  } finally { await client.close() }
  await first.shutdown()

  const next = await mountHost(t, { storageRoot: first.storageRoot, config: { mcpLocalPort: Number(new URL(issued.url).port) }, credentialRecords })
  assert.deepEqual((await manage(next, 'status')).value, { enabled: true, active: true, url: issued.url })
  client = await connectLocal(issued)
  try {
    assert.equal(value(await client.callTool({ name: 'tasks_get', arguments: { taskId: task.id } })).task.title, task.title)
    const rotated = (await manage(next, 'generate')).value
    assert.notEqual(rotated.key, issued.key)
    assert.equal(rotated.url, issued.url)
    assert.equal((await check(auth(issued.key))).status, 401)
    const replacement = await connectLocal(rotated)
    try { assert.equal(value(await replacement.callTool({ name: 'tasks_list', arguments: {} })).total, 1) }
    finally { await replacement.close() }
    assert.equal((await manage(next, 'revoke')).value.active, false)
    assert.equal((await check(auth(rotated.key))).status, 401)
    assert(!credentialRecords.has('tavlo-tasks/local-mcp'))
  } finally { await client.close() }
})

test('local task MCP does not generate a key when disabled or when its port is occupied', async t => {
  const occupied = createServer()
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => occupied.close(resolve)))
  const credentialRecords = new Map()
  const host = await mountHost(t, { credentialRecords, config: { mcpLocalPort: occupied.address().port } })
  assert.equal((await manage(host, 'generate')).error.code, 'tasks/mcp-listen-failed')
  assert(!credentialRecords.has('tavlo-tasks/local-mcp'))
  assert((await callTask(host.rpc, 'list', {})).ok)
  const disabled = await mountHost(t, { config: { mcpEnabled: false } })
  assert.deepEqual((await manage(disabled, 'status')).value, { enabled: false, active: false })
  assert.equal((await manage(disabled, 'generate')).error.code, 'tasks/mcp-unavailable')
})

test('MCP retries survive lowered title limits and concurrent HTTP clients create one task', async t => {
  const first = await mountHost(t)
  const clients = await Promise.all([connect(first), connect(first)])
  const input = { requestId: 'shared-intent', title: 'Original title' }
  let task
  try {
    const results = await Promise.all(clients.map(client => client.callTool({ name: 'tasks_create', arguments: input })))
    task = value(results[0]).task
    assert.equal(value(results[1]).task.id, task.id)
  } finally { await Promise.all(clients.map(client => client.close())) }
  await first.shutdown()
  const next = await mountHost(t, { storageRoot: first.storageRoot, config: { maxTitleLength: 1 } })
  const client = await connect(next)
  try {
    assert.equal(value(await client.callTool({ name: 'tasks_create', arguments: input })).task.id, task.id)
    const invalid = await client.callTool({ name: 'tasks_create', arguments: { ...input, requestId: 'new' } })
    assert.equal(invalid.isError, true)
    assert.equal(invalid.structuredContent.error.code, 'tasks/bad-request')
  } finally { await client.close() }
  await next.shutdown()
})

test('packaged stdio bridge authenticates its own API peer, creates a task, and releases its socket', async t => {
  const host = await mountHost(t)
  let released = 0
  const socketClosed = Promise.withResolvers()
  const gateway = host.own(host.ctx.plugin({ inject: ['connection', 'webServer'], apply(ctx) {
    const wss = new WebSocketServer({ noServer: true })
    ctx.effect(() => () => { for (const socket of wss.clients) socket.terminate(); wss.close() })
    ctx.effect(() => ctx.webServer.registerUpgrade({ path: '/api/remote.mux', handler(request, socket, head) {
      const admission = ctx.connection.admitConnection(request)
      if ('rejection' in admission) { socket.end(`HTTP/1.1 ${admission.rejection} Rejected\r\n\r\n`); return }
      wss.handleUpgrade(request, socket, head, ws => {
        ws.on('close', async () => { await admission.release(); released++; socketClosed.resolve() })
      })
    } }))
  } }))
  await gateway.await()
  const token = new URL(host.ctx.get('connection').authenticatedUrl(host.origin + '/')).searchParams.get('token')
  const client = new Client({ name: 'stdio-client', version: '1.0.0' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('../bin/tasks-mcp.js', import.meta.url))],
    env: { ...process.env, DSH_TASKS_URL: host.origin, DSH_TASKS_TOKEN: token }, stderr: 'pipe' })
  let diagnostics = ''
  transport.stderr?.on('data', chunk => { diagnostics += chunk })
  try {
    await client.connect(transport)
    const { board } = value(await client.callTool({ name: 'tasks_board', arguments: {} }))
    const key = 'stdio-priority'
    value(await client.callTool({ name: 'tasks_edit_priorities', arguments: { action: 'add', expectedRevision: board.revision, key, name: 'Stdio priority' } }))
    const task = value(await client.callTool({ name: 'tasks_create', arguments: { requestId: 'stdio-intent', title: 'From stdio Agent', priority: key } })).task
    assert.deepEqual((await callTask(host.rpc, 'get', { taskId: task.id })).value.task, task)
    assert(!diagnostics.includes(token))
  } finally { await client.close() }
  await socketClosed.promise
  assert.equal(released, 1)
})
