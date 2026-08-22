import type { Tool, ToolContext, ToolResult } from "../types/tool.ts"
import type { McpToolSchema } from "./client.ts"
import type { McpServerConnection } from "./connection.ts"
import { inputSchemaToZod } from "./jsonSchema.ts"

/** Output enters the model's context — clip it the same way bash does. */
const MAX_OUTPUT_CHARS = 10_000

/** id 'mcp__<server>__<tool>' — the model-visible identity of a bridged tool. */
export function mcpToolID(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
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
): Tool[] {
  return schemas.map((schema): Tool => {
    const id = mcpToolID(serverName, schema.name)
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
          output: truncate(result.isError ? `Error: ${text}` : text),
          metadata: { server: serverName, tool: schema.name },
        }
      },
    }
  })
}
