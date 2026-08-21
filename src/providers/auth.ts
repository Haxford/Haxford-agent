import { readFileSync } from "node:fs"
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

/**
 * Read `~/.codex/auth.json`.
 *
 * Read synchronously so `resolveModel` can stay synchronous — this is a small
 * local file, and Bun has no sync equivalent of `Bun.file().json()`.
 *
 * NOTE: token *refresh* is deliberately out of scope. We use the stored
 * `access_token` as-is; when it expires the provider returns 401 and the user
 * must re-run the codex CLI to refresh it. Implementing the OAuth refresh
 * exchange (and writing the rotated token back to auth.json) is future work.
 */
export function readCodexAuth(): CodexAuth {
  const path = codexAuthPath()

  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    throw new Error(
      `No codex credentials found at ${path}. ${LOGIN_HINT}.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `Could not parse codex credentials at ${path}: the file is not valid JSON. ${LOGIN_HINT} again.`,
    )
  }

  const tokens =
    typeof parsed === "object" && parsed !== null
      ? (parsed as { tokens?: unknown }).tokens
      : undefined
  const accessToken =
    typeof tokens === "object" && tokens !== null
      ? (tokens as { access_token?: unknown }).access_token
      : undefined

  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    throw new Error(
      `Codex credentials at ${path} have no tokens.access_token. ${LOGIN_HINT} again.`,
    )
  }

  const accountId =
    typeof tokens === "object" && tokens !== null
      ? (tokens as { account_id?: unknown }).account_id
      : undefined

  return {
    accessToken: accessToken.trim(),
    ...(typeof accountId === "string" && accountId.trim() !== ""
      ? { accountId: accountId.trim() }
      : {}),
  }
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
