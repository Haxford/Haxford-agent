/**
 * MCP (Model Context Protocol) client: stdio servers, bridged into our Tool
 * shape. Owned end-to-end by this directory — nothing outside src/mcp/ is
 * wired to it yet; `startMcp` plus the exports below are the seam a future
 * host (src/index.ts) and a future `/mcp` TUI command hook into. See the
 * doc comment on `startMcp` for exactly how.
 */

import type { Tool } from "../types/tool.ts"
import { loadMcpConfig } from "./config.ts"
import { createMcpServerConnection, type McpServerConnection } from "./connection.ts"
import { bridgeMcpTools } from "./bridge.ts"

export type { McpConfig, McpServerConfig, LoadedMcpConfig } from "./config.ts"
export { loadMcpConfig } from "./config.ts"
export type {
  McpClient,
  McpConnectionStatus,
  McpResult,
  McpServerInfo,
  McpToolSchema,
} from "./client.ts"
export { connectMcpServer, MCP_PROTOCOL_VERSION } from "./client.ts"
export type { McpServerConnection, McpServerStatus } from "./connection.ts"
export { createMcpServerConnection } from "./connection.ts"
export { bridgeMcpTools, mcpToolID } from "./bridge.ts"

export interface McpStartupResult {
  /** One connection per configured server, whatever its status ended up as. */
  connections: McpServerConnection[]
  /** Tools bridged from every server that connected and listed successfully at startup. */
  tools: Tool[]
  /** Config problems and connect/list failures, as user-facing strings — never a throw. */
  warnings: string[]
}

/**
 * Load `.haxford/mcp.json` (+ `~/.haxford/mcp.json`) and, when `autoStart` is
 * true (the default), eagerly connect every configured server and bridge its
 * tools.
 *
 * A server that fails to connect or list tools contributes a warning and no
 * tools, but still gets a `McpServerConnection` in `connections` — retry it
 * with `connection.ensureConnected()`. A server with `autoStart: false` gets
 * a connection too, but is never spawned here: it contributes no tools until
 * something calls `connection.listTools()` (which connects lazily) and
 * bridges the result with `bridgeMcpTools(name, connection, tools)`.
 *
 * SEAM for a future `/mcp` TUI command:
 *   - list servers + live status:  `result.connections.map(c => ({ name: c.name, status: c.status() }))`
 *   - reconnect / manually start:  `await connection.ensureConnected()`
 *   - (re)discover + bridge tools: `bridgeMcpTools(connection.name, connection, (await connection.listTools()).tools)`
 *     then merge the returned `Tool[]` into the live tool set (e.g. append
 *     to what `allTools()` returns before building the run's tool list).
 *   - disconnect one server:       `await connection.close()`
 * A crashed server's connection self-heals: `ensureConnected`/`listTools`/
 * `callTool` all reconnect lazily, so a bridged tool's `execute` never needs
 * the host to notice a crash and intervene.
 *
 * SEAM for src/index.ts wiring:
 *   `const mcp = await startMcp(cwd)` once at startup, then merge
 *   `mcp.tools` into the tool list passed to `runAgentLoop` (e.g.
 *   `[...allTools(), ...mcp.tools]`), and surface `mcp.warnings` the same
 *   way `loadConfig`'s `warnings` are surfaced today. Hold onto
 *   `mcp.connections` for the `/mcp` command above and to `close()` them on
 *   exit.
 */
export async function startMcp(cwd: string): Promise<McpStartupResult> {
  const { config, warnings } = await loadMcpConfig(cwd)
  const connections: McpServerConnection[] = []
  const tools: Tool[] = []

  for (const [name, serverConfig] of Object.entries(config.mcpServers)) {
    const connection = createMcpServerConnection(name, serverConfig, { cwd })
    connections.push(connection)
    if (!config.autoStart) continue

    const listed = await connection.listTools()
    if (!listed.ok) {
      warnings.push(`mcp server ${JSON.stringify(name)}: ${listed.error}`)
      continue
    }
    tools.push(...bridgeMcpTools(name, connection, listed.tools))
  }

  return { connections, tools, warnings }
}
