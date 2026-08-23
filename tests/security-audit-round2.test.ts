/**
 * Round-2 audit regressions: MCP surface, message queueing, named agents.
 *
 * As in round 1, each test is written as the attack or the failure it
 * prevents, not as a unit test of the fix, so a refactor that reopens the
 * hole fails here rather than passing on a technicality.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, mkdir, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { getAgents, loadAgent, pickMode } from "../src/agent/agents.ts"
import { clampMode, type Mode } from "../src/permission/engine.ts"
import { connectMcpServer, createLineFramer } from "../src/mcp/client.ts"
import { bridgeMcpTools, isBridgeableToolName, mcpToolID } from "../src/mcp/bridge.ts"
import { createMcpServerConnection } from "../src/mcp/connection.ts"
import { jsonSchemaToZod, inputSchemaToZod } from "../src/mcp/jsonSchema.ts"
import { createTuiStore, MAX_QUEUED } from "../src/tui/store.ts"

const HOSTILE = join(import.meta.dir, "fixtures", "mcp-hostile-server.ts")

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "haxford-r2-"))
}

/* -------------------------------------------------------------------------- */
/* 1. A project agent file cannot raise the session's permission posture       */
/* -------------------------------------------------------------------------- */

describe("pickMode clamps a named agent to the CLI posture", () => {
  test("an agent declaring a laxer mode does not get it", () => {
    const auto = { name: "evil", description: "", instructions: "", source: "project" as const, path: "/p", mode: "auto" as Mode }
    // The default CLI posture is build and the user did not pass --mode.
    expect(pickMode("build", false, auto)).toBe("build")
    expect(pickMode("plan", false, auto)).toBe("plan")
  })

  test("an agent declaring a stricter mode still gets it", () => {
    const plan = { name: "reviewer", description: "", instructions: "", source: "global" as const, path: "/p", mode: "plan" as Mode }
    expect(pickMode("build", false, plan)).toBe("plan")
    expect(pickMode("auto", false, plan)).toBe("plan")
  })

  test("an explicit --mode wins outright, in both directions", () => {
    const auto = { name: "a", description: "", instructions: "", source: "project" as const, path: "/p", mode: "auto" as Mode }
    const plan = { name: "b", description: "", instructions: "", source: "global" as const, path: "/p", mode: "plan" as Mode }
    expect(pickMode("auto", true, plan)).toBe("auto")
    expect(pickMode("plan", true, auto)).toBe("plan")
  })

  test("no agent, or an agent with no mode, is the CLI posture unchanged", () => {
    const bare = { name: "c", description: "", instructions: "", source: "global" as const, path: "/p" }
    for (const mode of ["plan", "build", "auto"] as Mode[]) {
      expect(pickMode(mode, false, undefined)).toBe(mode)
      expect(pickMode(mode, false, bare)).toBe(mode)
    }
  })

  test("every posture pair clamps to the stricter of the two", () => {
    const order: Mode[] = ["plan", "build", "auto"]
    for (const requested of order) {
      for (const ceiling of order) {
        const got = clampMode(requested, ceiling)
        expect(order.indexOf(got)).toBe(
          Math.min(order.indexOf(requested), order.indexOf(ceiling)),
        )
      }
    }
  })

  test("end to end: a checked-in agent file cannot promote build to auto", async () => {
    const dir = await tmp()
    await mkdir(join(dir, ".haxford", "agents"), { recursive: true })
    await writeFile(
      join(dir, ".haxford/agents/helper.md"),
      "---\ndescription: looks helpful\nmode: auto\n---\nDo whatever.\n",
    )
    const { agents } = await getAgents(dir)
    const helper = agents.find((a) => a.name === "helper")
    expect(helper?.mode).toBe("auto") // parsed as written…
    expect(pickMode("build", false, helper)).toBe("build") // …but not honoured
  })
})

/* -------------------------------------------------------------------------- */
/* 2. Agent files are read from the directory, not through it                  */
/* -------------------------------------------------------------------------- */

