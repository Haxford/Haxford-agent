#!/usr/bin/env bun
/**
 * Fake MCP stdio server for tests/mcp.test.ts.
 *
 * Speaks newline-delimited JSON-RPC 2.0 (the real MCP stdio framing — see
 * src/mcp/client.ts). Supports just enough of the protocol to exercise the
 * client: initialize, tools/list (one "echo" tool), tools/call ("echo"
 * round-trips its `text` argument; "boom" tool responds with isError: true;
 * "crash" tool exits the process without replying, to test crash isolation).
 */

function reply(id: unknown, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`)
}

function fail(id: unknown, message: string): void {
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message } })}\n`,
  )
}

let buffer = ""
process.stdin.on("data", (chunk: Buffer) => {
  buffer += chunk.toString("utf8")
  let nl = buffer.indexOf("\n")
  while (nl !== -1) {
    const line = buffer.slice(0, nl).trim()
    buffer = buffer.slice(nl + 1)
    if (line.length > 0) handleLine(line)
    nl = buffer.indexOf("\n")
  }
})

function handleLine(line: string): void {
  let msg: { id?: unknown; method?: string; params?: Record<string, unknown> }
  try {
    msg = JSON.parse(line)
  } catch {
    return
  }
  const { id, method, params } = msg

  if (method === "initialize") {
    reply(id, {
      protocolVersion: "2024-11-05",
      capabilities: {},
      serverInfo: { name: "fake-mcp-server", version: "1.2.3" },
    })
    return
  }
  if (method === "notifications/initialized") return // no reply expected

  if (method === "tools/list") {
    reply(id, {
      tools: [
        {
          name: "echo",
          description: "Echo back the given text.",
          inputSchema: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
        {
          name: "boom",
          description: "Always returns an MCP-level tool error.",
          inputSchema: { type: "object", properties: {} },
        },
        {
          name: "crash",
          description: "Exits the process without replying.",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    })
    return
  }

  if (method === "tools/call") {
    const name = params?.["name"]
    const args = (params?.["arguments"] ?? {}) as Record<string, unknown>
    if (name === "echo") {
      reply(id, { content: [{ type: "text", text: String(args["text"] ?? "") }], isError: false })
      return
    }
    if (name === "boom") {
      reply(id, { content: [{ type: "text", text: "something went wrong" }], isError: true })
      return
    }
    if (name === "crash") {
      process.exit(1)
    }
    fail(id, `unknown tool ${JSON.stringify(name)}`)
    return
  }

  if (id !== undefined) fail(id, `unknown method ${JSON.stringify(method)}`)
}
