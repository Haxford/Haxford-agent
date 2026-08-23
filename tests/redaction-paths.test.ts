/**
 * Redaction on the paths the confidentiality sweep found unmasked.
 *
 * Tool output has been masked since the beginning. These are the two routes
 * that reached the same places — the transcript, and the session JSONL on
 * disk — without passing through `redactSecrets`: provider error strings, and
 * fetched web content. Each test drives the real path end to end rather than
 * unit-testing the redactor, which already has its own tests.
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runAgentLoop } from "../src/agent/loop.ts"
import { appendMessage, loadHistory } from "../src/session/store.ts"
import { sessionFilePath } from "../src/session/store.ts"
import { webfetchTool } from "../src/tools/webfetch.ts"
import type { AgentEvent } from "../src/types/events.ts"
import type { Message } from "../src/types/message.ts"
import type { ToolContext } from "../src/types/tool.ts"

/** A key-shaped string that `redactSecrets` recognises by pattern alone. */
const FAKE_KEY = "sk-ant-api03-LEAKEDKEYVALUE0123456789abcdefXYZ"

function ctx(cwd: string): ToolContext {
  return {
    sessionID: `s-${crypto.randomUUID()}`,
    agent: "test",
    cwd,
    abort: new AbortController().signal,
    askPermission: async () => "allow",
  }
}

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "haxford-redact-"))
}

/* -------------------------------------------------------------------------- */
/* 1. Provider error strings: transcript AND session JSONL                    */
/* -------------------------------------------------------------------------- */

