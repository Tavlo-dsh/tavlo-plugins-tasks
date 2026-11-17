import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import vm from 'node:vm'
import { webcrypto } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import * as HostConnection from '@deepseek-ai/dsh-client-connection'
import { installConnection } from '@deepseek-ai/dsh-client-connection/client'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import React from 'react'
import Storage, { storageBackendServiceKey } from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import * as tasksHost from '../index.js'

/** Real published storage plugins; each test gets an isolated JSON root. */
export async function mountStorage(t, { storageRoot, wrapUnit } = {}) {
  const ownsRoot = storageRoot === undefined
  storageRoot ??= await mkdtemp(join(tmpdir(), 'dsh-tasks-tests-'))
  const ctx = new Context()
  const fibers = []
  let disposal
  const own = fiber => { fibers.push(fiber); return fiber }
  const shutdown = () => disposal ??= (async () => {
    for (const fiber of [...fibers].reverse()) await fiber.dispose()
  })()
  t.after(async () => {
    await shutdown()
    if (ownsRoot) {
      const target = resolve(storageRoot)
      assert.equal(dirname(target), resolve(tmpdir()))
      assert(basename(target).startsWith('dsh-tasks-tests-'))
      await rm(target, { recursive: true, force: true })
    }
  })
  await own(ctx.plugin(Storage)).await()
  if (wrapUnit === undefined) {
    await own(ctx.plugin(StorageJson, { root: storageRoot })).await()
  } else {
    const backend = new StorageJson.JsonStorageBackend(storageRoot)
    const routed = { kv: { open: async descriptor => wrapUnit(await backend.kv.open(descriptor)) } }
    await own(ctx.plugin({
      inject: ['storage'],
      apply(ctx) {
        ctx.effect(() => ctx.storage.backend.register('json', routed))
        ctx.provide(storageBackendServiceKey('json'), routed)
        ctx.effect(() => () => backend.close())
      },
    })).await()
  }
  await own(ctx.plugin(StorageDomain, { backend: 'json' })).await()
  return { ctx, storageRoot, own, shutdown }
}

/** Published Connection + WebServer, with real signed cookies and HTTP. */
export async function mountHost(t, options = {}) {
  const storage = await mountStorage(t, options)
  const { ctx, own } = storage
  if (options.workspaces) ctx.provide('workspaceRegistry', { list: options.workspaces })
  if (options.sessionController) ctx.provide('sessionController', options.sessionController)
  else if (options.modelCatalog) ctx.provide('sessionController', { modelCatalog: options.modelCatalog })
  if (options.sessionQuery) ctx.provide('sessionQuery', options.sessionQuery)
  let record
  ctx.provide('credentials', {
    readRecord: async () => record,
    modifyRecord: async (_key, mutate) => { return record = await mutate(record) },
  })
  const web = own(ctx.plugin(WebServer, { host: '127.0.0.1', port: 0 }))
  await web.await()
  const connectionFiber = own(ctx.plugin(HostConnection))
  await connectionFiber.await()
  const plugin = options.activate === false ? undefined : own(ctx.plugin(tasksHost, options.config))
  await plugin?.await()

  const connection = ctx.get('connection')
  const origin = ctx.get('webServer').getOrigin()
  const login = new URL(connection.authenticatedUrl(origin + '/'))
  let cookie
  assert.equal(connection.authorizeIndex({
    method: 'GET', url: login.pathname + login.search, headers: { host: login.host },
  }, {
    writeHead(status, headers) {
      assert.equal(status, 303)
      cookie = headers['set-cookie'].split(';')[0]
    },
    end() {},
  }), false)
  assert.equal(typeof cookie, 'string')

  // Node has no browser cookie jar; attach the actual signed cookie explicitly.
  const fetchAuthenticated = (input, init = {}) => fetch(new URL(input, origin + '/'), {
    ...init, headers: { ...init.headers, cookie },
  })
  const client = new Context()
  const clientConnectionFiber = own(client.plugin({
    apply(ctx) { installConnection(ctx, { transport: { fetch: fetchAuthenticated } }) },
  }))
  await clientConnectionFiber.await()
  return { ...storage, plugin, origin, fetchAuthenticated, rpc: client.get('connection').rpc }
}

