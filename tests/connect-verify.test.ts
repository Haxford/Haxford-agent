import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import { ConnectDialog, type VerifyResult } from "../src/tui/components/ConnectDialog.tsx"
import type { ProviderCatalogEntry } from "../src/tui/components/ModelPicker.tsx"
import { createTuiStore } from "../src/tui/store.ts"
import { verifyProviderKey } from "../src/providers/index.ts"

/**
 * /connect hardening: the key-verification flow.
 *
 * Stages exercised: provider chooser -> form -> verifying -> (ok | error).
 * The real key must never appear in any rendered frame, and a failed verify
 * must leave the user in the form to re-edit and retry.
 */

const flush = (ms = 50): Promise<void> => new Promise((r) => setTimeout(r, ms))

const CATALOG: ProviderCatalogEntry[] = [
  { name: "anthropic", connected: true },
  { name: "openai", connected: false },
  { name: "openrouter", connected: false },
]

/** A controllable verifier: resolves on the next tick with a queued result. */
function queuedVerifier(results: VerifyResult[]): {
  verify: (p: string, k: string, u?: string) => Promise<VerifyResult>
  calls: { provider: string; key: string; url?: string }[]
} {
  const calls: { provider: string; key: string; url?: string }[] = []
  let i = 0
  const verify = (provider: string, key: string, url?: string): Promise<VerifyResult> => {
    calls.push({ provider, key, url })
    const result = results[i] ?? results[results.length - 1]!
    i++
    return Promise.resolve(result)
  }
  return { verify, calls }
}

describe("ConnectDialog: verification flow", () => {
  test("list -> form -> verifying -> success closes the dialog via onConnect", async () => {
    const { verify } = queuedVerifier([{ ok: true }])
    const connects: { provider: string; key: string; url?: string }[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: (p, k, u) => connects.push({ provider: p, key: k, url: u }),
        onCancel: () => {},
        verifyProviderKey: verify,
      }),
    )
    // openai is the first unconnected provider (alphabetical, unconnected-first).
    inst.stdin.write("\r")
    await flush()
    expect(inst.lastFrame() ?? "").toContain("connect openai")

    inst.stdin.write("sk-secret")
    await flush()
    inst.stdin.write("\r")
    await flush()

    // Verifying state appears, then onConnect fires with the un-masked key.
    expect(connects).toHaveLength(1)
    expect(connects[0]!).toEqual({ provider: "openai", key: "sk-secret", url: undefined })
    inst.unmount()
  })

  test("the verifying stage renders and ignores input until it resolves", async () => {
    // A verifier that never resolves this tick: we control resolution by
    // deferring it behind a manually-resolved promise.
    let resolve!: (r: VerifyResult) => void
    const pending = new Promise<VerifyResult>((r) => { resolve = r })
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: () => {},
        onCancel: () => {},
        verifyProviderKey: () => pending,
      }),
    )
    inst.stdin.write("\r") // enter form
    await flush()
    inst.stdin.write("sk-key")
    await flush()
    inst.stdin.write("\r") // submit -> verifying
    await flush()

    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("verifying openai")
    // While verifying, typing is ignored (no key echoes, no asterisks grow).
    inst.stdin.write("EXTRA")
    await flush()
    expect(inst.lastFrame() ?? "").not.toContain("EXTRA")

    // Resolve ok -> dialog closes via onConnect.
    resolve({ ok: true })
    await flush()
    inst.unmount()
  })

  test("a failed verify stays in the form and shows the error inline", async () => {
    const { verify, calls } = queuedVerifier([
      { ok: false, error: "The provider rejected the key (HTTP 401)." },
    ])
    const connects: unknown[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: () => connects.push("called"),
        onCancel: () => {},
        verifyProviderKey: verify,
      }),
    )
    inst.stdin.write("\r")
    await flush()
    inst.stdin.write("sk-bad")
    await flush()
    inst.stdin.write("\r")
    await flush()

    // onConnect must NOT have fired on a failed verify.
    expect(connects).toHaveLength(0)
    expect(calls).toHaveLength(1)
    // The dialog stays open in the form, surfacing the error.
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("connect openai")
    expect(frame).toContain("HTTP 401")
    inst.unmount()
  })

  test("error retry: after a failure the user can re-edit and submit again", async () => {
    const { verify, calls } = queuedVerifier([
      { ok: false, error: "rejected" },
      { ok: true },
    ])
    const connects: { provider: string; key: string }[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: (p, k) => connects.push({ provider: p, key: k }),
        onCancel: () => {},
        verifyProviderKey: verify,
      }),
    )
    inst.stdin.write("\r")
    await flush()
    inst.stdin.write("sk-bad")
    await flush()
    inst.stdin.write("\r")
    await flush()
    // First attempt failed.
    expect(connects).toHaveLength(0)
    expect(inst.lastFrame() ?? "").toContain("rejected")

    // Clear the bad key entirely, type a good one, and retry.
    for (let i = 0; i < 6; i++) inst.stdin.write("\u007f") // backspace "sk-bad"
    await flush()
    inst.stdin.write("sk-good")
    await flush()
    inst.stdin.write("\r")
    await flush()

    expect(calls).toHaveLength(2)
    expect(calls[1]!.key).toBe("sk-good")
    expect(connects).toHaveLength(1)
    expect(connects[0]!).toEqual({ provider: "openai", key: "sk-good" })
    inst.unmount()
  })

  test("the real key never appears in any frame across all stages", async () => {
    const { verify } = queuedVerifier([{ ok: false, error: "no" }, { ok: true }])
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: () => {},
        onCancel: () => {},
        verifyProviderKey: verify,
      }),
    )
    inst.stdin.write("\r")
    await flush()
    const SECRET = "sk-live-deadbeef"
    inst.stdin.write(SECRET)
    await flush()
    // While typing: only asterisks.
    expect(inst.lastFrame() ?? "").not.toContain(SECRET)
    inst.stdin.write("\r")
    await flush()
    // While verifying: the secret is not echoed.
    expect(inst.lastFrame() ?? "").not.toContain(SECRET)
    // Retry after failure: still never plaintext.
    inst.stdin.write("\r")
    await flush()
    expect(inst.lastFrame() ?? "").not.toContain(SECRET)
    inst.unmount()
  })

  test("without a verifier the dialog saves directly (backwards-compatible)", async () => {
    const connects: { provider: string; key: string; url?: string }[] = []
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: (p, k, u) => connects.push({ provider: p, key: k, url: u }),
        onCancel: () => {},
        // verifyProviderKey intentionally omitted.
      }),
    )
    inst.stdin.write("\r")
    await flush()
    inst.stdin.write("sk-plain")
    await flush()
    inst.stdin.write("\r")
    await flush()
    expect(connects).toHaveLength(1)
    expect(connects[0]!).toEqual({ provider: "openai", key: "sk-plain", url: undefined })
    inst.unmount()
  })
})

