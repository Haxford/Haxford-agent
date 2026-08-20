import { describe, expect, test } from "bun:test"

import { createApprovalBridge } from "../src/tui/approval.ts"
import type { PermissionRequest } from "../src/types/tool.ts"

function req(tool: string, title = tool): PermissionRequest {
  return { tool, title, args: {}, sessionID: "s" }
}

/** Drain pending microtasks so suspended askPermission promises can resolve. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe("ApprovalBridge", () => {
  test("pending is undefined initially", () => {
    const b = createApprovalBridge()
    expect(b.pending()).toBeUndefined()
  })

  test("askPermission sets pending and suspends until resolved", async () => {
    const b = createApprovalBridge()
    const p = b.askPermission(req("bash", "ls"))
    // Synchronously pending is set.
    expect(b.pending()).toBeDefined()
    expect(b.pending()?.tool).toBe("bash")

    let resolved: string | undefined = undefined
    void p.then((d) => { resolved = d })

    b.resolve("allow")
    await flush()
    expect(resolved ?? "").toBe("allow")
    expect(b.pending()).toBeUndefined()
  })

  test("resolve is a no-op when nothing is pending", () => {
    const b = createApprovalBridge()
    expect(() => b.resolve("deny")).not.toThrow()
    expect(b.pending()).toBeUndefined()
  })

  test("each decision value propagates", async () => {
    for (const decision of ["allow", "always", "deny"] as const) {
      const b = createApprovalBridge()
      const p = b.askPermission(req("write"))
      let got: string | undefined = undefined
      void p.then((d) => { got = d })
      b.resolve(decision)
      await flush()
      expect(got ?? "").toBe(decision)
    }
  })

  test("subscribe fires when pending changes (set + clear)", async () => {
    const b = createApprovalBridge()
    const events: ("pending" | "idle")[] = []
    const unsubscribe = b.subscribe(() => {
      events.push(b.pending() !== undefined ? "pending" : "idle")
    })

    b.askPermission(req("bash"))
    b.resolve("allow")
    await flush()

    expect(events).toEqual(["pending", "idle"])
    unsubscribe()
  })

  test("unsubscribe stops notifications", async () => {
    const b = createApprovalBridge()
    const events: number[] = []
    const unsubscribe = b.subscribe(() => events.push(events.length))
    unsubscribe()

    b.askPermission(req("bash"))
    b.resolve("allow")
    await flush()
    expect(events).toHaveLength(0)
  })

  test("second askPermission while one is pending throws", () => {
    const b = createApprovalBridge()
    b.askPermission(req("bash"))
    expect(() => b.askPermission(req("write"))).toThrow(/already pending/)
    b.resolve("deny")
  })

  test("multiple sequential requests resolve in order", async () => {
    const b = createApprovalBridge()
    const results: string[] = []

    const p1 = b.askPermission(req("bash", "one"))
    const p2 = (async () => {
      // Second request must come only after the first is resolved.
      await flush()
      const r = b.askPermission(req("write", "two"))
      b.resolve("always")
      return r
    })()

    void p1.then((d) => results.push(`1:${d}`))
    void p2.then((d) => results.push(`2:${d}`))

    b.resolve("allow")
    await flush()
    await flush()

    expect(results).toEqual(["1:allow", "2:always"])
    expect(b.pending()).toBeUndefined()
  })

  test("pending returns the exact request object", () => {
    const b = createApprovalBridge()
    const r = req("edit", "/etc/passwd")
    b.askPermission(r)
    expect(b.pending()).toBe(r)
    b.resolve("deny")
  })

  test("resolve clears pending before notifying listeners", () => {
    const b = createApprovalBridge()
    b.askPermission(req("bash"))
    let sawPending: boolean | undefined = undefined
    b.subscribe(() => { sawPending = b.pending() !== undefined })
    b.resolve("allow")
    expect(sawPending === false).toBe(true)
  })
})
