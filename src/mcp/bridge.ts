import type { Tool, ToolContext, ToolResult } from "../types/tool.ts"
import type { McpToolSchema } from "./client.ts"
import type { McpServerConnection } from "./connection.ts"
import { redactSecrets } from "../config/secrets.ts"
import { inputSchemaToZod } from "./jsonSchema.ts"

/** Output enters the model's context — clip it the same way bash does. */
const MAX_OUTPUT_CHARS = 10_000

/** id 'mcp__<server>__<tool>' — the model-visible identity of a bridged tool. */
export function mcpToolID(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}

/**
 * Longest id a provider will accept. Anthropic and OpenAI both cap tool names
 * at 64 characters and reject the whole request — not just the one tool — if
 * any name is over it.
 */
const MAX_TOOL_ID_LENGTH = 64

/** What a provider accepts in a tool name, and what a rule pattern can name. */
const SAFE_TOOL_ID = /^[A-Za-z0-9_-]+$/

/**
 * Whether a bridged id is fit to send to a provider and to gate on.
 *
 * Tool *names* come from the server, which is the one component here nobody
 * audited. A name with a space, a newline, a slash, or 300 characters
 * produces an id that the provider rejects — and because the tool list is
 * sent whole, one bad name from one server fails every request for the whole
 * session, not just calls to that tool. Names are validated rather than
 * mangled: silently rewriting one would mean the id the user approves and the
 * id in their rules no longer match what the server calls itself.
 */
export function isBridgeableToolName(serverName: string, toolName: string): boolean {
  // An empty name produces the well-formed-looking id `mcp__srv__`, which
  // would then be called as `tools/call {name: ""}`. Check the name itself,
  // not only the id it happens to render into.
  if (toolName.trim().length === 0) return false
  const id = mcpToolID(serverName, toolName)
  return id.length <= MAX_TOOL_ID_LENGTH && SAFE_TOOL_ID.test(id)
}

/** Render an MCP `tools/call` result's content blocks as model-visible text. */
function contentToText(content: unknown[]): string {
  const parts: string[] = []
  for (const block of content) {
    if (block && typeof block === "object" && !Array.isArray(block)) {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === "text" && typeof b.text === "string") {
        parts.push(b.text)
        continue
      }
      if (typeof b.type === "string") {
        parts.push(`[${b.type} content omitted]`)
        continue
      }
    }
    parts.push(String(block))
  }
  return parts.join("\n")
}

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return (
    `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n` +
    `[Output truncated to ${MAX_OUTPUT_CHARS} of ${text.length} characters.]`
  )
}

/**
 * Bridge one MCP server's tool schemas into our `Tool` shape.
 *
 * Each call routes through `ctx.askPermission` exactly like a native tool.
 * The permission engine has no notion of MCP — an id it has never heard of
 * defaults to "ask" (see `toolDefault` in `src/permission/engine.ts`), which
 * is the correct default posture for an arbitrary MCP server action.
 */
export function bridgeMcpTools(
  serverName: string,
  connection: McpServerConnection,
  schemas: McpToolSchema[],
  /** Names rejected as unusable ids, for the caller to surface as warnings. */
  rejected?: string[],
): Tool[] {
  const tools: Tool[] = []
  const seen = new Set<string>()
  for (const schema of schemas) {
    const id = mcpToolID(serverName, schema.name)
    if (!isBridgeableToolName(serverName, schema.name)) {
      rejected?.push(
        `mcp server ${JSON.stringify(serverName)}: tool ${JSON.stringify(schema.name)} ` +
          `has no usable id (${JSON.stringify(id.slice(0, 80))}) — skipped`,
      )
      continue
    }
    // Two tools claiming one id would silently shadow each other in the tool
    // set; keep the first and say so.
    if (seen.has(id)) {
      rejected?.push(
        `mcp server ${JSON.stringify(serverName)}: duplicate tool ${JSON.stringify(schema.name)} — skipped`,
      )
      continue
    }
    seen.add(id)
    tools.push(bridgeOne(serverName, connection, schema, id))
  }
  return tools
}

function bridgeOne(
  serverName: string,
  connection: McpServerConnection,
  schema: McpToolSchema,
  id: string,
): Tool {
  return {
    id,
    description:
      schema.description?.trim() ||
      `Call the "${schema.name}" tool on the "${serverName}" MCP server.`,
    parameters: inputSchemaToZod(schema.inputSchema),
    async execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
      const decision = await ctx.askPermission({
        tool: id,
        args,
        title: `${serverName}: ${schema.name}`,
        sessionID: ctx.sessionID,
      })
      if (decision === "deny") {
        return {
          title: schema.name,
          output: "The user declined to run this tool. It was not called.",
        }
      }

      const result = await connection.callTool(schema.name, args)
      if (!result.ok) {
        return {
          title: `${schema.name} (failed)`,
          output: `MCP call failed: ${result.error}`,
        }
      }

      const text = contentToText(result.content) || "(no output)"
      return {
        title: result.isError ? `${schema.name} (error)` : schema.name,
        output: truncate(redactSecrets(result.isError ? `Error: ${text}` : text)),
        metadata: { server: serverName, tool: schema.name },
      }
    },
  }
}