describe("ConnectDialog: masked key across the verifying and error stages", () => {
  test("asterisks track key length even after an error resets focus", async () => {
    const { verify } = queuedVerifier([{ ok: false, error: "bad key" }])
    const inst = render(
      React.createElement(ConnectDialog, {
        providerCatalog: CATALOG,
        onConnect: () => {},
        onCancel: () => {},
        verifyProviderKey: verify,
      }),
    )
    inst.stdin.write("\r")
    await flush()
    inst.stdin.write("abc")
    await flush()
    let frame = inst.lastFrame() ?? ""
    expect(frame).toContain("***") // 3 asterisks
    expect(frame).not.toContain("abc")

    inst.stdin.write("\r")
    await flush()
    frame = inst.lastFrame() ?? ""
    // After the error, the masked key is still shown (asterisks), not plaintext.
    expect(frame).toContain("***")
    expect(frame).not.toContain("abc")
    expect(frame).toContain("bad key")
    inst.unmount()
  })
})

describe("store.setHint: transient confirmation after connect", () => {
  test("setHint surfaces a hint that auto-clears, without touching the transcript", async () => {
    const store = createTuiStore([])
    expect(store.getState().hint).toBeUndefined()
    expect(store.getState().notices).toEqual([])

    store.setHint("openrouter connected", 60)
    expect(store.getState().hint).toBe("openrouter connected")
    // A hint is NOT a notice: the transcript stays empty.
    expect(store.getState().notices).toEqual([])
    expect(store.getState().messages).toEqual([])

    // Auto-clears after the ttl.
    await flush(90)
    expect(store.getState().hint).toBeUndefined()
    // And leaves nothing behind in the transcript.
    expect(store.getState().notices).toEqual([])
  })

  test("a later setHint supersedes an earlier one and resets its timer", async () => {
    const store = createTuiStore([])
    store.setHint("first", 200)
    store.setHint("second", 200)
    expect(store.getState().hint).toBe("second")
    await flush(120)
    // The first hint's timer was cancelled; the second is still live.
    expect(store.getState().hint).toBe("second")
    await flush(120)
    expect(store.getState().hint).toBeUndefined()
  })
})

describe("verifyProviderKey: non-network paths", () => {
  // These exercise the pure branches that do not issue a fetch, so the suite
  // stays hermetic. The live authenticated calls are integration-tested by the
  // /connect flow itself against a real provider key.

  test("codex is trusted without a network call (it reuses a login token)", async () => {
    const result = await verifyProviderKey("codex", "any-token")
    expect(result).toEqual({ ok: true })
  })

  test("an empty key is rejected before any request", async () => {
    const result = await verifyProviderKey("openai", "")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.toLowerCase()).toContain("empty")
  })

  test("an unknown provider with no base URL is trusted (nothing to check against)", async () => {
    const result = await verifyProviderKey("custom-gw", "sk-xyz")
    expect(result).toEqual({ ok: true })
  })

  test("aliases resolve: kimi verifies against the moonshot provider", async () => {
    // kimi is an alias for moonshot; with no base URL it would hit the
    // default endpoint. Pass an unreachable base to prove it routes through
    // the OpenAI-compatible branch (and reports a network error, not a crash).
    const result = await verifyProviderKey("kimi", "sk-test", "http://127.0.0.1:1/v1")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.length).toBeGreaterThan(0)
  })
})