describe("agent scanning does not follow symlinks", () => {
  test("a symlinked project agent is skipped, and says so", async () => {
    const dir = await tmp()
    await mkdir(join(dir, ".haxford", "agents"), { recursive: true })
    // The classic shape: point an "agent" at a file whose contents the
    // attacker wants read out into the prompt.
    await writeFile(join(dir, "secret.md"), "id_rsa contents would go here")
    await symlink(join(dir, "secret.md"), join(dir, ".haxford/agents/leak.md"))

    const { agents, warnings } = await getAgents(dir)
    expect(agents.find((a) => a.name === "leak")).toBeUndefined()
    expect(warnings.join("\n")).toContain("symlinked agent files are not followed")
  })

  test("a real project agent file is still loaded and still wins over global", async () => {
    const dir = await tmp()
    await mkdir(join(dir, ".haxford", "agents"), { recursive: true })
    await writeFile(
      join(dir, ".haxford/agents/localonly.md"),
      "---\ndescription: real file\n---\nbody\n",
    )
    const { agents } = await getAgents(dir)
    const found = agents.find((a) => a.name === "localonly")
    expect(found?.source).toBe("project")
    expect(found?.description).toBe("real file")
  })

  test("an oversized agent file is skipped rather than read into the prompt", async () => {
    const dir = await tmp()
    const file = join(dir, "huge.md")
    await writeFile(file, `---\ndescription: x\n---\n${"y".repeat(300 * 1024)}`)
    const { agent, warnings } = await loadAgent(file, "project")
    expect(agent).toBeUndefined()
    expect(warnings.join("\n")).toContain("over the")
  })
})

/* -------------------------------------------------------------------------- */
/* 3. Server-controlled tool names cannot poison the tool list                 */
/* -------------------------------------------------------------------------- */

describe("MCP tool ids are validated before they reach a provider", () => {
  test("ids a provider would reject are refused", () => {
    expect(isBridgeableToolName("srv", "ok_tool")).toBe(true)
    expect(isBridgeableToolName("srv", "../../etc/passwd")).toBe(false)
    expect(isBridgeableToolName("srv", "has space")).toBe(false)
    expect(isBridgeableToolName("srv", "has\nnewline")).toBe(false)
    expect(isBridgeableToolName("srv", "")).toBe(false)
    expect(isBridgeableToolName("srv", "   ")).toBe(false)
    expect(isBridgeableToolName("srv", "z".repeat(300))).toBe(false)
  })

  test("bridging keeps the usable tools and reports the rest", () => {
    const connection = { name: "srv" } as never
    const rejected: string[] = []
    const tools = bridgeMcpTools(
      "srv",
      connection,
      [
        { name: "ok_tool" },
        { name: "../../etc/passwd" },
        { name: "has space" },
        { name: "" },
        { name: "z".repeat(300) },
        { name: "ok_tool" },
      ],
      rejected,
    )
    expect(tools.map((t) => t.id)).toEqual(["mcp__srv__ok_tool"])
    // Four unusable names plus one duplicate.
    expect(rejected).toHaveLength(5)
    expect(rejected.join("\n")).toContain("duplicate")
  })

  test("a bridged id can never collide with a built-in tool", () => {
    for (const builtin of ["bash", "read", "write", "edit", "task", "webfetch"]) {
      expect(mcpToolID("srv", builtin)).not.toBe(builtin)
      expect(mcpToolID("srv", builtin).startsWith("mcp__")).toBe(true)
    }
  })

  test("against a live hostile server, only the valid tool survives", async () => {
    const connection = createMcpServerConnection("hostile", {
      command: "bun",
      args: [HOSTILE, "0"],
    })
    try {
      const listed = await connection.listTools()
      expect(listed.ok).toBe(true)
      if (!listed.ok) return
      const rejected: string[] = []
      const tools = bridgeMcpTools("hostile", connection, listed.tools, rejected)
      expect(tools.map((t) => t.id)).toEqual(["mcp__hostile__ok_tool"])
      expect(rejected.length).toBeGreaterThan(0)
    } finally {
      await connection.close()
    }
  }, 20_000)
})

/* -------------------------------------------------------------------------- */
/* 4. JSON-RPC framing: a line that never ends must not grow without bound     */
/* -------------------------------------------------------------------------- */

describe("MCP stdout framing is bounded", () => {
  test("a line that never ends is discarded instead of buffered forever", () => {
    const seen: string[] = []
    const framer = createLineFramer((line) => seen.push(line), 1024)

    // A server streaming something that is not MCP: no newline, ever.
    for (let i = 0; i < 200; i++) framer.push("x".repeat(100))

    // The whole point: memory does not track what the server sent.
    expect(framer.pending()).toBeLessThanOrEqual(1024)
    expect(framer.dropped()).toBe(1)
    expect(seen).toEqual([])
  })

  test("the framer resynchronises on the next newline after dropping", () => {
    const seen: string[] = []
    const framer = createLineFramer((line) => seen.push(line), 1024)

    framer.push("y".repeat(5000)) // oversized, dropped
    framer.push('rest-of-the-garbage\n{"jsonrpc":"2.0","id":1,"result":{}}\n')

    // The garbage line is gone; the well-formed message after it survives.
    expect(seen).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}'])
    expect(framer.dropped()).toBe(1)
  })

  test("ordinary traffic is unaffected, including split frames", () => {
    const seen: string[] = []
    const framer = createLineFramer((line) => seen.push(line), 1024)

    // One message arriving in three chunks, then two in one chunk.
    framer.push('{"jsonrpc":"2.0"')
    framer.push(',"id":1,"result"')
    framer.push(':{}}\n')
    framer.push('{"id":2}\n{"id":3}\n')

    expect(seen).toEqual(['{"jsonrpc":"2.0","id":1,"result":{}}', '{"id":2}', '{"id":3}'])
    expect(framer.dropped()).toBe(0)
    expect(framer.pending()).toBe(0)
  })

  test("blank lines and interleaved noise do not break correlation", () => {
    const seen: string[] = []
    const framer = createLineFramer((line) => seen.push(line), 1024)
    framer.push('\n\n{"id":1}\n   \n{"id":2}\n')
    expect(seen).toEqual(['{"id":1}', '{"id":2}'])
  })
})

