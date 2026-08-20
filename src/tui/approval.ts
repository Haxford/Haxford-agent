import type {
  PermissionDecision,
  PermissionRequest,
} from "../types/tool.ts"

/**
 * Bridge between the agent loop's `askPermission` (which awaits a decision via
 * Promise) and the Ink UI (which renders a dialog and reacts to keypresses).
 *
 * Requests are a FIFO queue so parallel tool calls — first-class in the loop —
 * each get their own prompt without the bridge throwing. The UI renders the
 * head (`pending()`); resolving the head advances the next one to the head and
 * notifies subscribers. `cancel()` resolves every queued request as `deny`
 * (the host calls it on abort/exit).
 */
export interface ApprovalBridge {
  /** Passed straight into runAgentLoop input.askPermission. Suspends until UI resolves. Never throws for concurrency. */
  askPermission(req: PermissionRequest): Promise<PermissionDecision>
  /** The request currently awaiting a user decision (queue head), if any. */
  pending(): PermissionRequest | undefined
  /** Resolve the head request; no-op if the queue is empty. */
  resolve(decision: PermissionDecision): void
  /** Resolve ALL queued requests as `deny` (abort/exit). Returns the count cancelled. */
  cancel(): number
  /** subscribe(listener) -> unsubscribe; fires when the head changes. */
  subscribe(listener: () => void): () => void
}

interface Pending {
  req: PermissionRequest
  resolve: (decision: PermissionDecision) => void
}

export function createApprovalBridge(): ApprovalBridge {
  /** FIFO queue of outstanding requests. The head is the one the UI renders. */
  const queue: Pending[] = []
  const listeners = new Set<() => void>()

  const notify = (): void => {
    for (const l of listeners) l()
  }

  return {
    askPermission(req: PermissionRequest): Promise<PermissionDecision> {
      return new Promise<PermissionDecision>((resolve) => {
        const wasHead = queue.length === 0
        queue.push({ req, resolve })
        // Only notify when the head changed — subscribers care about what the
        // dialog renders, not about deeper queue entries.
        if (wasHead) notify()
      })
    },

    pending(): PermissionRequest | undefined {
      return queue[0]?.req
    },

    resolve(decision: PermissionDecision): void {
      const head = queue.shift()
      if (head === undefined) return
      // Resolve synchronously, then notify so subscribers re-render. The head
      // always changes (either advances to the next request or clears to
      // undefined), so listeners must always hear about it.
      head.resolve(decision)
      notify()
    },

    cancel(): number {
      if (queue.length === 0) return 0
      const count = queue.length
      // Drain in order, resolving each as deny. Subscribers see the head clear
      // exactly once.
      while (queue.length > 0) {
        const head = queue.shift()!
        head.resolve("deny")
      }
      notify()
      return count
    },

    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
