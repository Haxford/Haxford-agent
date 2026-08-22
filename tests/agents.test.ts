import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"

import {
  BUILTIN_AGENTS,
  DEFAULT_AGENT_NAME,
  ensureBuiltinAgents,
  filterToolsByAllowlist,
  getAgents,
  globalAgentsDir,
  loadAgent,
  parseToolList,
  pickMode,
  pickModel,
  projectAgentsDir,
  resolveAgent,
  type NamedAgent,
} from "../src/agent/agents.ts"
import { parseFrontmatterFields } from "../src/extend/skills.ts"
import { runAgentLoop } from "../src/agent/loop.ts"
import { createAskHandler } from "../src/permission/engine.ts"
import { allTools, taskTool } from "../src/tools/index.ts"
import type { Tool } from "../src/types/tool.ts"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const TMP = process.env["TMPDIR"] ?? "/tmp"

let home: string
let project: string
let oldHome: string | undefined

beforeEach(async () => {
  home = path.join(TMP, `haxford-agents-${crypto.randomUUID()}`)
  project = path.join(TMP, `haxford-agents-proj-${crypto.randomUUID()}`)
  oldHome = process.env["HAXFORD_HOME"]
  process.env["HAXFORD_HOME"] = home
  await Bun.write(path.join(home, ".keep"), "")
  await Bun.write(path.join(project, ".keep"), "")
})

afterEach(async () => {
  if (oldHome === undefined) delete process.env["HAXFORD_HOME"]
  else process.env["HAXFORD_HOME"] = oldHome
  await rm(home, { recursive: true, force: true })
  await rm(project, { recursive: true, force: true })
})

/** Write a global agent file. */
async function globalAgent(name: string, body: string): Promise<void> {
  await Bun.write(path.join(home, "agents", name.endsWith(".md") ? name : `${name}.md`), body)
}

/** Write a project agent file. */
async function projectAgent(name: string, body: string): Promise<void> {
  await Bun.write(
    path.join(project, ".haxford", "agents", name.endsWith(".md") ? name : `${name}.md`),
    body,
  )
}

const REVIEWER_MD = `---
description: Review code for correctness and quality.
mode: plan
tools: read, glob, grep
---

REVIEWER-ADDENDUM-MARKER
Report findings, never fix them.
`

/* -------------------------------------------------------------------------- */
/* Frontmatter                                                                 */
/* -------------------------------------------------------------------------- */