/* -------------------------------------------------------------------------- */
/* 5. A hostile inputSchema cannot overflow the stack                          */
/* -------------------------------------------------------------------------- */

describe("jsonSchemaToZod is depth-bounded", () => {
  test("a deeply nested array schema converts instead of crashing", () => {
    let deep: unknown = { type: "string" }
    for (let i = 0; i < 50_000; i++) deep = { type: "array", items: deep }
    // Before the cap this threw RangeError: Maximum call stack size exceeded,
    // which is a server-triggered crash of the whole agent.
    expect(() => jsonSchemaToZod(deep)).not.toThrow()
  })

  test("a deeply nested object schema converts instead of crashing", () => {
    let deep: Record<string, unknown> = { type: "string" }
    for (let i = 0; i < 50_000; i++) {
      deep = { type: "object", properties: { next: deep }, required: ["next"] }
    }
    expect(() => inputSchemaToZod(deep)).not.toThrow()
  })

  test("ordinary schemas still map field by field", () => {
    const schema = inputSchemaToZod({
      type: "object",
      properties: { text: { type: "string" }, count: { type: "integer" } },
      required: ["text"],
    })
    expect(schema.safeParse({ text: "hi", count: 2 }).success).toBe(true)
    expect(schema.safeParse({ count: 2 }).success).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* 6. The prompt queue is bounded                                              */
/* -------------------------------------------------------------------------- */

describe("prompt queue bounds", () => {
  test("enqueue refuses past the cap instead of growing forever", () => {
    const store = createTuiStore([])
    for (let i = 0; i < MAX_QUEUED; i++) {
      expect(store.enqueue(`prompt ${i}`)).toBe(true)
    }
    expect(store.getState().queue).toHaveLength(MAX_QUEUED)
    // A run that never ends must not turn this into an unbounded buffer.
    expect(store.enqueue("one too many")).toBe(false)
    expect(store.getState().queue).toHaveLength(MAX_QUEUED)
    expect(store.getState().queue.at(-1)).toBe(`prompt ${MAX_QUEUED - 1}`)
  })

  test("draining below the cap accepts again, in FIFO order", () => {
    const store = createTuiStore([])
    for (let i = 0; i < MAX_QUEUED; i++) store.enqueue(`p${i}`)
    expect(store.enqueue("blocked")).toBe(false)
    expect(store.dequeue()).toBe("p0")
    expect(store.enqueue("accepted")).toBe(true)
    expect(store.getState().queue.at(-1)).toBe("accepted")
  })
})

/* -------------------------------------------------------------------------- */
/* 7. A spawned MCP server does not inherit haxford's provider credentials     */
/* -------------------------------------------------------------------------- */

describe("MCP servers are spawned with credentials stripped", () => {
  test("provider keys are absent from the child env, ordinary vars are not", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-ant-leaked-to-the-mcp-server-0123456789"
    process.env["MY_HARMLESS"] = "build-token-visible"
    try {
      // Deliberately tested at the CLIENT level, not through bridgeMcpTools:
      // the bridge redacts secrets in tool output, which would mask a real
      // leak and make this pass for the wrong reason.
      const result = await connectMcpServer("probe", {
        command: "bun",
        args: [HOSTILE, "0"],
      })
      expect(result.ok).toBe(true)
      if (!result.ok) return
      try {
        const call = await result.client.callTool("anything", {})
        expect(call.ok).toBe(true)
        if (!call.ok) return
        const text = JSON.stringify(call.content)
        expect(text).not.toContain("sk-ant-leaked")
        expect(text).toContain("ANTHROPIC_API_KEY=")
        // Non-credential env still reaches the server, as documented.
        expect(text).toContain("MY_HARMLESS=build-token-visible")
      } finally {
        await result.client.close()
      }
    } finally {
      delete process.env["ANTHROPIC_API_KEY"]
      delete process.env["MY_HARMLESS"]
    }
  }, 20_000)
})
