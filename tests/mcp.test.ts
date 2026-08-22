import { afterEach, describe, expect, test } from "bun:test"
import { join } from "node:path"

import { bridgeMcpTools, mcpToolID } from "../src/mcp/bridge.ts"
import { connectMcpServer, type McpClient } from "../src/mcp/client.ts"
import { loadMcpConfig } from "../src/mcp/config.ts"
import { createMcpServerConnection } from "../src/mcp/connection.ts"
import { startMcp } from "../src/mcp/index.ts"
import type { PermissionRequest, ToolContext } from "../src/types/tool.ts"

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-fake-server.ts")
const FAKE_SERVER = { command: "bun", args: [FIXTURE] }

function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: `s-${crypto.randomUUID()}`,
    agent: "test",
    cwd: process.cwd(),
    abort: new AbortController().signal,
    askPermission: async () => "allow",
    ...overrides,
  }
}

async function tmpdir(): Promise<string> {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-mcp-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, "")
  return dir
}

const liveClients: McpClient[] = []
afterEach(async () => {
  await Promise.all(liveClients.splice(0).map((c) => c.close()))
})

async function connectFake(): Promise<McpClient> {
  const result = await connectMcpServer("fake", FAKE_SERVER)
  if (!result.ok) throw new Error(`fake server failed to connect: ${result.error}`)
  liveClients.push(result.client)
  return result.client
}

/* -------------------------------------------------------------------------- */
/* config                                                                      */
/* -------------------------------------------------------------------------- */

describe("loadMcpConfig", () => {
  test("returns an empty, autoStart:true config when no file exists", async () => {
    const dir = await tmpdir()
    const { config, warnings } = await loadMcpConfig(dir)
    expect(config.mcpServers).toEqual({})
    expect(config.autoStart).toBe(true)
    expect(warnings).toEqual([])
  })

  test("parses a valid project-local mcp.json", async () => {
    const dir = await tmpdir()
    await Bun.write(
      join(dir, ".haxford", "mcp.json"),
      JSON.stringify({
        mcpServers: { fake: { command: "bun", args: ["server.ts"], env: { X: "1" } } },
        autoStart: false,
      }),
    )
    const { config, warnings } = await loadMcpConfig(dir)
    expect(warnings).toEqual([])
    expect(config.autoStart).toBe(false)
    expect(config.mcpServers["fake"]).toEqual({ command: "bun", args: ["server.ts"], env: { X: "1" } })
  })

  test("bad entries become warnings, not throws, and are dropped", async () => {
    const dir = await tmpdir()
    await Bun.write(
      join(dir, ".haxford", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          good: { command: "bun" },
          missingCommand: { args: ["x"] },
          badArgs: { command: "bun", args: "not-an-array" },
        },
      }),
    )
    const { config, warnings } = await loadMcpConfig(dir)
    expect(Object.keys(config.mcpServers)).toEqual(["good"])
    expect(warnings.length).toBe(2)
    expect(warnings.some((w) => w.includes("missingCommand"))).toBe(true)
    expect(warnings.some((w) => w.includes("badArgs"))).toBe(true)
  })

  test("malformed JSON is a warning, not a throw", async () => {
    const dir = await tmpdir()
    await Bun.write(join(dir, ".haxford", "mcp.json"), "{ not json")
    const { config, warnings } = await loadMcpConfig(dir)
    expect(config.mcpServers).toEqual({})
    expect(warnings.length).toBe(1)
  })

  test("project config wins over global per server name; global home comes from HOME", async () => {
    const home = await tmpdir()
    const project = await tmpdir()
    await Bun.write(
      join(home, ".haxford", "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "global-a" }, b: { command: "global-b" } }, autoStart: false }),
    )
    await Bun.write(
      join(project, ".haxford", "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "project-a" } } }),
    )
    const prevHome = Bun.env.HOME
    Bun.env.HOME = home
    try {
      const { config } = await loadMcpConfig(project)
      // project overrides "a", "b" survives from global, autoStart falls
      // back to the global layer since the project layer does not set it.
      expect(config.mcpServers["a"]?.command).toBe("project-a")
      expect(config.mcpServers["b"]?.command).toBe("global-b")
      expect(config.autoStart).toBe(false)
    } finally {
      Bun.env.HOME = prevHome
    }
  })
})

/* -------------------------------------------------------------------------- */
/* client: handshake, list, call, timeout                                     */
/* -------------------------------------------------------------------------- */