describe("frontmatter fields", () => {
  test("the shared parser reads every one-line key", () => {
    const fields = parseFrontmatterFields(
      '---\ndescription: "Review code"\nmode: plan\ntools: read, grep\n---\nbody',
    )
    expect(fields["description"]).toBe("Review code")
    expect(fields["mode"]).toBe("plan")
    expect(fields["tools"]).toBe("read, grep")
  })

  test("tool lists tolerate bracket and comma forms", () => {
    expect(parseToolList("read, grep")).toEqual(["read", "grep"])
    expect(parseToolList("[read, grep]")).toEqual(["read", "grep"])
    expect(parseToolList(" read ,  grep ")).toEqual(["read", "grep"])
    expect(parseToolList("")).toEqual([])
    expect(parseToolList("[ ]")).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Loading and validation                                                      */
/* -------------------------------------------------------------------------- */

describe("loading agent files", () => {
  test("frontmatter becomes config, body becomes the prompt addendum", async () => {
    const file = path.join(home, "agents", "reviewer.md")
    await Bun.write(file, REVIEWER_MD)

    const { agent, warnings } = await loadAgent(file, "global")

    expect(warnings).toEqual([])
    expect(agent?.name).toBe("reviewer")
    expect(agent?.description).toBe("Review code for correctness and quality.")
    expect(agent?.mode).toBe("plan")
    expect(agent?.tools).toEqual(["read", "glob", "grep"])
    expect(agent?.instructions).not.toContain("---")
    expect(agent?.instructions).toContain("REVIEWER-ADDENDUM-MARKER")
    expect(agent?.instructions).toContain("Report findings, never fix them.")
  })

  test("an unknown mode is dropped with a warning, not fatal", async () => {
    const file = path.join(home, "agents", "odd.md")
    await Bun.write(file, "---\nmode: yolo\n---\nbody\n")

    const { agent, warnings } = await loadAgent(file, "global")

    expect(agent?.mode).toBeUndefined()
    expect(warnings.join("\n")).toContain("yolo")
    expect(agent?.instructions).toBe("body")
  })

  test("a model without a provider prefix warns and is dropped", async () => {
    const file = path.join(home, "agents", "m.md")
    await Bun.write(file, "---\nmodel: just-a-model-id\n---\nbody\n")

    const { agent, warnings } = await loadAgent(file, "global")

    expect(agent?.model).toBeUndefined()
    expect(warnings.join("\n")).toContain("provider/spec")
  })

  test("an allowlist naming no tools warns instead of locking everything out", async () => {
    const file = path.join(home, "agents", "t.md")
    await Bun.write(file, "---\ntools: , ,\n---\nbody\n")

    const { agent, warnings } = await loadAgent(file, "global")

    expect(agent?.tools).toBeUndefined()
    expect(warnings.join("\n")).toContain("names no tools")
  })

  test("a body-only agent loads fine", async () => {
    const file = path.join(home, "agents", "plain.md")
    await Bun.write(file, "# Just instructions\nDo things well.\n")

    const { agent, warnings } = await loadAgent(file, "global")

    expect(warnings).toEqual([])
    expect(agent?.description).toBe("")
    expect(agent?.instructions).toContain("Do things well.")
  })

  test("an unreadable file becomes a warning, not a throw", async () => {
    const { warnings } = await loadAgent(path.join(home, "agents", "gone.md"), "global")
    expect(warnings.join("\n")).toContain("could not read")
  })
})

/* -------------------------------------------------------------------------- */
/* Precedence: project > global > default                                      */
/* -------------------------------------------------------------------------- */

describe("precedence", () => {
  test("a project agent shadows a same-named global one", async () => {
    await globalAgent("reviewer", "---\ndescription: global version\n---\nglobal body\n")
    await projectAgent("reviewer", "---\ndescription: project version\n---\nproject body\n")

    const { agents, warnings } = await getAgents(project)
    
    expect(warnings).toEqual([])
    expect(agents).toHaveLength(1)
    expect(agents[0]?.description).toBe("project version")
    expect(agents[0]?.source).toBe("project")
    expect(agents[0]?.instructions).toContain("project body")
  })

  test("both directories merge when names differ", async () => {
    await globalAgent("aaa-global", "---\ndescription: g\n---\n")
    await projectAgent("zzz-project", "---\ndescription: p\n---\n")

    const { agents } = await getAgents(project)
    expect(agents.map((a) => a.name)).toEqual(["aaa-global", "zzz-project"])
  })

  test("resolveAgent: default means none, unknown warns with the menu", async () => {
    await globalAgent("reviewer", REVIEWER_MD)

    const none = await resolveAgent(project, undefined)
    expect(none.agent).toBeUndefined()
    expect(await resolveAgent(project, DEFAULT_AGENT_NAME)).toEqual({ warnings: [] })

    const miss = await resolveAgent(project, "ghost")
    expect(miss.agent).toBeUndefined()
    expect(miss.warnings[0]).toContain("ghost")
    expect(miss.warnings[0]).toContain("reviewer")

    const hit = await resolveAgent(project, "REVIEWER")
    expect(hit.agent?.name).toBe("reviewer")
    expect(hit.agent?.source).toBe("global")
  })

  test("mode selection: explicit flag beats agent beats CLI default", () => {
    const agent = { mode: "plan" } as unknown as NamedAgent
    expect(pickMode("build", false, undefined)).toBe("build")
    expect(pickMode("build", false, agent)).toBe("plan")
    // An explicit --mode wins even over the agent file.
    expect(pickMode("build", true, agent)).toBe("build")
  })

  test("model chain: cli beats agent beats project/config/fallback", () => {
    const agent = { model: "anthropic/agent-model" } as unknown as NamedAgent
    expect(pickModel(undefined, "p/c", "proj/m", "cfg/m", "fb/d")).toBe("p/c")
    expect(pickModel(agent, undefined, "proj/m", "cfg/m", "fb/d")).toBe("anthropic/agent-model")
    expect(pickModel(undefined, undefined, "proj/m", "cfg/m", "fb/d")).toBe("proj/m")
    expect(pickModel(undefined, undefined, undefined, "cfg/m", "fb/d")).toBe("cfg/m")
    expect(pickModel(undefined, undefined, undefined, undefined, "fb/d")).toBe("fb/d")
  })

  test("the tool allowlist filters the live list, order preserved", () => {
    const tools: Tool[] = allTools()
    const reviewer = { tools: ["read", "grep", "no-such-tool"] } as unknown as NamedAgent

    expect(filterToolsByAllowlist(tools, undefined)).toBe(tools)
    const filtered = filterToolsByAllowlist(tools, reviewer)
    // Unknown allowlist entries match nothing — they cannot conjure a tool.
    expect(filtered.map((t) => t.id)).toEqual(
      tools.filter((t) => t.id === "read" || t.id === "grep").map((t) => t.id),
    )
  })
})

/* -------------------------------------------------------------------------- */
/* Built-in scaffolds                                                          */
/* -------------------------------------------------------------------------- */

describe("built-in example agents", () => {
  test("created once on first run, never overwritten", async () => {
    const created = await ensureBuiltinAgents(globalAgentsDir())
    expect(created.map((f) => path.basename(f)).sort()).toEqual(
      Object.keys(BUILTIN_AGENTS).sort(),
    )

    const reviewer = path.join(globalAgentsDir(), "reviewer.md")
    expect((await Bun.file(reviewer).text()).startsWith("---")).toBe(true)

    // The user edits it; a second startup must leave it alone.
    await Bun.write(reviewer, "# my custom reviewer\n")
    const second = await ensureBuiltinAgents(globalAgentsDir())
    expect(second).toEqual([])
    expect(await Bun.file(reviewer).text()).toBe("# my custom reviewer\n")
  })

  test("the shipped examples parse as valid agents", async () => {
    await ensureBuiltinAgents(globalAgentsDir())
    const { agents, warnings } = await getAgents(project)
    expect(warnings).toEqual([])

    const reviewer = agents.find((a) => a.name === "reviewer")
    expect(reviewer?.mode).toBe("plan")
    expect(reviewer?.tools).toEqual(["read", "glob", "grep"])
    const explainer = agents.find((a) => a.name === "explainer")
    expect(explainer?.description.length).toBeGreaterThan(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Loop + subagent integration (mock provider)                                 */
/* -------------------------------------------------------------------------- */

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"

const start = (id: string) => ({
  type: "message_start",
  message: { id, type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } },
})
const callTool = (id: string, name: string, input: object) => [
  { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name, input: {} } },
  { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input) } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]
const say = (text: string) => [
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
]

interface CapturedRequest {
  system?: unknown
  model?: string
  tools?: Array<{ name?: string }>
}

/** The SDK sends `system` as content blocks; flatten for assertions. */
function systemText(body: CapturedRequest): string {
  if (typeof body.system === "string") return body.system
  return (Array.isArray(body.system) ? body.system : [])
    .map((part) => (part as { text?: string }).text ?? "")
    .join("")
}

/** Drain one loop to completion against the given server. */
async function drain(loop: AsyncGenerator<unknown>): Promise<void> {
  let step = await loop.next()
  while (!step.done) step = await loop.next()
}

describe("named agent in the loop", () => {
  test("the addendum lands in the system prompt and the allowlist filters tools", async () => {
    await projectAgent("reviewer", REVIEWER_MD)

    const requests: CapturedRequest[] = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as CapturedRequest
        requests.push(body)
        return new Response(sse([start("s1"), ...say("done")]), {
          headers: { "content-type": "text/event-stream" },
        })
      },
    })

    try {
      const selected = await resolveAgent(project, "reviewer")
      const agent = selected.agent!
      expect(agent).toBeDefined()

      await drain(
        runAgentLoop({
          sessionID: "s",
          agent: agent.name,
          cwd: project,
          userText: "review this",
          history: [],
          model: pickModel(agent, undefined, undefined, undefined, "anthropic/claude-x"),
          tools: filterToolsByAllowlist(allTools(), agent),
          config: {
            maxTurns: 4,
            providers: { anthropic: { apiKey: "k", baseURL: `http://localhost:${server.port}` } },
          },
          retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 },
          askPermission: createAskHandler({ mode: "plan", onAsk: () => "deny" }),
          mode: pickMode("build", false, agent),
          agentInstructions: agent.instructions,
        }),
      )

      expect(requests.length).toBeGreaterThan(0)
      const system = systemText(requests[0]!)
      expect(system).toContain("REVIEWER-ADDENDUM-MARKER")
      // The addendum comes after everything else — most specific voice last.
      expect(system.indexOf("REVIEWER-ADDENDUM-MARKER")).toBeGreaterThan(
        system.indexOf("# Environment"),
      )
      // Allowlist: only read/glob/grep were offered to the model.
      const toolNames = (requests[0]?.tools ?? []).map((t) => t.name)
      expect(toolNames).toEqual(["read", "glob", "grep"])
      // The named agent's model override reached the provider (spec's model
      // id, provider stripped).
      expect(requests[0]?.model).toBe("claude-x")
    } finally {
      server.stop(true)
    }
  })

  test("task with an agent name runs the subagent under that agent's config", async () => {
    await globalAgent("reviewer", REVIEWER_MD)
    // The reviewer's allowlist excludes write, so its subagent cannot write.

    const bodies: Array<CapturedRequest & { messages?: unknown[] }> = []
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as CapturedRequest & { messages?: unknown[] }
        const isSubagent = JSON.stringify(body.messages ?? []).includes("PROBE-SUB")
        bodies.push(body)
        if (isSubagent) return new Response(sse([start(`s${bodies.length}`), ...say("reviewed")]), {
          headers: { "content-type": "text/event-stream" },
        })
        const spawned = JSON.stringify(body.messages ?? []).includes("tool_use")
        return new Response(
          sse(spawned
            ? [start(`p${bodies.length}`), ...say("parent done")]
            : [start(`p${bodies.length}`), ...callTool(`t${bodies.length}`, "task", {
                description: "review it",
                prompt: "PROBE-SUB: review the thing",
                agent: "reviewer",
              })]),
          { headers: { "content-type": "text/event-stream" } })
      },
    })

    try {
      const config = {
        maxTurns: 6,
        providers: { anthropic: { apiKey: "k", baseURL: `http://localhost:${server.port}` } },
      }
      await drain(
        runAgentLoop({
          sessionID: "s",
          agent: "build",
          cwd: project,
          userText: "go",
          history: [],
          model: "anthropic/claude-x",
          tools: allTools(),
          config,
          retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 },
          askPermission: createAskHandler({ mode: "build", onAsk: () => "deny" }),
          mode: "build",
        }),
      )

      const sub = bodies.find((b) => JSON.stringify(b.messages ?? []).includes("PROBE-SUB"))
      expect(sub).toBeDefined()
      // The subagent ran with the reviewer's addendum...
      expect(sub ? systemText(sub) : "").toContain("REVIEWER-ADDENDUM-MARKER")
      // ...and only the reviewer's allowlisted tools.
      expect((sub?.tools ?? []).map((t) => t.name)).toEqual(["read", "glob", "grep"])
    } finally {
      server.stop(true)
    }
  })

  test("task with an unknown agent name reports instead of throwing", async () => {
    await projectAgent("reviewer", REVIEWER_MD)

    const result = await taskTool.execute(
      { description: "d", prompt: "do it", agent: "ghost" },
      {
        sessionID: "s",
        agent: "build",
        cwd: project,
        abort: new AbortController().signal,
        askPermission: async () => "allow",
        subagent: { model: "anthropic/claude-x", tools: allTools(), mode: "build" },
      } as never,
    )

    expect(result.output).toContain("no agent named")
    expect(result.output).toContain("reviewer")
  })
})

/* -------------------------------------------------------------------------- */
/* /reload-style rescan keeps the list fresh                                   */
/* -------------------------------------------------------------------------- */

describe("rescans", () => {
  test("a second getAgents sees newly written files", async () => {
    expect((await getAgents(project)).agents).toEqual([])
    await globalAgent("late", "---\ndescription: arrived later\n---\n")
    const { agents } = await getAgents(project)
    expect(agents.map((a) => a.name)).toEqual(["late"])
  })
})
