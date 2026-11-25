/** MCP is an adapter over TaskService; it never opens storage or starts AI sessions. */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { z } from 'zod'
import { createInputSchemas, recoverCreationSession, recoverCreationSessionSchema, submitDelivery, submitDeliverySchema } from './task-schema.js'

const tools = [
  ['capabilities', 'Read task service version, operations and configured limits.', true],
  ['options', 'List available DSH workspaces and model preferences. Use these IDs when creating a task.', true],
  ['list', 'List tasks. Filter by text, label, priority, due date/status, stage, workspace or external source. If due is today or overdue, supply today as the user’s local calendar date when known. Use limit and offset to paginate.', true],
  ['get', 'Read a task and its current revision before updating it.', true],
  ['create', 'Add a task to the shared board without starting an AI session. Supports labelId, priority, dueDate, acceptance criteria and dependencies. Use tasks_board to look up a label ID, priority key or column ID. Give each new intent a unique requestId; retry with exactly the same input. Set externalRef only for externally sourced items.', false],
  ['update', 'Update task fields, including acceptance criteria and dependencies. Supply current task revision and unique requestId; retry with identical input.', false],
  ['board', 'Read the shared board revision, columns, label IDs and ordered priority keys. Use this before assigning metadata or editing label/priority definitions.', true],
  ['edit-labels', 'Add, edit or remove a shared board label. Read tasks_board first and use its board revision (not a task revision). Add requires name and #RRGGBB color; edit requires labelId, name and color; remove requires labelId and fails if any task still uses it. Re-read the board after a conflict or uncertain result.', false],
  ['edit-priorities', 'Manage the shared priority catalog using the current board revision from tasks_board. Add requires key and name; edit changes the display name without changing the key stored on tasks; remove fails while the key is in use; reorder moves key before another key (or to the end with before: null). Re-read the board after a conflict or uncertain result.', false],
  ['history', 'Read newest-first activity and plain text comments. Pass the returned before cursor for older events.', true],
  ['move', 'Move a task to a board column using its current revision. Read again after an uncertain result.', false],
  ['comment', 'Append a plain text comment. Reuse requestId and identical text on retries.', false],
  ['set-stage', 'Change the local board stage using its current revision. This does not change any remote system or start an AI session. After an uncertain result read the task before trying again.', false],
]

const metadataGuide = {
  labelId: 'Label UUID from tasks_board. Do not pass a label name.',
  priority: 'Priority key from tasks_board (default catalog: P0, P1, P2), not its display name.',
  dueDate: 'User-local calendar date in YYYY-MM-DD, without a time or timezone. Resolve relative dates in the user’s local calendar; ask if ambiguous.',
}

function describeFields(schema, fields) {
  return schema.safeExtend(Object.fromEntries(Object.entries(fields).map(([key, description]) => [key, schema.shape[key].describe(description)])))
}

// MCP tools/list requires a top-level object. The SDK does not advertise root
// unions, so expose common fields here and let TaskService enforce each action.
function editToolSchema(schema, help) {
  const shapes = schema.options.map(option => option.shape)
  const { action: _action, ...fields } = Object.assign({}, ...shapes)
  for (const key of Object.keys(fields)) {
    if (!shapes.every(shape => Object.hasOwn(shape, key))) fields[key] = fields[key].optional()
  }
  return describeFields(z.strictObject({ action: z.enum(shapes.map(shape => shape.action.value)), ...fields }), {
    expectedRevision: 'Current shared board revision from tasks_board.', ...help,
  })
}

function taskToolSpecs() {
  // Service limits are enforced only for new writes, not already committed retries.
  const { operations } = createInputSchemas({ maxTitleLength: Number.MAX_SAFE_INTEGER, maxBriefLength: Number.MAX_SAFE_INTEGER })
  return tools.map(([operation, description, readOnly]) => {
    let inputSchema = operations.get(operation)
    if (operation === 'create') {
      // Leave an omitted stage omitted so the service can infer it from columnId.
      inputSchema = describeFields(inputSchema.extend({ stage: inputSchema.shape.stage.removeDefault().optional() }), {
        ...metadataGuide, stage: 'Optional phase; inferred from columnId if supplied, otherwise defaults to todo.',
        acceptanceCriteria: 'How the owner will judge the work (up to 4000 characters).',
        dependencyIds: 'Up to 20 unique existing prerequisite task UUIDs. They must be done before a new launch.',
      })
    } else if (operation === 'update') {
      const patchGuide = Object.fromEntries(Object.entries(metadataGuide).map(([key, text]) => [key, text + ' Pass null to clear.']))
      inputSchema = inputSchema.extend({ patch: describeFields(inputSchema.shape.patch, {
        ...patchGuide, acceptanceCriteria: 'How the owner will judge the work (up to 4000 characters); send an empty string to clear.',
        dependencyIds: 'Replace with up to 20 unique prerequisite task UUIDs; send an empty array to clear.',
      }) })
    } else if (operation === 'list') {
      inputSchema = describeFields(inputSchema.extend({ limit: z.number().int().min(1).max(1000).default(100) }), {
        ...metadataGuide, today: 'Local calendar date for due-status filtering (YYYY-MM-DD). Defaults to the Host’s local date.',
      })
    } else if (operation === 'edit-labels') {
      inputSchema = editToolSchema(inputSchema, { labelId: 'Required for edit or remove; use the UUID from tasks_board.',
        name: 'Required for add or edit.', color: 'Required for add or edit; hexadecimal #RRGGBB.' })
    } else if (operation === 'edit-priorities') {
      inputSchema = editToolSchema(inputSchema, { key: 'Stable, case-sensitive priority key stored on tasks.',
        name: 'Display name; required for add or edit.', before: 'Required for reorder. Use the target key, or null to put this key last.' })
    }
    return { name: 'tasks_' + operation.replaceAll('-', '_'), operation, description, readOnly, inputSchema }
  })
}