describe("connectMcpServer", () => {
  test("completes the initialize handshake and reports server info", async () => {
    const client = await connectFake()
    expect(client.status()).toBe("connected")
    expect(client.serverInfo()).toEqual({ name: "fake-mcp-server", version: "1.2.3" })
  })

  test("tools/list returns the server's tools", async () => {
    const client = await connectFake()
    const result = await client.listTools()
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.tools.map((t) => t.name).sort()).toEqual(["boom", "crash", "echo"])
    const echo = result.tools.find((t) => t.name === "echo")
    expect(echo?.description).toBe("Echo back the given text.")
    expect(echo?.inputSchema).toMatchObject({ type: "object" })
  })

  test("tools/call round-trips arguments through the fake server", async () => {
    const client = await connectFake()
    const result = await client.callTool("echo", { text: "hello mcp" })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.isError).toBe(false)
    expect(result.content).toEqual([{ type: "text", text: "hello mcp" }])
  })

  test("a tool-level error round-trips isError: true", async () => {
    const client = await connectFake()
    const result = await client.callTool("boom", {})
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.isError).toBe(true)
  })

  test("spawning a nonexistent command fails cleanly, not a throw", async () => {
    const result = await connectMcpServer("nope", { command: "this-binary-does-not-exist-xyz" })
    expect(result.ok).toBe(false)
  })

  test("a request that never gets a reply times out rather than hanging", async () => {
    // A server that never speaks JSON-RPC at all (initialize never answered).
    const result = await connectMcpServer("silent", { command: "sleep", args: ["30"] }, { timeoutMs: 200 })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.toLowerCase()).toContain("timed out")
  }, 5000)
})

/* -------------------------------------------------------------------------- */
/* crash isolation + lazy reconnect                                           */
/* -------------------------------------------------------------------------- */

describe("crash isolation", () => {
  test("a server crash disconnects the client cleanly and fires onDisconnect", async () => {
    const client = await connectFake()
    let disconnected: string | undefined
    client.onDisconnect((reason) => {
      disconnected = reason
    })

    // The "crash" tool exits without replying; callTool must resolve (not hang).
    const result = await client.callTool("crash", {})
    expect(result.ok).toBe(false)

    // Give the exit handler a tick to run.
    await new Promise((r) => setTimeout(r, 100))
    expect(client.status()).toBe("disconnected")
    expect(disconnected).toBeDefined()
  })

  test("McpServerConnection reconnects lazily after a crash", async () => {
    const connection = createMcpServerConnection("fake", FAKE_SERVER)
    expect(connection.status()).toBe("never-connected")

    const first = await connection.listTools()
    expect(first.ok).toBe(true)
    expect(connection.status()).toBe("connected")

    const crashed = await connection.callTool("crash", {})
    expect(crashed.ok).toBe(false)
    await new Promise((r) => setTimeout(r, 100))
    expect(connection.status()).toBe("disconnected")

    // The next call reconnects on its own — a fresh process, same config.
    const after = await connection.callTool("echo", { text: "still alive" })
    expect(after.ok).toBe(true)
    if (after.ok) expect(after.content).toEqual([{ type: "text", text: "still alive" }])
    expect(connection.status()).toBe("connected")

    await connection.close()
  })

  test("concurrent ensureConnected calls share one in-flight connect", async () => {
    const connection = createMcpServerConnection("fake", FAKE_SERVER)
    const [a, b] = await Promise.all([connection.ensureConnected(), connection.ensureConnected()])
    expect(a.ok && b.ok).toBe(true)
    if (a.ok && b.ok) expect(a.client).toBe(b.client)
    await connection.close()
  })
})

/* -------------------------------------------------------------------------- */
/* bridge: id shape, schema mapping, permission gate, truncation              */
/* -------------------------------------------------------------------------- */

