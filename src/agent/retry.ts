/**
 * Transient-failure handling for model calls.
 *
 * Providers fail constantly for reasons that have nothing to do with the
 * request: rate limits, 5xx blips, load-balancer timeouts, dropped sockets,
 * streams that end before they say they are done. Ending the run on those is
 * the single most common way an agent harness feels unreliable.
 *
 * The classifier deliberately owns this rather than delegating to the AI SDK's
 * own `maxRetries`: the SDK retries anything the provider marks retryable,
 * which includes 429s raised because an account is out of credit. Retrying
 * those burns the backoff budget on a request that cannot succeed until a
 * human tops up the account, and hides the real reason from the user.
 */

/** How many times to try, and how long to wait between attempts. */
export interface RetryPolicy {
  /** Total attempts including the first. 3 => the original plus two retries. */
  maxAttempts: number
  /** First backoff, doubled each attempt: 2s, 4s, 8s… */
  baseDelayMs: number
  /** Ceiling for any single wait, including a server-requested one. */
  maxDelayMs: number
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 60_000,
}

/** What the classifier decided about one failure. */
export interface Retryability {
  retryable: boolean
  /** Short human-readable cause, for the notice shown between attempts. */
  label: string
  /** Server-requested wait (Retry-After), when it gave one. */
  retryAfterMs?: number
}

/* -------------------------------------------------------------------------- */
/* Error shape probing                                                         */
/* -------------------------------------------------------------------------- */

function fieldOf(error: unknown, key: string): unknown {
  if (typeof error !== "object" || error === null) return undefined
  return (error as Record<string, unknown>)[key]
}

/** HTTP status from an AI SDK APICallError or any error carrying one. */
function statusOf(error: unknown): number | undefined {
  for (const key of ["statusCode", "status"]) {
    const value = fieldOf(error, key)
    if (typeof value === "number" && Number.isFinite(value)) return value
  }
  return undefined
}

function headersOf(error: unknown): Record<string, string> | undefined {
  const value = fieldOf(error, "responseHeaders")
  return typeof value === "object" && value !== null
    ? (value as Record<string, string>)
    : undefined
}

/**
 * Flatten an error, its causes and its response body into one lowercase
 * haystack.
 *
 * `responseBody` matters as much as `message`: the AI SDK sets the message to
 * the bare HTTP status text ("Too Many Requests") and leaves the provider's
 * actual explanation — the part that says whether this is throttling or an
 * empty wallet — in the raw body.
 */
function textOf(error: unknown, depth = 0): string {
  if (depth > 4 || error === null || error === undefined) return ""
  if (typeof error === "string") return error.toLowerCase()

  const parts: string[] = []
  if (error instanceof Error) {
    parts.push(error.name, error.message)
  } else {
    const message = fieldOf(error, "message")
    if (typeof message === "string") parts.push(message)
  }
  const body = fieldOf(error, "responseBody")
  if (typeof body === "string") parts.push(body)
  parts.push(textOf(fieldOf(error, "cause"), depth + 1))

  return parts.join(" ").toLowerCase()
}

/**
 * `Retry-After` in ms. The header is either delta-seconds or an HTTP date.
 * Returns undefined when absent or unparseable.
 */
function retryAfterOf(error: unknown): number | undefined {
  const headers = headersOf(error)
  if (!headers) return undefined

  let raw: string | undefined
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "retry-after") {
      raw = value
      break
    }
  }
  if (typeof raw !== "string" || raw.trim() === "") return undefined

  const seconds = Number(raw.trim())
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000

  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.max(0, date - Date.now())
  return undefined
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

/** Statuses worth trying again: overload, throttling, gateway and timeout. */
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524])

/**
 * A 429 that means "you have run out of money/quota", not "you are going too
 * fast". Waiting cannot fix these, so fail immediately with the provider's own
 * wording rather than stalling for the full backoff first.
 */
const QUOTA_MARKERS = [
  "insufficient_quota",
  "insufficient quota",
  "exceeded your current quota",
  "credit balance",
  "out of credits",
  "billing",
  "payment required",
  "purchase",
  "upgrade your plan",
  "usage limit",
  "quota exceeded",
]

/** Transport failures — the request never got a clean answer. */
const NETWORK_MARKERS = [
  "econnreset",
  "econnrefused",
  "epipe",
  "etimedout",
  "eai_again",
  "socket connection was closed",
  "socket hang up",
  "connection closed",
  "connection error",
  "network error",
  "fetch failed",
  "terminated",
  "premature close",
  "stream ended unexpectedly",
  "the connection was likely interrupted",
]

const TIMEOUT_MARKERS = ["timeout", "timed out", "headers timeout", "body timeout"]

/**
 * Decide whether a failed model call is worth retrying.
 *
 * Errors that indicate a malformed request, a bad key, or an exhausted account
 * are fatal: retrying them wastes the user's time and hides the real cause.
 * Everything transient — throttling, server errors, dropped connections,
 * streams that ended early — is retryable.
 */
