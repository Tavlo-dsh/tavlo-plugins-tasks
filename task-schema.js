/** Durable task records and validated operation inputs. */
import { z } from 'zod'
import { columnColor, columnId, columnName, labelFields, priorityKey, priorityFields } from './task-board.js'

const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/)
const title = z.string().min(1).refine(value => value.trim().length > 0, 'Title must not be blank')
const revision = z.number().int().positive()
export const sessionId = z.union([z.uuid(), z.templateLiteral(['session-', z.uuid()])])
const stage = z.enum(['todo', 'doing', 'done'])
const model = z.strictObject({
  provider: z.string().min(1).max(256), model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(128).optional(),
})
const bindings = { workspaceId: z.uuid().optional(), model: model.optional() }
const priority = priorityKey
const metadata = { labelId: z.uuid().optional(), priority: priority.optional(), dueDate: z.iso.date().optional() }
const commentText = z.string().trim().min(1).max(4000)
const acceptanceCriteria = z.string().trim().max(4000)
const savedCriteria = acceptanceCriteria.min(1)
const dependencyIds = z.array(z.uuid().toLowerCase()).max(20)
  .refine(ids => new Set(ids).size === ids.length, 'Dependencies must be unique')
const taskRequirements = { acceptanceCriteria: acceptanceCriteria.optional(), dependencyIds: dependencyIds.optional() }
const plainText = (max = 4000, min = 1) => z.string().trim().min(min).max(max).refine(value => value.isWellFormed()
  && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value), 'Expected plain text')