describe("bridgeMcpTools", () => {
  test("mcpToolID has the documented shape", () => {
    expect(mcpToolID("fake", "echo")).toBe("mcp__fake__echo")
  })

  test("bridged tools carry the right id, description and best-effort zod schema", async () => {
    const connection = createMcpServerConnection("fake", FAKE_SERVER)
    const listed = await connection.listTools()
    expect(listed.ok).toBe(true)
    if (!listed.ok) return

    const tools = bridgeMcpTools("fake", connection, listed.tools)
    const echo = tools.find((t) => t.id === "mcp__fake__echo")
    expect(echo).toBeDefined()
    expect(echo?.description).toBe("Echo back the given text.")

    const parsed = echo?.parameters.safeParse({ text: "hi" })
    expect(parsed?.success).toBe(true)
    const rejected = echo?.parameters.safeParse({ text: 5 })
    expect(rejected?.success).toBe(false)

    await connection.close()
  })

  test("a tool call routes through ctx.askPermission with the bridged id", async () => {
    const connection = createMcpServerConnection("fake", FAKE_SERVER)
    const listed = await connection.listTools()
    if (!listed.ok) throw new Error("listTools failed")
    const [echo] = bridgeMcpTools("fake", connection, listed.tools.filter((t) => t.name === "echo"))
    if (!echo) throw new Error("echo tool missing")

    const seen: PermissionRequest[] = []
    const result = await echo.execute(
      { text: "gated" },
      ctx({
        askPermission: async (req) => {
          seen.push(req)
          return "allow"
        },
      }),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.tool).toBe("mcp__fake__echo")
    expect(result.output).toBe("gated")

    await connection.close()
  })

  test("a denied permission short-circuits without calling the server", async () => {
    // A spy connection, not the real fake server: proves callTool is never
    // invoked, which "the connection never happened" would only imply.
    let called = false
    const spy = {
      name: "fake",
      config: FAKE_SERVER,
      status: () => "connected" as const,
      ensureConnected: async () => ({ ok: true as const, client: undefined as never }),
      listTools: async () => ({ ok: true as const, tools: [] }),
      callTool: async () => {
        called = true
        return { ok: true as const, content: [], isError: false }
      },
      close: async () => {},
    }
    const [echo] = bridgeMcpTools("fake", spy, [{ name: "echo", description: "Echo back the given text." }])
    if (!echo) throw new Error("echo tool missing")

    const result = await echo.execute({ text: "nope" }, ctx({ askPermission: async () => "deny" }))
    expect(result.output).toContain("declined")
    expect(called).toBe(false)
  })

  test("an MCP tool-level error is surfaced as an error-titled result", async () => {
    const connection = createMcpServerConnection("fake", FAKE_SERVER)
    const listed = await connection.listTools()
    if (!listed.ok) throw new Error("listTools failed")
    const [boom] = bridgeMcpTools("fake", connection, listed.tools.filter((t) => t.name === "boom"))
    if (!boom) throw new Error("boom tool missing")

    const result = await boom.execute({}, ctx())
    expect(result.title).toContain("error")
    expect(result.output).toContain("something went wrong")
    await connection.close()
  })

  test("long output is truncated with a note", async () => {
    // Bridge a synthetic connection whose callTool returns oversized content,
    // without needing the fake server to generate 10k+ characters itself.
    const longText = "x".repeat(11_000)
    const fakeConnection = {
      name: "fake",
      config: FAKE_SERVER,
      status: () => "connected" as const,
      ensureConnected: async () => ({ ok: true as const, client: undefined as never }),
      listTools: async () => ({ ok: true as const, tools: [] }),
      callTool: async () => ({ ok: true as const, content: [{ type: "text", text: longText }], isError: false }),
      close: async () => {},
    }
    const [tool] = bridgeMcpTools("fake", fakeConnection, [{ name: "big" }])
    if (!tool) throw new Error("tool missing")
    const result = await tool.execute({}, ctx())
    expect(result.output.length).toBeLessThan(longText.length)
    expect(result.output).toContain("truncated")
  })
})

/* -------------------------------------------------------------------------- */
/* startMcp: end-to-end startup orchestration                                 */
/* -------------------------------------------------------------------------- */

describe("startMcp", () => {
  test("eagerly connects and bridges tools when autoStart is true (default)", async () => {
    const dir = await tmpdir()
    await Bun.write(
      join(dir, ".haxford", "mcp.json"),
      JSON.stringify({ mcpServers: { fake: FAKE_SERVER } }),
    )
    const result = await startMcp(dir)
    expect(result.warnings).toEqual([])
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]?.status()).toBe("connected")
    expect(result.tools.map((t) => t.id).sort()).toEqual([
      "mcp__fake__boom",
      "mcp__fake__crash",
      "mcp__fake__echo",
    ])
    await Promise.all(result.connections.map((c) => c.close()))
  })

  test("does not connect when autoStart is false, and contributes no tools", async () => {
    const dir = await tmpdir()
    await Bun.write(
      join(dir, ".haxford", "mcp.json"),
      JSON.stringify({ mcpServers: { fake: FAKE_SERVER }, autoStart: false }),
    )
    const result = await startMcp(dir)
    expect(result.tools).toEqual([])
    expect(result.connections).toHaveLength(1)
    expect(result.connections[0]?.status()).toBe("never-connected")

    // The seam for a future /mcp command: connect + list + bridge on demand.
    const listed = await result.connections[0]!.listTools()
    expect(listed.ok).toBe(true)
    await Promise.all(result.connections.map((c) => c.close()))
  })

  test("a server that fails to connect becomes a warning, not a thrown error", async () => {
    const dir = await tmpdir()
    await Bun.write(
      join(dir, ".haxford", "mcp.json"),
      JSON.stringify({ mcpServers: { broken: { command: "this-binary-does-not-exist-xyz" } } }),
    )
    const result = await startMcp(dir)
    expect(result.tools).toEqual([])
    expect(result.warnings.length).toBe(1)
    expect(result.warnings[0]).toContain("broken")
  })
})

/* -------------------------------------------------------------------------- */
/* optional: real server, if the network/npm cache makes it available         */
/* -------------------------------------------------------------------------- */

describe("real @modelcontextprotocol/server-everything", () => {
  test("handshake + tools/list against the real reference server, if reachable", async () => {
    const result = await connectMcpServer(
      "everything",
      { command: "npx", args: ["-y", "@modelcontextprotocol/server-everything"] },
      { timeoutMs: 15_000 },
    )
    if (!result.ok) {
      console.warn(`[mcp.test] skipping real-server assertions: ${result.error}`)
      return
    }
    liveClients.push(result.client)
    expect(result.client.status()).toBe("connected")
    const tools = await result.client.listTools()
    expect(tools.ok).toBe(true)
    if (tools.ok) expect(tools.tools.length).toBeGreaterThan(0)
  }, 20_000)
})
