/** Durable task records and validated operation inputs. */
import { z } from 'zod'

const requestId = z.string().min(1).max(128).regex(/^[A-Za-z0-9._~-]+$/)
const title = z.string().min(1).refine(value => value.trim().length > 0, 'Title must not be blank')
const revision = z.number().int().positive()
const stage = z.enum(['todo', 'doing', 'done'])
const model = z.strictObject({
  provider: z.string().min(1).max(256), model: z.string().min(1).max(256),
  reasoningEffort: z.string().min(1).max(128).optional(),
})
const bindings = { workspaceId: z.uuid().optional(), model: model.optional() }
const launchInput = z.strictObject({
  requestId, taskId: z.uuid(), expectedRevision: revision,
  content: z.string().refine(value => value.trim().length > 0),
  ...bindings, agentPreset: z.string().min(1).max(256).optional(),
  replaceActive: z.boolean().default(false),
})
const launch = z.strictObject({
  input: launchInput, sessionId: z.uuid(),
  phase: z.enum(['prepared', 'created', 'sending', 'complete', 'abandoned']),
})
const creationReplay = z.strictObject({
  requestId,
  title: z.string().trim().min(1),
  brief: z.string().default(''),
  stage: stage.default('todo'),
  ...bindings,
})

/** Basic TaskRecord with optional workspace/model preferences; metadata stays private. */
export const taskRecordSchema = z.strictObject({
  id: z.uuid(),
  revision,
  title,
  brief: z.string().optional(),
  stage,
  position: z.number().nonnegative().max(Number.MAX_SAFE_INTEGER),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
  ...bindings,
  activeSessionId: z.uuid().optional(),
  previousSessionIds: z.array(z.uuid()).optional(),
  launch: launch.optional(),
})

const storedTaskSchema = taskRecordSchema.extend({
  _create: z.strictObject({ requestId, title, brief: z.string(), stage: stage.optional(), ...bindings }),
  _launches: z.array(launch).optional(),
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
  version: 4,
  compatibleVersions: [1, 2, 3],
  tables: { tasks: { valueSchema: z.union([storedTaskSchema, deletedTaskSchema]) } },
}

/**
 * Build operation schemas using the configured limits for new input.
 * Existing records remain readable when a deployment lowers those limits.
 * @param limits - resolved plugin Config.
 * @returns operation schemas and the replay schema for existing requests.
 */
export function createInputSchemas(limits) {
  const operations = new Map([
    ['list', z.strictObject({})],
    ['create', creationReplay.extend({
      title: z.string().trim().min(1).max(limits.maxTitleLength),
      brief: z.string().max(limits.maxBriefLength).default(''),
    })],
    ['set-stage', z.strictObject({ taskId: z.uuid(), expectedRevision: revision, stage })],
    ['delete', z.strictObject({ taskId: z.uuid(), expectedRevision: revision })],
    ['launch', launchInput.extend({ content: z.string().min(1).max(limits.maxBriefLength + limits.maxTitleLength + 2).refine(value => value.trim().length > 0) })],
    ['resume-launch', z.strictObject({ taskId: z.uuid(), requestId })],
    ['abandon-launch', z.strictObject({ taskId: z.uuid(), requestId, expectedRevision: revision })],
  ])
  return { operations, creationReplay, launchReplay: launchInput }
}
