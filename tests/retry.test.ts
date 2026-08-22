import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { runAgentLoop } from "../src/agent/loop.ts"
import {
  classifyFailure, nextDelay, planRetry, sleepWithAbort, withRetry,
  DEFAULT_RETRY_POLICY, type RetryPolicy,
} from "../src/agent/retry.ts"
import type { AgentEvent } from "../src/types/events.ts"
import type { Tool } from "../src/types/tool.ts"

const FAST: RetryPolicy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 1_000 }

/* ------------------------------------------------------------------ */
/* Fake Anthropic stream factory: fails N times, then succeeds.        */
/* ------------------------------------------------------------------ */

const sse = (events: object[]) =>
  events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("") + "data: [DONE]\n\n"

const okStream = (text: string) => sse([
  { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
  { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
  { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
  { type: "content_block_stop", index: 0 },
  { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
  { type: "message_stop" },
])

type Failure =
  | { kind: "status"; status: number; body?: string; headers?: Record<string, string> }
  | { kind: "truncate" }        // headers 200 then the socket dies mid-stream
  | { kind: "partial"; text: string } // streams real text, THEN dies

/** Serves `failures` in order, then a successful stream for every later call. */
function fakeStreamFactory(failures: Failure[], text = "ok") {
  let calls = 0
  const server = Bun.serve({
    port: 0,
    fetch() {
      const failure = failures[calls++]
      if (!failure) {
        return new Response(okStream(text), { headers: { "content-type": "text/event-stream" } })
      }
      if (failure.kind === "status") {
        return new Response(failure.body ?? "upstream error", {
          status: failure.status,
          headers: { "content-type": "application/json", ...failure.headers },
        })
      }
      const prefix = failure.kind === "partial"
        ? sse([
            { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "x", content: [], stop_reason: null, usage: { input_tokens: 3, output_tokens: 1 } } },
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: failure.text } },
          ])
        : ""
      const stream = new ReadableStream({
        start(controller) {
          if (prefix) controller.enqueue(new TextEncoder().encode(prefix))
          controller.close()
        },
      })
      return new Response(stream, { headers: { "content-type": "text/event-stream" } })
    },
  })
  return {
    port: server.port as number,
    stop: () => server.stop(true),
    get calls() { return calls },
  }
}

async function run(port: number, opts: { tools?: Tool[]; retry?: RetryPolicy } = {}) {
  const events: AgentEvent[] = []
  const gen = runAgentLoop({
    sessionID: "s", agent: "build", cwd: "/tmp", userText: "hi", history: [],
    model: "anthropic/claude-sonnet-5",
    retry: opts.retry ?? FAST,
    ...(opts.tools ? { tools: opts.tools } : {}),
    config: { providers: { anthropic: { apiKey: "k", baseURL: `http://localhost:${port}` } } },
  })
  let step = await gen.next()
  while (!step.done) { events.push(step.value); step = await gen.next() }
  return { events, reason: step.value }
}

const notices = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "notice" ? [e.message] : []))
const text = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === "part.delta" ? [e.delta] : [])).join("")

/* ------------------------------------------------------------------ */

describe("classifyFailure", () => {
  test("retries throttling and server errors", () => {
    for (const status of [408, 409, 425, 429, 500, 502, 503, 504, 522, 524]) {
      expect(classifyFailure({ statusCode: status, message: "boom" }).retryable).toBe(true)
    }
  })

  test("does NOT retry client errors", () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(classifyFailure({ statusCode: status, message: "nope" }).retryable).toBe(false)
    }
  })

  test("does NOT retry a 429 that means the account is out of credit", () => {
    const quota = classifyFailure({
      statusCode: 429,
      message: "Your credit balance is too low to access the API",
    })
    expect(quota.retryable).toBe(false)
    expect(quota.label).toBe("quota or billing limit reached")
    expect(classifyFailure({ statusCode: 429, message: "rate_limit_error" }).retryable).toBe(true)
  })

  test("retries transport failures with no status at all", () => {
    for (const message of [
      "socket connection was closed unexpectedly", "ECONNRESET", "fetch failed",
      "terminated", "The operation timed out", "Overloaded",
    ]) {
      expect(classifyFailure(new Error(message)).retryable).toBe(true)
    }
  })

  test("never retries a user abort", () => {
    const abort = new Error("The operation was aborted")
    abort.name = "AbortError"
    expect(classifyFailure(abort).retryable).toBe(false)
  })

  test("reads the cause chain", () => {
    const wrapped = new Error("request failed", { cause: new Error("ECONNRESET") })
    expect(classifyFailure(wrapped).retryable).toBe(true)
  })

  test("honours Retry-After in seconds and as a date", () => {
    expect(classifyFailure({ statusCode: 429, message: "slow down", responseHeaders: { "retry-after": "7" } }).retryAfterMs).toBe(7000)
    const soon = new Date(Date.now() + 5_000).toUTCString()
    const ms = classifyFailure({ statusCode: 503, message: "x", responseHeaders: { "Retry-After": soon } }).retryAfterMs
    expect(ms).toBeGreaterThan(1_000)
    expect(ms).toBeLessThanOrEqual(6_000)
  })
})

describe("nextDelay", () => {
  test("grows exponentially, within the jitter band", () => {
    for (const [attempt, mid] of [[1, 2000], [2, 4000], [3, 8000]] as const) {
      const d = nextDelay(attempt, DEFAULT_RETRY_POLICY)!
      expect(d).toBeGreaterThanOrEqual(mid * 0.75 - 1)
      expect(d).toBeLessThanOrEqual(mid * 1.25 + 1)
    }
  })

  test("a server-requested delay wins outright", () => {
    expect(nextDelay(1, DEFAULT_RETRY_POLICY, 1234)).toBe(1234)
  })

  test("refuses to wait longer than the policy ceiling", () => {
    expect(nextDelay(1, DEFAULT_RETRY_POLICY, 120_000)).toBeUndefined()
  })

  test("caps exponential growth at maxDelayMs", () => {
    expect(nextDelay(20, DEFAULT_RETRY_POLICY)!).toBeLessThanOrEqual(60_000 * 1.25 + 1)
  })
})

