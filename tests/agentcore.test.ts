import { describe, expect, test } from "bun:test"
import { runAgentLoop } from "../src/agent/loop.ts"
import { createAskHandler, isReadOnlyCommand } from "../src/permission/engine.ts"
import { allTools } from "../src/tools/index.ts"
import type { PermissionRequest } from "../src/types/tool.ts"

const req = (tool: string, subject: string): PermissionRequest => ({
  tool, title: subject, sessionID: "s",
  args: tool === "bash" ? { command: subject } : { filePath: subject },
})

describe("isReadOnlyCommand", () => {
  test("accepts ordinary inspection commands", () => {
    for (const c of [
      "ls -la", "cat /etc/hostname", "rg --files", "grep -rn TODO src",
      "git status", "git diff HEAD~1", "git log --oneline -20", "git show abc",
      "wc -l src/a.ts", "find . -name '*.ts'", "sed -n 1,20p file.ts",
      "head -50 x", "tail -f x", "jq .name package.json", "diff a b",
    ]) expect(isReadOnlyCommand(c)).toBe(true)
  })

  test("rejects anything that writes, even with a safe-looking verb", () => {
    for (const c of [
      "rm -rf /", "git commit -m x", "git push", "git checkout main",
      "find . -name '*.log' -delete", "find . -exec rm {} ;",
      "sed -i 's/a/b/' f", "sed --in-place s/a/b/ f",
      "npm install", "bun run build", "python3 -c 'import os'",
      "awk '{print > \"out\"}' f", "xargs rm", "sudo ls",
    ]) expect(isReadOnlyCommand(c)).toBe(false)
  })

  test("rejects every shell escape from a safe prefix", () => {
    for (const c of [
      "ls; rm -rf /", "ls && rm x", "ls || rm x", "ls | xargs rm",
      "ls > out.txt", "ls >> out.txt", "cat < f", "echo `rm x`",
      "echo $(rm x)", "ls $HOME && rm x", "ls\nrm -rf /",
      "ls {a,b}", "cat f & rm x", "ls \\; rm x",
    ]) expect(isReadOnlyCommand(c)).toBe(false)
  })

  test("rejects the empty command and unknown binaries", () => {
    expect(isReadOnlyCommand("")).toBe(false)
    expect(isReadOnlyCommand("   ")).toBe(false)
    expect(isReadOnlyCommand("some-unknown-tool --help")).toBe(false)
  })
})

describe("plan mode", () => {
  const handler = (extra: Partial<Parameters<typeof createAskHandler>[0]> = {}) =>
    createAskHandler({ mode: "plan", onAsk: () => "allow", ...extra })

  test("denies bash that could change anything", async () => {
    const h = handler()
    expect(await h(req("bash", "rm -rf /"))).toBe("deny")
    expect(await h(req("bash", "ls; rm x"))).toBe("deny")
    expect(await h(req("bash", "npm install"))).toBe("deny")
  })

  test("allows read-only bash", async () => {
    const h = handler()
    expect(await h(req("bash", "ls"))).toBe("allow")
    expect(await h(req("bash", "git diff"))).toBe("allow")
    expect(await h(req("bash", "rg TODO"))).toBe("allow")
  })

  test("never calls onAsk either way", async () => {
    let asked = 0
    const h = createAskHandler({ mode: "plan", onAsk: () => { asked++; return "allow" } })
    expect(await h(req("bash", "ls"))).toBe("allow")
    expect(await h(req("bash", "rm x"))).toBe("deny")
    expect(asked).toBe(0)
  })

  test("still denies write and edit", async () => {
    const h = handler()
    expect(await h(req("write", "/x"))).toBe("deny")
    expect(await h(req("edit", "/x"))).toBe("deny")
  })

  test("an explicit deny rule beats the read-only allowlist", async () => {
    const h = handler({ rules: { bash: "deny" } })
    expect(await h(req("bash", "ls"))).toBe("deny")
  })
})

/* ------------------------------------------------------------------ */
/* Subagents inherit the parent's permission posture                   */
/* ------------------------------------------------------------------ */

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

/**
 * Parent turn 1 spawns a subagent; the subagent immediately tries to write a
 * file, then reports what happened. Whether the write lands is the whole test.
 */
function permissionProbeServer(target: string) {
  let call = 0
  return Bun.serve({
    port: 0,
    async fetch(request) {
      const body = (await request.json()) as { messages?: unknown[] }
      const isSubagent = JSON.stringify(body.messages ?? []).includes("PROBE")
      call++
      if (isSubagent) {
        const already = JSON.stringify(body.messages ?? []).includes("tool_result")
          || JSON.stringify(body.messages ?? []).includes("tool_use")
        return new Response(
          sse(already
            ? [start(`s${call}`), ...say("attempted the write")]
            : [start(`s${call}`), ...callTool(`w${call}`, "write", { filePath: target, content: "written by subagent" })]),
          { headers: { "content-type": "text/event-stream" } })
      }
      const spawned = JSON.stringify(body.messages ?? []).includes("tool_use")
      return new Response(
        sse(spawned
          ? [start(`p${call}`), ...say("subagent done")]
          : [start(`p${call}`), ...callTool(`t${call}`, "task", { description: "probe perms", prompt: "PROBE: write the file" })]),
        { headers: { "content-type": "text/event-stream" } })
    },
  })
}

async function runWithMode(mode: "build" | "auto" | "plan" | undefined, target: string) {
  const server = permissionProbeServer(target)
  try {
    const gen = runAgentLoop({
      sessionID: "s", agent: "build", cwd: "/tmp", userText: "go", history: [],
      model: "anthropic/claude-sonnet-5",
      tools: allTools(),
      ...(mode ? { mode } : {}),
      retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 10 },
      askPermission: createAskHandler({ mode: mode ?? "build", onAsk: () => "deny" }),
      config: { maxTurns: 6, providers: { anthropic: { apiKey: "k", baseURL: `http://localhost:${server.port}` } } },
    })
    let step = await gen.next()
    while (!step.done) step = await gen.next()
  } finally { server.stop(true) }
}

describe("subagent permission inheritance", () => {
  test("a build-mode parent's subagent cannot write behind the user's back", async () => {
    const target = `/tmp/haxford-subagent-${crypto.randomUUID()}.txt`
    await runWithMode("build", target)
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test("defaults to the strict posture when the host passes no mode", async () => {
    const target = `/tmp/haxford-subagent-${crypto.randomUUID()}.txt`
    await runWithMode(undefined, target)
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test("a plan-mode parent's subagent cannot write either", async () => {
    const target = `/tmp/haxford-subagent-${crypto.randomUUID()}.txt`
    await runWithMode("plan", target)
    expect(await Bun.file(target).exists()).toBe(false)
  })

  test("an auto-mode parent's subagent still can — that is what auto means", async () => {
    const target = `/tmp/haxford-subagent-${crypto.randomUUID()}.txt`
    try {
      await runWithMode("auto", target)
      expect(await Bun.file(target).exists()).toBe(true)
    } finally {
      await Bun.file(target).delete().catch(() => {})
    }
  })
})