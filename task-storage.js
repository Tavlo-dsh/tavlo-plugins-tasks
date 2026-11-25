/** Task-owned SQLite backend, retaining the Host domain validation and write semantics. */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { SqliteStorageBackend } from '@deepseek-ai/dsh-storage-sqlite'
import { taskDomain, boardTables } from './task-schema.js'
import { fingerprint } from './task-identity.js'
import { validateTaskRecords } from './task-store.js'
import { boardSchema, defaultColumn, initialBoard } from './task-board.js'

export const TASK_SQLITE_BACKEND = 'tavlo-tasks-sqlite'
// Requirements and delivery add optional data without a migration or backfill.
// A version bump would prevent rollback even before any new data is saved. An
// older strict reader will instead refuse rows only after new fields are used.
export const sqliteTaskDomain = { ...taskDomain, tables: boardTables, version: 8, compatibleVersions: [1, 2, 3, 4, 5, 6, 7], global: {
  initial: {},
  schema: z.strictObject({ migration: z.strictObject({
    state: z.enum(['copying', 'complete']), digest: z.string(), count: z.number().int().nonnegative(),
  }).optional(), board: boardSchema.optional(), upgrading: z.string().optional() }),
} }

/** Never change the Host's routes for other plugins or write to the legacy domain. */
export async function openTaskStorage(ctx, config) {
  const resolveHome = ctx.get('dshHomePath') ?? ((...parts) => join(homedir(), '.dsh', ...parts))
  const path = config.databasePath ? resolve(config.databasePath) : resolveHome('storages', 'tasks.sqlite')
  const backend = new SqliteStorageBackend({ path, journalMode: config.sqliteJournalMode ?? 'wal' })
  let unregister
  const facility = new DomainFacility(ctx, { backend: TASK_SQLITE_BACKEND })
  let disposal
  const close = () => disposal ??= (async () => {
    try { await facility.closeAll() }
    finally { unregister?.(); await backend.close() }
  })()
  try {
    unregister = ctx.storage.backend.register(TASK_SQLITE_BACKEND, backend)
    const domain = await facility.open(sqliteTaskDomain)
    if (domain.global.get().migration?.state !== 'complete') {
      await importLegacy(domain, ctx.storageDomain)
    }
    validateTaskRecords(domain.table('tasks').entries())
    await upgradeBoard(domain)
    for (const key of domain.table('activity').keys()) {
      if (domain.table('tasks').get(key.split(':')[0])?._deleted) await domain.table('activity').delete(key)
    }
    return { table: name => domain.table(name), boardGlobal: domain.global, close, path }
  } catch (error) {
    await close()
    throw error
  }
}

async function upgradeBoard(domain) {
  const table = domain.table('tasks'), global = domain.global.get()
  if (!global.board) {
    const records = [...table.entries()].sort(([left], [right]) => left.localeCompare(right))
    const digest = fingerprint(records.map(([id, { columnId, ...record }]) => {
      if (columnId !== undefined && columnId !== defaultColumn(record.stage)) throw new Error('tasks: unexpected column during upgrade')
      return [id, record]
    }))
    if (global.upgrading && global.upgrading !== digest) throw new Error('tasks: interrupted board upgrade differs from baseline')
    if (!global.upgrading) await domain.global.set({ ...global, upgrading: digest })
    for (const [id, record] of records) if (!record._deleted && !record.columnId) await table.put(id, { ...record, columnId: defaultColumn(record.stage) })
    await domain.global.set({ migration: global.migration, board: initialBoard() })
  }
  const columns = new Map(domain.global.get().board.columns.map(column => [column.id, column.stage]))
  for (const [, record] of table.entries()) if (!record._deleted && columns.get(record.columnId) !== record.stage) throw new Error('tasks: invalid task column')
}

/** Interrupted copies are resumable; no service is published before the completion marker. */
async function importLegacy(destination, legacyFacility) {
  const previous = destination.global.get().migration
  const target = destination.table('tasks')
  if (!previous && target.size) throw new Error('tasks: SQLite contains unmarked records; refusing to overwrite them')
  const legacy = await legacyFacility.open(taskDomain)
  try {
    const records = [...legacy.table('tasks').entries()].sort(([a], [b]) => a.localeCompare(b))
    validateTaskRecords(records)
    const digest = fingerprint(records)
    if (previous && (previous.digest !== digest || previous.count !== records.length)) {
      throw new Error('tasks: legacy data changed during an interrupted migration; restore its original snapshot before retrying')
    }
    const source = new Map(records)
    for (const [id, record] of target.entries()) {
      if (!source.has(id) || fingerprint(source.get(id)) !== fingerprint(record)) {
        throw new Error('tasks: partial SQLite migration differs from its source; refusing to overwrite it')
      }
    }
    if (!previous) await destination.global.set({ migration: { state: 'copying', digest, count: records.length } })
    for (const [id, record] of records) {
      if (!target.get(id)) await target.put(id, record)
    }
    await destination.global.set({ migration: { state: 'complete', digest, count: records.length } })
  } finally { await legacy.close() }
}
