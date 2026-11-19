import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { TaskResult, TaskService } from './task-service.js'

/** Register with a scoped DSH ToolRuntime. The registry owns registration lifetimes. */
export function registerTaskAgentTools(registry: { register(tool: {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: { type: 'object'; required: string[]; properties: Record<string, { type: 'boolean' | 'object' }> }
    render(args: unknown, result: unknown): { type: 'text'; text: string }[]
  }
  isConcurrencySafe(): boolean
  execute(args: unknown, exec: { signal: AbortSignal }): Promise<TaskResult>
}): unknown }, service: Pick<TaskService, 'execute'>): void

export function createTaskMcpServer(service: Pick<TaskService, 'execute'>): McpServer
export function createTaskMcpHttp(service: Pick<TaskService, 'execute'>): {
  open(request: Request): Promise<Response>
  close(): Promise<void>
}