/** Execute the shipped browser factory and mount its real Cordis plugin. */
export async function mountClient(t, rpc, { sessionStorage, fetch: fetchEvents, timers, browserEvents, navigate } = {}) {
  sessionStorage ??= memorySessionStorage()
  let definition
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
  const sandbox = {
    AbortController, TextDecoder, console, setTimeout: timers?.setTimeout ?? setTimeout, clearTimeout: timers?.clearTimeout ?? clearTimeout,
    window: { crypto: webcrypto, sessionStorage,
      addEventListener: browserEvents?.addEventListener, removeEventListener: browserEvents?.removeEventListener,
      fetch: fetchEvents ?? ((_url, { signal }) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new Error('RPC-only test transport closed')), { once: true })
      })), __ModuleLoader__: { load(module) {
      assert.equal(module.id, 'dsh-plugin-tasks')
      definition = module.factory(name => {
        assert.equal(name, 'react')
        return React
      })
    } } },
  }
  vm.runInNewContext(source, sandbox, { filename: 'client.js' })
  const ctx = new Context()
  if (navigate) ctx.provide('uiWorkspace', { openSession: navigate })
  const slots = []
  const dictionaries = new Map()
  ctx.provide('locale', {
    register(ns, language, values) {
      const key = ns + '/' + language
      dictionaries.set(key, values)
      return () => { dictionaries.delete(key) }
    },
    bind: ns => key => dictionaries.get(ns + '/zh')[key],
  })
  ctx.provide('slots', {
    inject: (_name, apply) => apply(),
    register(config, component) {
      slots.push({ config, component })
      return () => {}
    },
  })
  const connectionFiber = ctx.plugin({
    apply(ctx) { installConnection(ctx, { transport: { rpc } }) },
  })
  t.after(() => connectionFiber.dispose())
  await connectionFiber.await()
  const plugin = ctx.plugin(definition)
  t.after(() => plugin.dispose())
  await plugin.await()
  const main = slots.find(slot => slot.config.name === 'main')
  assert(main, 'main slot must be registered')
  assert(slots.some(slot => slot.config.name === 'sidebar.panellist'))
  const props = main.config.inject()
  const tasks = props.hooks.tasks
  return {
    plugin, tasks, retry: props.actions.refresh, sessionStorage,
    render: () => expand(main.component({ ...props, useTasks: selector => selector(tasks.getSnapshot()) })),
  }
}

export function memorySessionStorage() {
  const values = new Map()
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  }
}

/** Expand the panel's function components to inspect actual React output. */
function expand(element) {
  if (Array.isArray(element)) return element.flatMap(expand)
  if (!React.isValidElement(element)) return element == null ? [] : [element]
  if (typeof element.type === 'function') return expand(element.type.prototype?.isReactComponent
    ? new element.type(element.props).render() : element.type(element.props))
  return [{ type: element.type, props: element.props }, ...expand(element.props.children)]
}

export async function waitForState(tasks, status) {
  if (tasks.getSnapshot().status === status) return
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`Expected ${status}, got ${tasks.getSnapshot().status}`))
    }, 3000)
    const unsubscribe = tasks.subscribe(() => {
      if (tasks.getSnapshot().status !== status) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
  })
}

export const emptyList = () => ({ ok: true, value: { tasks: [] } })

export const RPC_PATH = '/api/dsh-plugin-tasks/rpc'
export const RPC_ENDPOINT = 'dsh-plugin-tasks/rpc'
export const callTask = (rpc, operation, input, signal) => rpc.call('/api', RPC_ENDPOINT, { operation, input }, signal)
