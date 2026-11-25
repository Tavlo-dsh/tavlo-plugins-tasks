import { z } from 'zod'

export const stages = ['todo', 'doing', 'done']
export const defaultColumn = stage => 'stage:' + stage
export const columnId = z.union([z.uuid(), z.enum(stages.map(defaultColumn))])
export const columnName = z.string().trim().min(1).max(80)
export const columnColor = z.string().regex(/^#[0-9a-f]{6}$/i)
export const labelFields = { name: columnName, color: columnColor }
export const priorityKey = z.string().trim().min(1).max(32)
export const priorityFields = { key: priorityKey, name: z.string().trim().min(1).max(80) }
export const priorityCapacity = 100
const priorities = z.array(z.strictObject(priorityFields)).max(priorityCapacity)
  .refine(rows => new Set(rows.map(row => row.key)).size === rows.length, 'Priority keys must be unique')
// Absent means defaults; an explicitly empty catalog stays empty.
export const boardPriorities = board => board.priorities ?? ['P0', 'P1', 'P2'].map(key => ({ key, name: key }))
export const boardSchema = z.strictObject({ revision: z.number().int().positive(), labels: z.array(z.strictObject({ id: z.uuid(), ...labelFields })).max(100).refine(rows => new Set(rows.map(row => row.id)).size === rows.length).optional(), priorities: priorities.optional(), columns: z.array(z.strictObject({
  id: columnId, stage: z.enum(stages), name: columnName.optional(), color: columnColor.optional(),
})).max(100) }).refine(({ columns }) => new Set(columns.map(column => column.id)).size === columns.length
  && stages.every(stage => columns.some(column => column.id === defaultColumn(stage) && column.stage === stage))
  && columns.every(column => column.id === defaultColumn(column.stage) || !!column.name))
export const initialBoard = () => ({ revision: 1, columns: stages.map(stage => ({ id: defaultColumn(stage), stage })) })

export function orderKey(task) {
  if (task.orderKey) return task.orderKey
  const bytes = Buffer.alloc(8)
  bytes.writeDoubleBE(task.position || 0)
  return bytes.toString('hex') + task.id.replaceAll('-', '') + '8'
}

export function between(lower = '', upper = '') {
  let prefix = ''
  for (let index = 0; index < 2048; index++) {
    const left = parseInt(lower[index] ?? '0', 16), right = parseInt(upper[index] ?? 'f', 16)
    if (right - left > 1) return prefix + Math.floor((left + right) / 2).toString(16)
    prefix += left.toString(16)
    if (right > left) upper = ''
  }
  return null
}
