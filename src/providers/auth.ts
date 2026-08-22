import { chmodSync, readFileSync } from "node:fs"
import { Buffer } from "node:buffer"
import { homedir } from "node:os"
import { join } from "node:path"

/** Credentials the codex CLI writes after a ChatGPT login. */
export interface CodexAuth {
  accessToken: string
  accountId?: string
}

/**
 * Where the codex CLI stores its credentials: `$CODEX_HOME/auth.json`,
 * falling back to `~/.codex/auth.json` — the same resolution the CLI uses.
 */
export function codexAuthPath(): string {
  const home = Bun.env.CODEX_HOME?.trim()
  return home
    ? join(home, "auth.json")
    : join(homedir(), ".codex", "auth.json")
}

const LOGIN_HINT =
  "Install the codex CLI and run `codex login` to sign in with your ChatGPT account"

/** The parsed credential file, kept whole so a write-back can preserve it. */
interface CodexAuthFile {
  path: string
  /** The whole document, including fields we do not understand. */
  raw: Record<string, unknown>
  /** `raw.tokens` when it is an object, else an empty record. */
  tokens: Record<string, unknown>
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * Read and parse the credential file. Throws the same errors `readCodexAuth`
 * has always thrown for a missing or unparseable file; a file that parses but
 * holds no usable tokens is left for `authOf` to reject, so the "no
 * tokens.access_token" message still names the real problem.
 */
function loadAuthFile(path: string): CodexAuthFile {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    throw new Error(
      `No codex credentials found at ${path}. ${LOGIN_HINT}.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(
      `Could not parse codex credentials at ${path}: the file is not valid JSON. ${LOGIN_HINT} again.`,
    )
  }

  const raw = asRecord(parsed)
  return { path, raw, tokens: asRecord(raw["tokens"]) }
}

function authOf(file: CodexAuthFile): CodexAuth {
  const accessToken = nonEmptyString(file.tokens["access_token"])
  if (accessToken === undefined) {
    throw new Error(
      `Codex credentials at ${file.path} have no tokens.access_token. ${LOGIN_HINT} again.`,
    )
  }
  const accountId = nonEmptyString(file.tokens["account_id"])
  return { accessToken, ...(accountId !== undefined ? { accountId } : {}) }
}

/**
 * Read `~/.codex/auth.json`.
 *
 * Read synchronously so `resolveModel` can stay synchronous — this is a small
 * local file, and Bun has no sync equivalent of `Bun.file().json()`.
 *
 * This function never refreshes: it reports the stored `access_token` as-is,
 * so an expired token still produces the provider's 401. `ensureCodexAuth`
 * is the refreshing variant; `codexAccessToken` is the synchronous caller's
 * middle ground.
 */
export function readCodexAuth(): CodexAuth {
  return authOf(loadAuthFile(codexAuthPath()))
}

/** Non-throwing variant, for availability checks in the model picker. */
export function tryReadCodexAuth(): CodexAuth | undefined {
  try {
    return readCodexAuth()
  } catch {
    return undefined
  }
}

/* -------------------------------------------------------------------------- */
/* codex OAuth refresh                                                         */
/* -------------------------------------------------------------------------- */

/**
 * The OAuth token endpoint and client id used for the ChatGPT login.
 *
 * NOTE: these are NOT recorded anywhere in this repository — the comments
 * left when codex support landed said only that refresh was out of scope, so
 * there was nothing to read them from. They are the public values the codex
 * CLI itself uses for the same exchange. Both are overridable by environment
 * variable so a wrong constant can be corrected without a code change (and so
 * tests can point the exchange at a stub).
 */
const DEFAULT_TOKEN_URL = "https://auth.openai.com/oauth/token"
const DEFAULT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

/** Refresh this long before the token actually expires. */
const EXPIRY_SKEW_MS = 60_000

export function codexTokenUrl(): string {
  return Bun.env.CODEX_OAUTH_TOKEN_URL?.trim() || DEFAULT_TOKEN_URL
}

export function codexClientId(): string {
  return Bun.env.CODEX_OAUTH_CLIENT_ID?.trim() || DEFAULT_CLIENT_ID
}

/**
 * Normalise an expiry to epoch milliseconds.
 *
 * Accepts a number (seconds or milliseconds — anything below ~1e12 is far too
 * small to be a plausible millisecond timestamp, so it is seconds), a numeric
 * string, or an ISO date string. Anything else is "unknown", which callers
 * treat as "do not refresh".
 */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) return undefined
    return value < 1e12 ? value * 1000 : value
  }
  if (typeof value === "string") {
    const trimmed = value.trim()
    if (trimmed === "") return undefined
    const numeric = Number(trimmed)
    if (Number.isFinite(numeric) && numeric > 0) return toEpochMs(numeric)
    const parsed = Date.parse(trimmed)
    return Number.isNaN(parsed) ? undefined : parsed
  }
  return undefined
}

/** An OAuth `expires_in` duration in seconds, if it is a usable one. */
function lifetimeSeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined
}

/**
 * The `exp` claim of a JWT access token, in epoch milliseconds.
 *
 * The payload is decoded, never verified — we are reading our own stored
 * token to decide whether it is worth refreshing, not trusting a claim.
 * codex's auth.json carries no explicit expiry field, so for a real login
 * this is the only expiry there is.
 */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".")
  const payload = parts[1]
  if (parts.length !== 3 || payload === undefined) return undefined
  try {
    const json = Buffer.from(payload, "base64url").toString("utf8")
    return toEpochMs(asRecord(JSON.parse(json))["exp"])
  } catch {
    return undefined
  }
}

/**
 * When the stored access token expires, in epoch milliseconds, or undefined
 * when it cannot be determined — in which case we leave the token alone
 * rather than spending a refresh on a guess.
 */
function expiryOf(file: CodexAuthFile, accessToken: string): number | undefined {
  for (const key of ["expires_at", "expiresAt", "expires"]) {
    const fromTokens = toEpochMs(file.tokens[key])
    if (fromTokens !== undefined) return fromTokens
    const fromRoot = toEpochMs(file.raw[key])
    if (fromRoot !== undefined) return fromRoot
  }
  return jwtExpiry(accessToken)
}

/** Whether the stored token is expired or close enough to it to bother. */
function isStale(expiry: number | undefined): boolean {
  return expiry !== undefined && expiry - Date.now() <= EXPIRY_SKEW_MS
}

/**
 * Refreshes in flight, keyed by credential file path.
 *
 * Every caller resolving the codex model hits the same file, so without this
 * a burst of turns would fire a burst of refreshes — each rotating the
 * refresh token out from under the others, and the losers would write a token
 * the server has already invalidated.
 */
const inFlight = new Map<string, Promise<CodexAuth>>()

/**
 * Perform the OAuth refresh exchange and write the result back.
 *
 * Rejects on any failure (network, non-2xx, unparseable or tokenless body) so
 * callers can fall back to the stored token. No token value is ever logged or
 * put in an error message: failures name the HTTP status and nothing else.
 */
async function exchange(
  file: CodexAuthFile,
  refreshToken: string,
): Promise<CodexAuth> {
  const response = await fetch(codexTokenUrl(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      client_id: codexClientId(),
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: "openid profile email",
    }),
  })

  if (!response.ok) {
    throw new Error(`codex token refresh failed: HTTP ${response.status}`)
  }

  const payload = asRecord(await response.json())
  const accessToken = nonEmptyString(payload["access_token"])
  if (accessToken === undefined) {
    throw new Error("codex token refresh returned no access_token")
  }
  const rotated = nonEmptyString(payload["refresh_token"])
  const lifetime = lifetimeSeconds(payload["expires_in"])

  // Merge rather than replace: the file holds fields we do not model
  // (id_token, OPENAI_API_KEY, and whatever a future codex adds), and
  // dropping them would break the CLI that wrote it.
  const tokens: Record<string, unknown> = {
    ...file.tokens,
    access_token: accessToken,
    ...(rotated !== undefined ? { refresh_token: rotated } : {}),
  }
  // `expires_in` is a duration; store it as an absolute deadline so the next
  // staleness check does not have to know when this write happened. When the
  // server omits it, any previous `expires_at` is dropped rather than left
  // describing the old token — the JWT's own `exp` takes over.
  if (lifetime !== undefined) {
    tokens["expires_at"] = Date.now() + lifetime * 1000
  } else {
    delete tokens["expires_at"]
  }
  const merged: Record<string, unknown> = {
    ...file.raw,
    tokens,
    last_refresh: new Date().toISOString(),
  }

  await Bun.write(file.path, `${JSON.stringify(merged, null, 2)}\n`)
  // The file holds a bearer token; nobody else on the box needs to read it.
  try {
    chmodSync(file.path, 0o600)
  } catch {
    // A file we could write but not chmod is still a usable credential.
  }

  const accountId = nonEmptyString(tokens["account_id"])
  return { accessToken, ...(accountId !== undefined ? { accountId } : {}) }
}

/** Start (or join) the refresh for this file, falling back to `stored`. */
function refresh(
  file: CodexAuthFile,
  refreshToken: string,
  stored: CodexAuth,
): Promise<CodexAuth> {
  const existing = inFlight.get(file.path)
  if (existing !== undefined) return existing

  const task = exchange(file, refreshToken)
    // A failed refresh must not become a failed request: the caller keeps
    // using the stored token and the provider's existing 401 path handles it
    // exactly as it did before refresh existed.
    .catch(() => stored)
    .finally(() => {
      inFlight.delete(file.path)
    })

  inFlight.set(file.path, task)
  return task
}

/**
 * Read the codex credentials, refreshing the access token first when it has
 * expired (or is within a minute of it) and a refresh token is stored.
 *
 * Throws only what `readCodexAuth` throws — missing file, bad JSON, no access
 * token. A refresh that fails is not an error here: the stored token is
 * returned and the provider's 401 fallback stands.
 */
export async function ensureCodexAuth(): Promise<CodexAuth> {
  const file = loadAuthFile(codexAuthPath())
  const stored = authOf(file)

  const refreshToken = nonEmptyString(file.tokens["refresh_token"])
  if (refreshToken === undefined) return stored
  if (!isStale(expiryOf(file, stored.accessToken))) return stored

  return refresh(file, refreshToken, stored)
}

/**
 * The access token for a synchronous caller (`resolveModel`, which cannot
 * await).
 *
 * Returns the stored token immediately, exactly as before. When that token is
 * stale it also kicks off a background refresh, so the *next* model
 * resolution — the agent loop resolves once per turn — picks up the rotated
 * token from disk. This request still takes the 401 it would have taken
 * anyway; the difference is that the session recovers on its own instead of
 * needing `codex login`. Prefer `ensureCodexAuth` wherever an await is
 * possible.
 */
export function codexAccessToken(): string {
  const file = loadAuthFile(codexAuthPath())
  const stored = authOf(file)

  const refreshToken = nonEmptyString(file.tokens["refresh_token"])
  if (refreshToken !== undefined && isStale(expiryOf(file, stored.accessToken))) {
    void refresh(file, refreshToken, stored)
  }
  return stored.accessToken
}

/* -------------------------------------------------------------------------- */
/* opencode credential store                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Path to opencode's credential file: `$OPENCODE_AUTH_PATH`, else
 * `~/.local/share/opencode/auth.json`.
 */
export function opencodeAuthPath(): string {
  const override = Bun.env.OPENCODE_AUTH_PATH?.trim()
  if (override) return override
  return join(homedir(), ".local", "share", "opencode", "auth.json")
}

/**
 * Read an API key for `provider` out of opencode's credential store.
 *
 * A read-only convenience bridge: if the user already keeps their keys in
 * opencode, haxford can use them rather than making them configure the same
 * secrets twice. We never write to this file and never migrate it.
 *
 * The file maps a provider id to an entry; only `{ type: "api", key }` entries
 * are usable — `oauth` and anything else are ignored, since we cannot refresh
 * or exchange those. Every failure mode (missing file, bad JSON, missing or
 * malformed entry) returns undefined; this never throws.
 */
export function readOpencodeApiKey(provider: string): string | undefined {
  let raw: string
  try {
    raw = readFileSync(opencodeAuthPath(), "utf8")
  } catch {
    return undefined
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined

  const entry = (parsed as Record<string, unknown>)[provider]
  if (typeof entry !== "object" || entry === null) return undefined

  const { type, key } = entry as { type?: unknown; key?: unknown }
  if (type !== "api") return undefined
  if (typeof key !== "string") return undefined

  const trimmed = key.trim()
  return trimmed === "" ? undefined : trimmed
}
