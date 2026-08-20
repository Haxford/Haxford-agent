import type {
  PermissionDecision,
  PermissionRequest,
} from "../types/tool.ts"

/**
 * Bridge between the synchronous permission engine (which awaits a decision
 * via Promise) and the Ink UI (which renders a dialog and reacts to keypresses).
 *
 * Lifecycle of a single request:
 *   1. agent loop calls `askPermission(req)` -> stores it as pending, notifies
 *      subscribers, returns a suspended Promise.
 *   2. UI renders <PermissionDialog/> while `pending()` is defined.
 *   3. user presses a/l/d -> host calls `resolve(decision)` -> the Promise
 *      resolves, pending clears, subscribers notified.
 *
 * Only one request is pending at a time; a second `askPermission` call while
 * one is already pending throws (programmer error — the agent loop must be
 * serialized).
 */
export interface ApprovalBridge {
  /** Passed straight into runAgentLoop input.askPermission. Suspends until UI resolves. */
  askPermission(req: PermissionRequest): Promise<PermissionDecision>
  /** The request awaiting a user decision, if any. */
  pending(): PermissionRequest | undefined
  /** Resolve the pending request; no-op if none. */
  resolve(decision: PermissionDecision): void
  /** subscribe(listener) -> unsubscribe; fires when pending changes. */
  subscribe(listener: () => void): () => void
}

interface Pending {
  req: PermissionRequest
  resolve: (decision: PermissionDecision) => void
}

export function createApprovalBridge(): ApprovalBridge {
  let pending: Pending | undefined = undefined
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const l of listeners) l()
  }

  return {
    askPermission(req: PermissionRequest): Promise<PermissionDecision> {
      if (pending !== undefined) {
        // Programmer error: the agent loop is not allowed to issue a second
        // gated action before the previous one is resolved.
        throw new Error(
          "ApprovalBridge.askPermission: a request is already pending",
        )
      }
      return new Promise<PermissionDecision>((resolve) => {
        pending = { req, resolve }
        notify()
      })
    },

    pending(): PermissionRequest | undefined {
      return pending?.req
    },

    resolve(decision: PermissionDecision): void {
      if (pending === undefined) return
      const p = pending
      pending = undefined
      notify()
      p.resolve(decision)
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
