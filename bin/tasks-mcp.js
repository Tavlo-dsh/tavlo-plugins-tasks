#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createTaskMcpServer } from '../task-mcp.js'
import { connectTaskHost } from '../task-mcp-client.js'

let host
let server
let stopping
const stop = () => stopping ??= Promise.resolve().then(async () => {
  await server?.close()
  await host?.close()
})

try {
  host = await connectTaskHost(process.env.DSH_TASKS_URL ?? 'http://127.0.0.1:3000/', process.env.DSH_TASKS_TOKEN)
  server = createTaskMcpServer(host)
  server.server.onclose = () => { void stop() }
  for (const event of ['SIGINT', 'SIGTERM']) process.once(event, () => { void stop() })
  process.stdin.once('end', () => { void stop() })
  await server.connect(new StdioServerTransport())
} catch (error) {
  // stdout is reserved for MCP. Never print the token, URL query or headers.
  console.error('Task MCP bridge failed:', error instanceof TypeError ? 'Check Host URL and availability' : error.message)
  await stop()
  process.exitCode = 1
}
