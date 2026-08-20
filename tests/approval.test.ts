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

  test("askPermission never throws for concurrency (FIFO queue)", async () => {
    const b = createApprovalBridge()
    // A second concurrent ask queues rather than throwing.
    const p1 = b.askPermission(req("bash"))
    const p2 = b.askPermission(req("write"))
    expect(b.pending()?.tool).toBe("bash") // head unchanged
    b.resolve("deny")
    b.resolve("deny")
    expect(await p1).toBe("deny")
    expect(await p2).toBe("deny")
  })

  test("two concurrent askPermission calls resolve in order (F2/F7b)", async () => {
    const b = createApprovalBridge()
    const results: string[] = []

    // Fire both before any resolution — the second queues behind the first.
    const p1 = b.askPermission(req("bash", "one"))
    const p2 = b.askPermission(req("write", "two"))

    void p1.then((d) => results.push(`1:${d}`))
    void p2.then((d) => results.push(`2:${d}`))

    // Head is the first request; the second is queued and not yet visible.
    expect(b.pending()?.title).toBe("one")

    // Resolve the head -> p1 settles and the second advances to the head.
    b.resolve("allow")
    await flush()
    expect(results).toEqual(["1:allow"])
    expect(b.pending()?.title).toBe("two")

    // Resolve the new head -> p2 settles and the queue empties.
    b.resolve("deny")
    await flush()
    expect(results).toEqual(["1:allow", "2:deny"])
    expect(b.pending()).toBeUndefined()
  })

  test("pending returns the exact head request object", () => {
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

  test("cancel resolves ALL queued requests as deny and returns the count", async () => {
    const b = createApprovalBridge()
    const p1 = b.askPermission(req("bash", "one"))
    const p2 = b.askPermission(req("write", "two"))
    const p3 = b.askPermission(req("edit", "three"))

    const got: string[] = []
    void p1.then((d) => got.push(`1:${d}`))
    void p2.then((d) => got.push(`2:${d}`))
    void p3.then((d) => got.push(`3:${d}`))

    // Head is visible; deeper entries are not.
    expect(b.pending()?.title).toBe("one")

    const count = b.cancel()
    expect(count).toBe(3)
    await flush()
    expect(got).toEqual(["1:deny", "2:deny", "3:deny"])
    expect(b.pending()).toBeUndefined()
  })

  test("cancel on an empty queue returns 0", () => {
    const b = createApprovalBridge()
    expect(b.cancel()).toBe(0)
  })

  test("after cancel, the bridge accepts new requests normally", async () => {
    const b = createApprovalBridge()
    b.askPermission(req("bash"))
    b.cancel()
    expect(b.pending()).toBeUndefined()

    const p = b.askPermission(req("write"))
    expect(b.pending()?.tool).toBe("write")
    b.resolve("allow")
    expect(await p).toBe("allow")
  })
})