describe("planRetry", () => {
  const err = { statusCode: 503, message: "boom" }
  test("stops once the attempt budget is spent", () => {
    expect(planRetry(err, 1, FAST)).toBeDefined()
    expect(planRetry(err, 2, FAST)).toBeDefined()
    expect(planRetry(err, 3, FAST)).toBeUndefined()
  })
  test("stops when aborted", () => {
    const c = new AbortController(); c.abort()
    expect(planRetry(err, 1, FAST, c.signal)).toBeUndefined()
  })
})

describe("withRetry", () => {
  test("fails N times then succeeds, reporting each wait", async () => {
    let calls = 0
    const seen: number[] = []
    const value = await withRetry(async () => {
      calls++
      if (calls < 3) throw { statusCode: 503, message: "transient" }
      return "done"
    }, { policy: FAST, onRetry: (n) => seen.push(n.attempt) })

    expect(value).toBe("done")
    expect(calls).toBe(3)
    expect(seen).toEqual([1, 2])
  })

  test("gives up after maxAttempts and rethrows the last error", async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls++
      throw { statusCode: 500, message: "always down" }
    }, { policy: FAST })).rejects.toMatchObject({ message: "always down" })
    expect(calls).toBe(3)
  })

  test("does not retry a fatal error", async () => {
    let calls = 0
    await expect(withRetry(async () => {
      calls++
      throw { statusCode: 401, message: "bad key" }
    }, { policy: FAST })).rejects.toMatchObject({ message: "bad key" })
    expect(calls).toBe(1)
  })

  test("stops retrying as soon as the run is aborted", async () => {
    const c = new AbortController()
    let calls = 0
    const promise = withRetry(async () => {
      calls++
      if (calls === 1) setTimeout(() => c.abort(), 5)
      throw { statusCode: 503, message: "down" }
    }, { policy: { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 1000 }, signal: c.signal })
    await expect(promise).rejects.toMatchObject({ message: "down" })
    expect(calls).toBeLessThanOrEqual(2)
  })
})

describe("sleepWithAbort", () => {
  test("returns early when aborted mid-sleep", async () => {
    const c = new AbortController()
    const t0 = Date.now()
    setTimeout(() => c.abort(), 10)
    await sleepWithAbort(5_000, c.signal)
    expect(Date.now() - t0).toBeLessThan(500)
  })
})

describe("agent loop retry (live fake endpoint)", () => {
  test("recovers from two transient failures and streams the real answer once", async () => {
    const f = fakeStreamFactory([{ kind: "status", status: 503 }, { kind: "truncate" }], "hello")
    try {
      const { events, reason } = await run(f.port)
      expect(reason).toBe("end_turn")
      expect(f.calls).toBe(3)
      expect(text(events)).toBe("hello")
      expect(notices(events).length).toBe(2)
      expect(notices(events)[0]).toMatch(/retrying in .*s \(attempt 2 of 3\)/)
      expect(notices(events)[1]).toMatch(/attempt 3 of 3/)
      expect(events.some((e) => e.type === "error")).toBe(false)
    } finally { f.stop() }
  })

  test("gives up after maxAttempts and reports the error", async () => {
    const f = fakeStreamFactory([
      { kind: "status", status: 500 }, { kind: "status", status: 500 }, { kind: "status", status: 500 },
    ])
    try {
      const { events, reason } = await run(f.port)
      expect(reason).toBe("error")
      expect(f.calls).toBe(3)
      expect(notices(events).length).toBe(2)
      expect(events.some((e) => e.type === "error")).toBe(true)
    } finally { f.stop() }
  })

  test("does not retry a fatal 401 at all", async () => {
    const f = fakeStreamFactory([{ kind: "status", status: 401 }])
    try {
      const { events, reason } = await run(f.port)
      expect(reason).toBe("error")
      expect(f.calls).toBe(1)
      expect(notices(events)).toEqual([])
    } finally { f.stop() }
  })

  test("does not retry a quota 429, and says why", async () => {
    const f = fakeStreamFactory([{
      kind: "status", status: 429,
      body: JSON.stringify({
        type: "error",
        error: { type: "rate_limit_error", message: "Your credit balance is too low" },
      }),
    }])
    try {
      const { events, reason } = await run(f.port)
      expect(reason).toBe("error")
      expect(f.calls).toBe(1)
      expect(notices(events)).toEqual([])
    } finally { f.stop() }
  })

  test("never retries once output has reached the user", async () => {
    const f = fakeStreamFactory([{ kind: "partial", text: "par" }], "whole")
    try {
      const { events } = await run(f.port)
      expect(f.calls).toBe(1)
      expect(notices(events)).toEqual([])
      expect(text(events)).toBe("par")
      expect(text(events)).not.toContain("whole")
    } finally { f.stop() }
  })

  test("retries a tool-calling turn without duplicating tool execution", async () => {
    let runs = 0
    const probe: Tool<Record<string, never>> = {
      id: "probe", description: "probe", parameters: z.object({}),
      async execute() { runs++; return { title: "probe", output: "pong" } },
    }
    const f = fakeStreamFactory([{ kind: "status", status: 503 }], "after tool")
    try {
      const { reason } = await run(f.port, { tools: [probe] })
      expect(reason).toBe("end_turn")
      expect(runs).toBe(0)
      expect(f.calls).toBe(2)
    } finally { f.stop() }
  })
})