const render = result => [{ type: 'text', text: JSON.stringify(result) }]

/** Register built-in DSH Agent tools in the caller’s scoped ToolRuntime. */
export function registerTaskAgentTools(registry, service) {
  const nativeDelivery = { name: 'tasks_submit_delivery', operation: submitDelivery, readOnly: false, inputSchema: submitDeliverySchema,
    description: 'Submit evidence from this task’s current conversation for owner review. Use a unique requestId for each submission and reuse it only for identical retries. Do not mark the task done.' }
  const recover = { name: 'tasks_recover_creation_session', operation: recoverCreationSession, readOnly: false, inputSchema: recoverCreationSessionSchema,
    description: 'Repair an unbound legacy doing card unchanged except for comments when the owner identifies its original executing conversation. Requires the exact original native tasks_create call and result event sequence numbers in that session. The Host verifies both events. Never guess these values or use this to reassign a task.' }
  for (const { name, operation, description, readOnly, inputSchema } of [...taskToolSpecs(), nativeDelivery, recover]) {
    const { $schema, ...parameters } = z.toJSONSchema(inputSchema, { target: 'draft-7', io: 'input' })
    const sessionHint = operation === 'create'
      ? ' Create in a doing column only for work you are performing in this conversation: the task links to this conversation without starting a new one. For a backlog item, use todo (the default).'
      : operation === 'set-stage' || operation === 'move' ? ' Moving a task does not link it to this conversation.' : ''
    registry.register({
      name, description: description + sessionHint, parameters,
      output: { schema: { type: 'object', properties: {
        ok: { type: 'boolean' }, value: { type: 'object' }, error: { type: 'object' },
      }, required: ['ok'] }, render: (_args, result) => render(result) },
      isConcurrencySafe: () => readOnly,
      // Only the native ToolRuntime identifies the caller; the service resolves custom column stages.
      execute: (input, exec) => operation === 'create' || operation === submitDelivery || operation === recoverCreationSession
        ? service.execute(operation, input, exec.signal, 'agent', exec.agent?.id)
        : service.execute(operation, operation === 'list' ? { limit: 100, ...input } : input, exec.signal, 'agent'),
    })
  }
}

/** Can also be attached to an in-process or stdio SDK transport by another Host plugin. */
export function createTaskMcpServer(service) {
  const server = new McpServer({ name: 'tavlo-tasks', version: '0.2.0' }, {
    instructions: 'Manage the shared task board through TaskService. Create tasks when requested. A task is separate from an AI execution session. Use tasks_board to discover board metadata, never invent workspace IDs, and do not override revision conflicts. Reuse the same requestId and original input when retrying a write that takes a requestId.',
  })
  for (const { name, operation, description, readOnly, inputSchema } of taskToolSpecs()) {
    server.registerTool(name, {
      description, inputSchema,
      annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly && operation !== 'create',
        idempotentHint: readOnly || ['create', 'update', 'comment'].includes(operation), openWorldHint: false },
    }, async (input, extra) => {
      const result = await service.execute(operation, input, extra.signal, 'agent')
      return { content: render(result), structuredContent: result, ...(!result.ok ? { isError: true } : {}) }
    })
  }
  return server
}

/** Authentication and Host/Origin checks remain on the existing Connection exact route. */
export function createTaskMcpHttp(service) {
  const active = new Set()
  let closing = false
  return {
    async open(request) {
      if (closing) return Response.json({ error: 'Task MCP service is unavailable' }, { status: 503 })
      if (request.method !== 'POST') return new Response(null, { status: 405, headers: { allow: 'POST' } })
      const server = createTaskMcpServer({ execute: (operation, input, signal) =>
        service.execute(operation, input, AbortSignal.any([signal, request.signal]), 'agent') })
      const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true })
      active.add(server)
      try {
        await server.connect(transport)
        const response = await transport.handleRequest(request)
        // Drain the JSON response before closing its transport. There is no resumable MCP stream.
        const body = await response.arrayBuffer()
        return new Response(body.byteLength ? body : null, { status: response.status, headers: response.headers })
      } finally {
        active.delete(server)
        await server.close()
      }
    },
    async close() {
      closing = true
      await Promise.all([...active].map(server => server.close()))
    },
  }
}