describe("provider error text is redacted before it is shown or stored", () => {
  test("a key echoed in a provider error never reaches the transcript", async () => {
    // A gateway rejecting a request commonly quotes it back — key included.
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: {
              type: "authentication_error",
              message: `invalid x-api-key: ${FAKE_KEY}`,
            },
          }),
          { status: 401, headers: { "content-type": "application/json" } },
        ),
    })

    const events: AgentEvent[] = []
    try {
      const gen = runAgentLoop({
        sessionID: "s",
        agent: "build",
        cwd: "/tmp",
        userText: "hi",
        history: [],
        model: "anthropic/claude-sonnet-5",
        retry: { maxAttempts: 1, baseDelayMs: 1, maxDelayMs: 5 },
        config: {
          maxTurns: 2,
          providers: {
            anthropic: { apiKey: "k", baseURL: `http://localhost:${server.port}` },
          },
        },
      })
      let step = await gen.next()
      while (!step.done) {
        events.push(step.value)
        step = await gen.next()
      }
    } finally {
      server.stop(true)
    }

    const errorEvents = events.filter(
      (e): e is Extract<AgentEvent, { type: "error" }> => e.type === "error",
    )
    expect(errorEvents.length).toBeGreaterThan(0)

    // The test is only meaningful if the provider's text actually propagated:
    // assert the surrounding message survived, and only the key was masked.
    const all = JSON.stringify(events)
    expect(all).toContain("invalid x-api-key")
    expect(all).not.toContain(FAKE_KEY)
    expect(all).toContain("[REDACTED]")
  }, 20_000)

  test("message.error is masked on the way to the session file", async () => {
    // The structural half: even an error string that skipped the loop's own
    // redaction cannot land on disk in the clear.
    const dir = await tmp()
    const sessionID = crypto.randomUUID()
    const message: Message = {
      id: "m1",
      sessionID,
      role: "assistant",
      parts: [],
      time: { created: Date.now() },
      error: `upstream said: authorization: Bearer ${FAKE_KEY}`,
    }

    await appendMessage(dir, sessionID, message)

    const raw = await readFile(sessionFilePath(dir, sessionID), "utf8")
    expect(raw).not.toContain(FAKE_KEY)
    expect(raw).toContain("[REDACTED]")

    // And it round-trips as a normal message, not a mangled one.
    const history = await loadHistory(dir, sessionID)
    expect(history).toHaveLength(1)
    expect(history[0]?.error).toContain("[REDACTED]")
    expect(history[0]?.error).not.toContain(FAKE_KEY)
  })

  test("the caller's own message object is not mutated by persisting it", async () => {
    // The host keeps this object in `history` and replays it to the model, so
    // redacting for disk must copy rather than edit in place.
    const dir = await tmp()
    const sessionID = crypto.randomUUID()
    const original = `boom ${FAKE_KEY}`
    const message: Message = {
      id: "m1",
      sessionID,
      role: "assistant",
      parts: [],
      time: { created: Date.now() },
      error: original,
    }

    await appendMessage(dir, sessionID, message)
    expect(message.error).toBe(original)
  })

  test("a message with no error is stored unchanged", async () => {
    const dir = await tmp()
    const sessionID = crypto.randomUUID()
    const message: Message = {
      id: "m1",
      sessionID,
      role: "user",
      parts: [{ id: "p1", type: "text", text: "hello" }],
      time: { created: Date.now() },
    }
    await appendMessage(dir, sessionID, message)
    const history = await loadHistory(dir, sessionID)
    expect(history[0]?.parts[0]).toMatchObject({ type: "text", text: "hello" })
    expect(history[0]?.error).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* 2. webfetch content and error strings                                      */
/* -------------------------------------------------------------------------- */

describe("webfetch output is redacted like every other content tool", () => {
  test("a key in a fetched page body is masked", async () => {
    const dir = await tmp()
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`<html><body><p>token: ${FAKE_KEY}</p></body></html>`, {
          headers: { "content-type": "text/html" },
        }),
    })
    try {
      const result = await webfetchTool.execute(
        { url: `http://localhost:${server.port}/page` },
        ctx(dir),
      )
      expect(result.output).not.toContain(FAKE_KEY)
      expect(result.output).toContain("[REDACTED]")
      // The surrounding page content still came through.
      expect(result.output).toContain("token:")
    } finally {
      server.stop(true)
    }
  }, 20_000)

  test("the per-run cache stores the masked text, not the raw body", async () => {
    const dir = await tmp()
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(`plain body with ${FAKE_KEY} inside`, {
          headers: { "content-type": "text/plain" },
        }),
    })
    try {
      const url = `http://localhost:${server.port}/cached`
      const first = await webfetchTool.execute({ url }, ctx(dir))
      expect(first.output).not.toContain(FAKE_KEY)

      // Second call is served from cache — it must not be the raw text.
      const second = await webfetchTool.execute({ url }, ctx(dir))
      expect(second.metadata?.["cached"]).toBe(true)
      expect(second.output).not.toContain(FAKE_KEY)
      expect(second.output).toContain("[REDACTED]")
    } finally {
      server.stop(true)
    }
  }, 20_000)

  test("an error line echoing the URL does not echo a key inside it", async () => {
    // The failure message embeds the requested URL, and a URL the model built
    // can carry a token in its query string. (A server cannot inject through
    // `statusText` — Bun replaces it with the canonical reason phrase — so the
    // URL is the channel worth testing here.)
    const dir = await tmp()
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response("nope", { status: 400 }),
    })
    try {
      const result = await webfetchTool.execute(
        { url: `http://localhost:${server.port}/x?key=${FAKE_KEY}` },
        ctx(dir),
      )
      expect(result.output).toContain("HTTP 400")
      expect(result.output).not.toContain(FAKE_KEY)
      expect(result.output).toContain("[REDACTED]")
    } finally {
      server.stop(true)
    }
  }, 20_000)

  test("a rejected redirect target is reported without leaking a key in it", async () => {
    const dir = await tmp()
    const server = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(null, {
          status: 302,
          headers: {
            location: `http://169.254.169.254/latest?probe=${FAKE_KEY}`,
          },
        }),
    })
    try {
      const result = await webfetchTool.execute(
        { url: `http://localhost:${server.port}/start` },
        ctx(dir),
      )
      expect(result.output).toContain("link-local/metadata")
      expect(result.output).not.toContain(FAKE_KEY)
    } finally {
      server.stop(true)
    }
  }, 20_000)
})

/* -------------------------------------------------------------------------- */
/* 3. AGENTS.md must not contradict .gitignore                                */
/* -------------------------------------------------------------------------- */

describe("AGENTS.md describes the real ignore state", () => {
  test("settings.local.json is gitignored, and AGENTS.md says so", async () => {
    const ignore = await readFile(".gitignore", "utf8")
    const agents = await readFile("AGENTS.md", "utf8")

    const entry = ".haxford/settings.local.json"
    const ignored = ignore
      .split("\n")
      .map((l) => l.trim())
      .includes(entry)
    expect(ignored).toBe(true)

    // The sentence used to claim the opposite, which is the kind of drift that
    // gets a machine-local approvals file committed by someone who trusted it.
    const claim = agents.slice(agents.indexOf(entry))
    expect(claim).not.toMatch(/\*\*not\*\* in `\.gitignore`/)
    expect(claim).toMatch(/\*\*is\*\* in `\.gitignore`/)
  })
})
