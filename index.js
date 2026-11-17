/**
 * Task board Host half.
 *
 * Provides authenticated durable task operations and a shared SSE change feed.
 */

import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection'
import s from '@deepseek-ai/schemastery'
import { taskDomain } from './task-schema.js'
import { createTaskStore } from './task-store.js'
import { createTaskOptions } from './task-options.js'
import { createTaskEvents } from './task-events.js'
import { createTaskSessions } from './task-sessions.js'

/** Loader row id this bundle inserts. */
export const name = 'tavlo-tasks'

/** Connection mounts the authenticated shared API on the Web carrier. */
export const inject = ['connection', 'webServer', 'storageDomain']

/** Limits apply to new requests; lowering them does not invalidate saved tasks. */
export const Config = s.object({
  maxTitleLength: s.natural().min(1).default(200),
  maxBriefLength: s.natural().min(1).default(20000),
  maxTasks: s.natural().min(1).default(10000),
  maxLaunchesPerTask: s.natural().min(1).default(1000),
  statusRefreshMs: s.natural().min(500).max(60000).default(2000),
  eventBufferBytes: s.natural().min(65536).max(268435456).default(33554432),
  eventHeartbeatMs: s.natural().min(1000).max(60000).default(15000),
})

const RPC_ENDPOINT = 'dsh-plugin-tasks/rpc'

/** Adapt Connection's public RPC envelope to one exact owner-only Fetch route. */
async function fetchTasksRpc(request, store, options) {
  const mediaType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase()
  if (mediaType !== 'application/json') {
    return new Response('content type must be application/json', { status: 415 })
  }
  let body
  try {
    body = await request.json()
  } catch {
    return new Response('body is not JSON', { status: 400 })
  }
  const parsed = clientRequestSchema.safeParse(body)
  const rpcId = parsed.success ? parsed.data.rpcId
    : typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request'
  let result
  if (!parsed.success || parsed.data.method !== RPC_ENDPOINT) {
    result = {
      ok: false,
      error: { code: 'gateway/bad-request', message: 'Invalid task RPC envelope', details: {} },
    }
  } else {
    const payload = parsed.data.payload
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).length !== 2 || typeof payload.operation !== 'string'
      || !Object.hasOwn(payload, 'input')) {
      result = {
        ok: false,
        error: { code: 'tasks/bad-request', message: 'Expected { operation, input }', details: {} },
      }
    } else if (payload.operation === 'options') {
      result = Object.keys(payload.input ?? {}).length === 0 && payload.input !== null
        && typeof payload.input === 'object' && !Array.isArray(payload.input)
        ? { ok: true, value: await options.list() }
        : { ok: false, error: { code: 'tasks/bad-request', message: 'Expected empty options input', details: {} } }
    } else {
      result = await store.execute(payload.operation, payload.input, request.signal)
    }
  }
  return Response.json({ type: 'server-response', rpcId, result })
}

/**
 * Activate the plugin row.
 * @param ctx - fiber context of the `tavlo-tasks` loader entry.
 * @param config - resolved limits.
 * @returns readiness after storage validation and route registration.
 */
export async function apply(ctx, config) {
  let store
  const options = createTaskOptions(ctx)
  const sessions = createTaskSessions(ctx)
  await ctx.effect(async () => {
    const domain = await ctx.storageDomain.open(taskDomain)
    try {
      store = createTaskStore(domain, config, error => { ctx.logger.error(error) }, options, sessions)
    } catch (error) {
      await domain.close()
      throw error
    }
    return () => store.close()
  }, 'tavlo-tasks: task storage')
  await ctx.effect(async () => {
    const dispose = await sessions.watch(store, config.statusRefreshMs)
    return () => { dispose(); sessions.close() }
  }, 'tavlo-tasks: session status')
  // Direct rpc.handle() fails under sibling WebServer providers in 0.2.2-rc.1.
  // Exact Fetch routes precede the Gateway interceptor and enforce owner access.
  // Connection scopes this registration and its cleanup to the caller's fiber.
  ctx.connection.fetch.register({
    path: '/api/' + RPC_ENDPOINT,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: request => fetchTasksRpc(request, store, options),
  })
  const events = createTaskEvents(store, config)
  ctx.effect(() => () => events.close(), 'tavlo-tasks: task event streams')
  ctx.connection.fetch.register({
    path: '/api/dsh-plugin-tasks/events',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: request => events.open(request),
  })
  const logger = ctx.get('logger')
  logger?.info?.('tavlo-tasks: persistent task RPC and events ready')
}