export function classifyFailure(error: unknown): Retryability {
  const haystack = textOf(error)

  // A user-initiated abort is never a failure to retry.
  if (
    (error instanceof Error && error.name === "AbortError") ||
    haystack.includes("aborterror")
  ) {
    return { retryable: false, label: "aborted" }
  }

  const status = statusOf(error)
  const retryAfterMs = retryAfterOf(error)
  const withDelay = (base: Retryability): Retryability =>
    retryAfterMs !== undefined ? { ...base, retryAfterMs } : base

  if (status !== undefined) {
    if (status === 429) {
      if (QUOTA_MARKERS.some((marker) => haystack.includes(marker))) {
        return { retryable: false, label: "quota or billing limit reached" }
      }
      return withDelay({ retryable: true, label: "rate limited (429)" })
    }
    if (RETRYABLE_STATUS.has(status)) {
      return withDelay({
        retryable: true,
        label: status >= 500 ? `provider error (${status})` : `transient ${status}`,
      })
    }
    // 4xx that is not in the retryable set is our fault, not the provider's.
    if (status >= 400 && status < 500) {
      return { retryable: false, label: `request rejected (${status})` }
    }
  }

  if (NETWORK_MARKERS.some((marker) => haystack.includes(marker))) {
    return withDelay({ retryable: true, label: "connection dropped" })
  }
  if (TIMEOUT_MARKERS.some((marker) => haystack.includes(marker))) {
    return withDelay({ retryable: true, label: "request timed out" })
  }
  if (haystack.includes("overloaded")) {
    return withDelay({ retryable: true, label: "provider overloaded" })
  }

  // The SDK's own verdict, when it has one and nothing above matched.
  if (fieldOf(error, "isRetryable") === true) {
    return withDelay({ retryable: true, label: "transient provider error" })
  }

  return { retryable: false, label: "unrecoverable error" }
}

/* -------------------------------------------------------------------------- */
/* Backoff                                                                     */
/* -------------------------------------------------------------------------- */

/** What the caller is told before each backoff wait. */
export interface RetryNotice {
  /** The attempt that just failed, 1-based. */
  attempt: number
  maxAttempts: number
  delayMs: number
  /** Short cause from the classifier, e.g. "rate limited (429)". */
  label: string
  /** The provider's own message, for logs. */
  detail: string
}


/**
 * Wait before attempt N+1: exponential from `baseDelayMs`, with ±25% jitter so
 * a fleet of agents throttled at the same moment does not retry in lockstep.
 *
 * A server-requested `Retry-After` wins outright — it knows when the window
 * reopens and we do not. Returns undefined when the server asks for longer
 * than the policy allows: waiting minutes inside an interactive turn is worse
 * than failing with a message the user can act on.
 */
export function nextDelay(
  attempt: number,
  policy: RetryPolicy,
  retryAfterMs?: number,
): number | undefined {
  if (retryAfterMs !== undefined) {
    return retryAfterMs > policy.maxDelayMs ? undefined : retryAfterMs
  }
  const exponential = policy.baseDelayMs * 2 ** Math.max(0, attempt - 1)
  const capped = Math.min(exponential, policy.maxDelayMs)
  const jitter = capped * 0.25 * (Math.random() * 2 - 1)
  return Math.max(0, Math.round(capped + jitter))
}

/** Sleep that gives up as soon as the run is aborted. */
export function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/* -------------------------------------------------------------------------- */
/* Non-streaming helper                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Decide whether `error` on attempt N earns another try, and how long to wait.
 *
 * The single decision point: the streaming loop and the one-shot helper both
 * go through here, so they cannot drift apart on what counts as transient.
 * Returns undefined when the run should fail — budget exhausted, aborted, a
 * fatal error, or a server asking us to wait longer than the policy allows.
 */
export function planRetry(
  error: unknown,
  attempt: number,
  policy: RetryPolicy,
  signal?: AbortSignal,
): RetryNotice | undefined {
  if (signal?.aborted) return undefined
  if (attempt >= policy.maxAttempts) return undefined

  const verdict = classifyFailure(error)
  if (!verdict.retryable) return undefined

  const delayMs = nextDelay(attempt, policy, verdict.retryAfterMs)
  if (delayMs === undefined) return undefined

  return {
    attempt,
    maxAttempts: policy.maxAttempts,
    delayMs,
    label: verdict.label,
    detail: error instanceof Error ? error.message : String(error),
  }
}

/**
 * Run a one-shot model call, retrying transient failures with backoff.
 *
 * For streaming turns the loop does this inline instead — it can only retry
 * while nothing has been shown to the user yet, which this helper cannot know.
 */
export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  opts: {
    policy?: RetryPolicy
    signal?: AbortSignal
    onRetry?: (notice: RetryNotice) => void
  } = {},
): Promise<T> {
  const policy = opts.policy ?? DEFAULT_RETRY_POLICY

  for (let attempt = 1; ; attempt++) {
    try {
      return await operation(attempt)
    } catch (error) {
      const plan = planRetry(error, attempt, policy, opts.signal)
      if (!plan) throw error

      opts.onRetry?.(plan)
      await sleepWithAbort(plan.delayMs, opts.signal)
      if (opts.signal?.aborted) throw error
    }
  }
}

/** Wording shared by the streaming loop and the compaction path. */
export function retryNoticeText(notice: RetryNotice): string {
  const seconds = (notice.delayMs / 1000).toFixed(notice.delayMs < 1000 ? 1 : 0)
  return (
    `${notice.label}; retrying in ${seconds}s ` +
    `(attempt ${notice.attempt + 1} of ${notice.maxAttempts})`
  )
}