const deliveryText = plainText()
const linkUrl = z.string().trim().max(2048).regex(/^https?:\/\/[^/?#]+(?:[/?#]|$)/i)
  .refine(value => {
    if (/[\s\\\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(value) || !value.isWellFormed()) return false
    const url = URL.parse(value)
    return !!url && !url.username && !url.password && !!url.hostname && !value.split(/[/?#]/u, 4)[2]?.includes('@')
  }, 'Expected an HTTP(S) URL without credentials')
const evidence = { summary: deliveryText, verification: deliveryText.optional(), remaining: deliveryText.optional(),
  links: z.array(z.strictObject({ label: plainText(120), url: linkUrl })).max(10).optional() }
const deliveryId = z.uuid()
export const recoverCreationSession = Symbol('recover-creation-session')
export const recoverCreationSessionSchema = z.strictObject({ taskId: z.uuid(), expectedRevision: revision, sessionId,
  callSeq: z.number().int().nonnegative(), resultSeq: z.number().int().positive() }).refine(row => row.resultSeq > row.callSeq)
export const submitDelivery = Symbol('submit-delivery')
const optionalDeliveryText = plainText(4000, 0).optional()
export const submitDeliverySchema = z.strictObject({ taskId: z.uuid(), requestId, ...evidence,
  verification: optionalDeliveryText, remaining: optionalDeliveryText })
const deliveryBase = z.strictObject({ id: deliveryId, sessionId, ...evidence, criteria: savedCriteria.optional(), submittedAt: z.iso.datetime() })
const deliverySchema = z.discriminatedUnion('status', [
  deliveryBase.extend({ status: z.literal('pending') }),
  deliveryBase.extend({ status: z.literal('accepted'), reviewedAt: z.iso.datetime(), feedback: deliveryText.optional() }),
  deliveryBase.extend({ status: z.literal('returned'), reviewedAt: z.iso.datetime(), feedback: deliveryText, continuedAt: z.iso.datetime().optional() }),
]).refine(row => (!row.reviewedAt || row.reviewedAt >= row.submittedAt)
  && (!row.continuedAt || row.continuedAt >= row.reviewedAt), 'Invalid delivery timestamps')
const reviewDelivery = z.strictObject({ taskId: z.uuid(), deliveryId, expectedRevision: revision, requestId,
  decision: z.enum(['accept', 'return']), feedback: optionalDeliveryText,
}).refine(row => row.decision !== 'return' || !!row.feedback, 'Returning a delivery requires feedback')
const continueDelivery = z.strictObject({ taskId: z.uuid(), deliveryId, expectedRevision: revision })
const receiptBase = { requestId, deliveryId, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), appliedRevision: revision }
const deliveryReceipt = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('submission'), sessionId, ...receiptBase }),
  z.strictObject({ kind: z.literal('review'), decision: z.enum(['accept', 'return']), ...receiptBase }),
])
export const imageTypes = ['image/png', 'image/jpeg', 'image/webp']
export const fileCapacity = 10
export const maxFileBytes = 10 * 1024 * 1024
const attachmentId = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const attachmentName = z.string().min(1).max(255).refine(value => value.isWellFormed() && !/[\\/\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(value) && value !== '.' && value !== '..')
const mediaType = z.string().regex(/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/)
export const imageRef = z.object({ attachmentId, mediaType: z.enum(imageTypes), bytes: revision, width: revision, height: revision, name: attachmentName.optional() })
export const fileRef = z.strictObject({ attachmentId, name: attachmentName, bytes: z.number().int().nonnegative().max(maxFileBytes), mediaType: mediaType.optional() })
export const uploadImage = Symbol('upload-image')
export const uploadFile = Symbol('upload-file')
const uploadFields = { taskId: z.uuid(), requestId, data: z.instanceof(Uint8Array) }
export const uploadSchema = z.strictObject({ ...uploadFields, mediaType: z.enum(imageTypes) })
export const uploadFileSchema = z.strictObject({ ...uploadFields, mediaType, name: attachmentName })
export function uploadMediaType(header) {
  const parsed = mediaType.safeParse(header?.split(';', 1)[0].trim().toLowerCase())
  return parsed.success ? parsed.data : 'application/octet-stream'
}
export function uploadFileName(value) {
  const leaf = (value ?? '').split(/[\\/]/u).at(-1).toWellFormed()
    .replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, '').replace(/[<>:"|?*]/gu, '_').trim()
  return leaf.slice(0, 255).toWellFormed().replace(/[. ]+$/u, '') || 'file'
}
const removeAttachment = z.strictObject({ taskId: z.uuid(), requestId, attachmentId, expectedRevision: revision })
export const pageSize = 32
const activity = z.strictObject({ id: revision, at: z.iso.datetime(), source: z.enum(['rpc', 'agent', 'service']),
  kind: z.enum(['created', 'updated', 'moved', 'completed', 'reopened', 'comment', 'bound', 'image-added', 'image-removed', 'file-added', 'file-removed',
    'delivery-submitted', 'delivery-accepted', 'delivery-returned']), attachmentId: attachmentId.optional(), name: attachmentName.optional(),
  fields: z.array(z.string()).optional(), from: columnId.optional(), to: columnId.optional(), sessionId: sessionId.optional(),
  text: commentText.optional(), requestId: requestId.optional() })
/** Remote identity belongs to the connector; it never contains credentials. */
export const externalIdentitySchema = z.strictObject({
  provider: z.string().min(1).max(64),
  connectionId: z.uuid(),
  scopeId: z.string().min(1).max(128),
  objectType: z.string().min(1).max(64),
  objectId: z.string().min(1).max(128),
})
export const externalRefSchema = externalIdentitySchema.extend({
  url: z.url({ protocol: /^https?$/ }).max(2048).refine(value => {
    const url = new URL(value)
    return !url.username && !url.password
  }, 'Source URLs must not contain credentials').optional(),
})
const updatePatch = z.strictObject({
  workspaceId: bindings.workspaceId.nullable(), model: bindings.model.nullable(),
  labelId: z.uuid().nullable().optional(), priority: priority.nullable().optional(), dueDate: z.iso.date().nullable().optional(),
  title: title.transform(value => value.trim()).optional(),
  brief: z.string().optional(),
  ...taskRequirements,
  externalRef: externalRefSchema.nullable().optional(),
}).refine(value => Object.values(value).some(value => value !== undefined), 'Patch must contain a change')
const updateReplay = z.strictObject({ requestId, taskId: z.uuid(), expectedRevision: revision, patch: updatePatch })
const launchInput = z.strictObject({
  requestId, taskId: z.uuid(), expectedRevision: revision,
  content: z.string().refine(value => value.trim().length > 0),
  ...bindings, agentPreset: z.string().min(1).max(256).optional(),
  replaceActive: z.boolean().default(false),
  includeImages: z.boolean().optional(),
  includeFiles: z.boolean().optional(),
  forkFromSessionId: sessionId.optional(),
})
const launch = z.strictObject({
  input: launchInput, sessionId: sessionId.optional(),
  phase: z.enum(['prepared', 'forking', 'created', 'sending', 'complete', 'abandoned']),
}).refine(row => {
  const parent = row.input.forkFromSessionId
  if (row.phase === 'forking') return !!parent && !row.sessionId
  if (parent && (row.phase === 'prepared' || parent === row.sessionId)) return false
  return !!row.sessionId || (!!parent && row.phase === 'abandoned')
}, 'Invalid launch target for this phase')
const storedLaunch = launch.safeExtend({ images: z.array(imageRef).max(fileCapacity).optional(), files: z.array(fileRef).max(fileCapacity).optional(), attachWorkspaceId: z.uuid().optional(), criteria: savedCriteria.optional() })
const creationReplay = z.strictObject({
  ...metadata, ...taskRequirements,
  requestId,
  title: z.string().trim().min(1),
  brief: z.string().default(''),
  stage: stage.default('todo'),
  columnId: columnId.optional(),
  ...bindings,
  externalRef: externalRefSchema.optional(),
})

/** Basic TaskRecord with optional workspace/model preferences; metadata stays private. */
export const taskRecordSchema = z.strictObject({
  imageCount: z.number().int().min(1).max(fileCapacity).optional(),
  fileCount: z.number().int().min(1).max(fileCapacity).optional(),
  ...metadata, completedAt: z.iso.datetime().optional(), commentCount: z.number().int().positive().optional(),
  id: z.uuid(),
  revision,
  title,
  brief: z.string().optional(),
  acceptanceCriteria: savedCriteria.optional(),
  dependencyIds: dependencyIds.optional(),
  delivery: deliverySchema.optional(),
  stage,
  columnId: columnId.optional(), orderKey: z.string().regex(/^[0-9a-f]*[1-9a-f]$/).max(2048).optional(),
  position: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  ...bindings,
  externalRef: externalRefSchema.optional(),
  activeSessionId: sessionId.optional(),
  previousSessionIds: z.array(sessionId).optional(),
  launch: launch.optional(),
})

const storedTaskSchema = taskRecordSchema.omit({ imageCount: true, fileCount: true }).extend({
  launch: storedLaunch.optional(),
  _images: z.array(imageRef).max(fileCapacity).refine(rows => new Set(rows.map(row => row.attachmentId)).size === rows.length).optional(),
  _files: z.array(fileRef).max(fileCapacity).optional(),
  _create: z.strictObject({ requestId, title, brief: z.string(), stage: stage.optional(), columnId: columnId.optional(), ...bindings, ...metadata, ...taskRequirements, externalRef: externalRefSchema.optional() }),
  _creationSessionId: sessionId.optional(),
  _deliveryReceipts: z.array(deliveryReceipt).optional(),
  _tail: z.array(activity).min(1).max(pageSize + 2).optional(),
  _launches: z.array(storedLaunch).optional(),
  _updates: z.array(z.strictObject({
    requestId, fingerprint: z.string().regex(/^[a-f0-9]{64}$/), appliedRevision: revision,
  })).optional(),
})

// A minimal durable receipt prevents old creation retries from reviving a
// deleted task. The task's title, brief, bindings and launch history are removed.
const deletedTaskSchema = z.strictObject({
  id: z.uuid(),
  _deleted: z.strictObject({ requestId, revision, at: z.iso.datetime() }),
})

/** Public DomainSpec fields; opening validates all committed records. */
export const taskDomain = {
  name: 'tasks',
  version: 5,
  compatibleVersions: [1, 2, 3, 4],
  tables: { tasks: { valueSchema: z.union([storedTaskSchema.omit({ columnId: true, orderKey: true }).extend({
    _create: storedTaskSchema.shape._create.omit({ columnId: true }),
  }), deletedTaskSchema]) } },
}

export const boardTables = { tasks: { valueSchema: z.union([storedTaskSchema, deletedTaskSchema]) }, activity: { valueSchema: z.array(activity).length(pageSize) } }

/**
 * Build operation schemas using the configured limits for new input.
 * Existing records remain readable when a deployment lowers those limits.
 * @param limits - resolved plugin Config.
 * @returns operation schemas and the replay schema for existing requests.
 */
export function createInputSchemas(limits) {
  const operations = new Map([
    ['capabilities', z.strictObject({})],
    ['board', z.strictObject({})],
    ['edit-priorities', z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('add'), expectedRevision: revision, ...priorityFields }),
      z.strictObject({ action: z.literal('edit'), expectedRevision: revision, ...priorityFields }),
      z.strictObject({ action: z.literal('remove'), expectedRevision: revision, key: priorityKey }),
      z.strictObject({ action: z.literal('reorder'), expectedRevision: revision, key: priorityKey, before: priorityKey.nullable() }),
    ])],
    ['images', z.strictObject({ taskId: z.uuid().optional(), launchRequestId: requestId.optional() })
      .refine(value => !value.launchRequestId || !!value.taskId, 'Launch images require a task')],
    ['remove-image', removeAttachment],
    ['files', z.strictObject({ taskId: z.uuid().optional(), launchRequestId: requestId.optional() })
      .refine(value => !value.launchRequestId || !!value.taskId, 'Launch files require a task')],
    ['remove-file', removeAttachment],
    ['edit-labels', z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('add'), expectedRevision: revision, ...labelFields }),
      z.strictObject({ action: z.literal('edit'), expectedRevision: revision, labelId: z.uuid(), ...labelFields }),
      z.strictObject({ action: z.literal('remove'), expectedRevision: revision, labelId: z.uuid() }),
    ])],
    ['history', z.strictObject({ taskId: z.uuid(), before: revision.optional(), limit: z.number().int().min(1).max(100).default(25) })],
    ['comment', z.strictObject({ taskId: z.uuid(), requestId, text: commentText })],
    ['comment-matches', z.strictObject({ query: z.string().trim().min(1).max(2048) })],
    ['edit-columns', z.discriminatedUnion('action', [
      z.strictObject({ action: z.literal('add'), expectedRevision: revision, stage, name: columnName, color: columnColor.optional() }),
      z.strictObject({ action: z.literal('rename'), expectedRevision: revision, columnId, name: columnName, color: columnColor.nullable().optional() }),
      z.strictObject({ action: z.literal('remove'), expectedRevision: revision, columnId }),
      z.strictObject({ action: z.literal('reorder'), expectedRevision: revision, columnId, before: columnId.nullable() }),
    ])],
    ['move', z.strictObject({ taskId: z.uuid(), expectedRevision: revision, columnId, anchor: z.strictObject({ taskId: z.uuid(), side: z.enum(['before', 'after']) }).optional() })],
    ['options', z.strictObject({})],
    ['list', z.strictObject({
      query: z.string().trim().max(2048).optional(), ...metadata, due: z.enum(['today', 'overdue']).optional(), today: z.iso.date().optional(),
      stage: stage.optional(), workspaceId: z.uuid().optional(), provider: z.string().min(1).max(64).optional(),
      externalRef: externalIdentitySchema.optional(),
      limit: z.number().int().min(1).max(1000).optional(), offset: z.number().int().nonnegative().optional(),
    })],
    ['get', z.strictObject({ taskId: z.uuid() })],
    ['create', creationReplay.extend({
      title: z.string().trim().min(1).max(limits.maxTitleLength),
      brief: z.string().max(limits.maxBriefLength).default(''),
    })],
    ['update', updateReplay.extend({ patch: updatePatch.safeExtend({
      title: z.string().trim().min(1).max(limits.maxTitleLength).optional(),
      brief: z.string().max(limits.maxBriefLength).optional(),
    }) })],
    ['set-stage', z.strictObject({ taskId: z.uuid(), expectedRevision: revision, stage })],
    ['review-delivery', reviewDelivery],
    ['continue-delivery', continueDelivery],
    ['delete', z.strictObject({ taskId: z.uuid(), expectedRevision: revision })],
    ['launch', launchInput.extend({ content: z.string().min(1).max(limits.maxBriefLength + limits.maxTitleLength + 2).refine(value => value.trim().length > 0) })],
    ['resume-launch', z.strictObject({ taskId: z.uuid(), requestId })],
    ['abandon-launch', z.strictObject({ taskId: z.uuid(), requestId, expectedRevision: revision })],
  ])
  return { operations, creationReplay, updateReplay, launchReplay: launchInput }
}
