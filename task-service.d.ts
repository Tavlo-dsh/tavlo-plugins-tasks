export type TaskStage = 'todo' | 'doing' | 'done'
export interface TaskColumn { id: string; stage: TaskStage; name?: string; color?: string }
export interface TaskLabel { id: string; name: string; color: string }
export interface TaskPriority { key: string; name: string }
export interface TaskProperties { labelId?: string; priority?: string; dueDate?: string }
export interface TaskRequirements { acceptanceCriteria?: string; dependencyIds?: string[] }
export interface TaskDeliveryEvidence { summary: string; verification?: string; remaining?: string; links?: { label: string; url: string }[] }
export type TaskDelivery = TaskDeliveryEvidence & { id: string; sessionId: string; criteria?: string; submittedAt: string } & (
  | { status: 'pending'; reviewedAt?: never; feedback?: never; continuedAt?: never }
  | { status: 'accepted'; reviewedAt: string; feedback?: string; continuedAt?: never }
  | { status: 'returned'; reviewedAt: string; feedback: string; continuedAt?: string }
)
export type TaskImageType = 'image/png' | 'image/jpeg' | 'image/webp'
export interface TaskImage { attachmentId: string; mediaType: TaskImageType; bytes: number; width: number; height: number; name?: string }
export interface TaskImageLimits { mediaTypes: TaskImageType[]; maxImageBytes: number; maxImages: number }
export type TaskFile = TaskImage | { attachmentId: string; bytes: number; mediaType?: string; name: string; width?: never; height?: never }
export interface TaskFileLimits { mediaTypes: TaskImageType[]; maxImageBytes: number; maxFileBytes: number; maxFiles: number }
export interface Activity { id: number; at: string; source: 'rpc' | 'agent' | 'service'; kind: 'created' | 'updated' | 'moved' | 'completed' | 'reopened' | 'comment' | 'bound' | 'image-added' | 'image-removed' | 'file-added' | 'file-removed' | 'delivery-submitted' | 'delivery-accepted' | 'delivery-returned'; attachmentId?: string; name?: string; from?: string; to?: string; fields?: string[]; text?: string; sessionId?: string }
export interface TaskBoard { revision: number; columns: TaskColumn[]; labels?: TaskLabel[]; priorities: TaskPriority[] }
export interface ExternalIdentity {
  provider: string
  connectionId: string
  scopeId: string
  objectType: string
  objectId: string
}
export interface ExternalRef extends ExternalIdentity { url?: string }
export interface TaskModel { provider: string; model: string; reasoningEffort?: string }
export interface TaskBindings { workspaceId?: string; model?: TaskModel }
export interface CreateTaskInput extends TaskBindings, TaskProperties, TaskRequirements {
  requestId: string
  title: string
  brief?: string
  stage?: TaskStage
  columnId?: string
  externalRef?: ExternalRef
}
export interface UpdateTaskInput {
  requestId: string
  taskId: string
  expectedRevision: number
  patch: TaskRequirements & { title?: string; brief?: string; externalRef?: ExternalRef | null; labelId?: string | null; priority?: TaskProperties['priority'] | null; dueDate?: string | null; workspaceId?: string | null; model?: TaskModel | null }
}
export interface ContinueDeliveryInput { taskId: string; deliveryId: string; expectedRevision: number }
export type ReviewDeliveryInput = ContinueDeliveryInput & { requestId: string } & (
  | { decision: 'accept'; feedback?: string }
  | { decision: 'return'; feedback: string }
)
export interface LaunchTaskInput extends TaskBindings {
  requestId: string
  taskId: string
  expectedRevision: number
  content: string
  agentPreset?: string
  replaceActive?: boolean
  /** Include only images (legacy). */
  includeImages?: boolean
  /** Include all task attachments, including images. */
  includeFiles?: boolean
  forkFromSessionId?: string
}
export interface TaskRecord extends TaskBindings, TaskProperties, TaskRequirements {
  delivery?: TaskDelivery
  completedAt?: string
  commentCount?: number
  imageCount?: number
  fileCount?: number
  id: string
  revision: number
  title: string
  brief?: string
  stage: TaskStage
  columnId: string
  orderKey: string
  position: number
  createdAt: string
  updatedAt: string
  externalRef?: ExternalRef
  activeSessionId?: string
  previousSessionIds?: string[]
  launch?: { input: LaunchTaskInput } & (
    | { phase: 'forking'; sessionId?: never }
    | { phase: 'abandoned'; sessionId?: string }
    | { phase: 'prepared' | 'created' | 'sending' | 'complete'; sessionId: string }
  )
}
export interface TaskCapabilities {
  contractVersion: 1
  operations: (keyof TaskRpcInputs)[]
  features: { externalRef: boolean; externalRefUnique: boolean; durableUpdateReplay: boolean; snapshotWatch: boolean; filteredList: boolean; boardColumns?: boolean; boardPriorities?: boolean; collaboration?: boolean; taskImages?: boolean; taskFiles?: boolean; taskFileLaunch?: boolean; acceptanceCriteria?: boolean; taskDependencies?: boolean; taskDelivery?: boolean }
  limits: { maxTitleLength: number; maxBriefLength: number; maxTasks: number; maxUpdatesPerTask: number }
}
export interface TaskInputs {
  images: { taskId?: string; launchRequestId?: never } | { taskId: string; launchRequestId: string }
  'remove-image': { taskId: string; requestId: string; attachmentId: string; expectedRevision: number }
  files: TaskInputs['images']
  'remove-file': TaskInputs['remove-image']
  board: Record<string, never>
  'edit-priorities': { expectedRevision: number; key: string } & (
    | { action: 'add' | 'edit'; name: string }
    | { action: 'remove' }
    | { action: 'reorder'; before: string | null }
  )
  'edit-labels': { expectedRevision: number } & ({ action: 'add'; name: string; color: string } | { action: 'edit'; labelId: string; name: string; color: string } | { action: 'remove'; labelId: string })
  history: { taskId: string; before?: number; limit?: number }
  comment: { taskId: string; requestId: string; text: string }
  'comment-matches': { query: string }
  'edit-columns': { expectedRevision: number } & ({ action: 'add'; stage: TaskStage; name: string; color?: string } | { action: 'rename'; columnId: string; name: string; color?: string | null } | { action: 'remove'; columnId: string } | { action: 'reorder'; columnId: string; before: string | null })
  move: { taskId: string; expectedRevision: number; columnId: string; anchor?: { taskId: string; side: 'before' | 'after' } }
  capabilities: Record<string, never>
  options: Record<string, never>
  list: TaskProperties & { query?: string; due?: 'today' | 'overdue'; today?: string; stage?: TaskStage; workspaceId?: string; provider?: string; externalRef?: ExternalIdentity; limit?: number; offset?: number }
  get: { taskId: string }
  create: CreateTaskInput
  update: UpdateTaskInput
  'set-stage': { taskId: string; expectedRevision: number; stage: TaskStage }
  delete: { taskId: string; expectedRevision: number }
  launch: LaunchTaskInput
  'resume-launch': { taskId: string; requestId: string }
  'abandon-launch': { taskId: string; requestId: string; expectedRevision: number }
}
export interface TaskOutputs {
  images: { limits: TaskImageLimits | null; images: TaskImage[]; revision?: number; launchRequestId?: string }
  'remove-image': { task: TaskRecord }
  files: { files: TaskFile[]; limits: TaskFileLimits | null; revision?: number; launchRequestId?: string }
  'remove-file': { task: TaskRecord }
  board: { board: TaskBoard }
  'edit-priorities': { board: TaskBoard }
  'edit-labels': { board: TaskBoard }
  history: { events: Activity[]; before?: number }
  comment: { task: TaskRecord }
  'comment-matches': { matches: Record<string, string> }
  'edit-columns': { board: TaskBoard }
  move: { task: TaskRecord }
  capabilities: TaskCapabilities
  options: {
    canFork: boolean
    workspaces: { id: string; title: string; path: string }[]
    groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name?: string }[] } }[] }[]
    presets: { id: string; name: string }[]
    workspaceStatus: 'ready' | 'error' | 'unavailable'
    modelStatus: 'ready' | 'error' | 'unavailable'
    modelFailures: number
    defaultModel?: TaskModel
  }
  list: { tasks: TaskRecord[]; total?: number }
  get: { task: TaskRecord }
  create: { task: TaskRecord }
  update: { task: TaskRecord; mutation: { requestId: string; appliedRevision: number; replayed: boolean } }
  'set-stage': { task: TaskRecord }
  delete: { taskId: string; revision: number }
  launch: { task: TaskRecord; sessionId: string }
  'resume-launch': { task: TaskRecord; sessionId: string }
  'abandon-launch': { task: TaskRecord }
}
export interface TaskRpcInputs extends TaskInputs {
  'review-delivery': ReviewDeliveryInput
  'continue-delivery': ContinueDeliveryInput
}
export interface TaskRpcOutputs extends TaskOutputs {
  'review-delivery': TaskOutputs['update'] & { deliveryId: string }
  'continue-delivery': { task: TaskRecord }
}
export type TaskResult<T = unknown> =
  | { ok: true; value: T; streamId?: string; sequence?: number }
  | { ok: false; error: { code: string; message: string; details: Record<string, unknown> } }
export type TaskEvent = { streamId: string; sequence: number } & (
  | { type: 'snapshot'; tasks: TaskRecord[]; statuses: Record<string, unknown> }
  | { type: 'upsert'; task: TaskRecord }
  | { type: 'remove'; taskId: string; revision: number }
  | { type: 'status'; taskId: string; status: unknown }
  | { type: 'unavailable'; code: string }
)
export interface TaskServiceV1 {
  readonly contractVersion: 1
  capabilities(): Promise<TaskCapabilities>
  execute<K extends keyof TaskInputs>(operation: K, input: TaskInputs[K], signal?: AbortSignal): Promise<TaskResult<TaskOutputs[K]>>
  watch(observer: (event: TaskEvent) => void, signal?: AbortSignal): Promise<() => void>
}
export type TaskService = TaskServiceV1
export function createTaskService(store: Pick<TaskService, 'execute' | 'watch'>): TaskService

declare module '@deepseek-ai/cordis' {
  interface Context { taskService: TaskService }
}
