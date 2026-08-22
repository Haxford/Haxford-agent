import {
  connectMcpServer,
  type McpClient,
  type McpConnectionStatus,
  type McpResult,
  type McpToolSchema,
} from "./client.ts"
import type { McpServerConfig } from "./config.ts"

export type McpServerStatus = McpConnectionStatus | "never-connected"

/**
 * A named MCP server with lazy (re)connect.
 *
 * Wraps a `McpClient` that may not exist yet (never started) or may have
 * died (server crash, EOF): `ensureConnected` connects on first use and
 * transparently reconnects after a crash, so a bridged tool's `execute` can
 * always call `callTool`/`listTools` without caring which case it is in.
 * Concurrent callers during a connect share the same in-flight attempt
 * rather than racing multiple spawns.
 */
export interface McpServerConnection {
  readonly name: string
  readonly config: McpServerConfig
  status(): McpServerStatus
  ensureConnected(): Promise<McpResult<{ client: McpClient }>>
  listTools(): Promise<McpResult<{ tools: McpToolSchema[] }>>
  callTool(
    toolName: string,
    args: Record<string, unknown>,
  ): Promise<McpResult<{ content: unknown[]; isError: boolean }>>
  close(): Promise<void>
}

export function createMcpServerConnection(
  name: string,
  config: McpServerConfig,
  opts: { cwd?: string; timeoutMs?: number } = {},
): McpServerConnection {
  let client: McpClient | undefined
  let connecting: Promise<McpResult<{ client: McpClient }>> | undefined

  const connect = async (): Promise<McpResult<{ client: McpClient }>> => {
    const result = await connectMcpServer(name, config, opts)
    // The dead client is kept (not cleared) on disconnect: `status()` reads
    // it directly, so a crash reports "disconnected" rather than collapsing
    // straight to "never-connected" — useful for a future /mcp status view.
    // `ensureConnected` already reconnects whenever `status() !== "connected"`,
    // and a successful reconnect below overwrites this reference anyway.
    if (result.ok) client = result.client
    return result
  }

  const ensureConnected = (): Promise<McpResult<{ client: McpClient }>> => {
    if (client && client.status() === "connected") {
      return Promise.resolve({ ok: true, client })
    }
    if (connecting) return connecting
    const attempt = connect().finally(() => {
      connecting = undefined
    })
    connecting = attempt
    return attempt
  }

  return {
    name,
    config,
    status: () => client?.status() ?? "never-connected",
    ensureConnected,

    async listTools() {
      const connected = await ensureConnected()
      if (!connected.ok) return connected
      return connected.client.listTools()
    },

    async callTool(toolName, args) {
      const connected = await ensureConnected()
      if (!connected.ok) return connected
      return connected.client.callTool(toolName, args)
    },

    async close() {
      if (client) await client.close()
      client = undefined
    },
  }
}
