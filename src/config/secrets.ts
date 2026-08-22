/**
 * Secret redaction and environment hygiene.
 *
 * API keys live in env vars, config files, and the opencode auth store.
 * Child processes inherit the parent env, so a bash command like
 * `env | grep KEY` or `echo $ANTHROPIC_API_KEY` would leak a key into
 * captured output — which then enters the model's context and is persisted
 * to the session JSONL. Two layers prevent that:
 *
 * 1. `filteredEnv()` strips haxford's own provider-credential env vars
 *    from the child process environment. Legitimate tooling that needs
 *    its own tokens (NPM_TOKEN, GH_TOKEN, …) is unaffected.
 * 2. `redactSecrets()` replaces known key patterns and any resolved key
 *    values in a string, so output that somehow contains a key is masked
 *    before it reaches the model or the session file.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import type { HaxfordConfig } from "../types/config.ts"

const REDACTED = "[REDACTED]"

/**
 * Haxford's own provider-credential env vars. These are stripped from
 * child-process environments because the model never needs them for
 * legitimate work, and leaving them exposed makes `env | grep KEY` an
 * instant key-exfiltration primitive.
 *
 * User-defined tokens (NPM_TOKEN, GH_TOKEN, …) are deliberately NOT
 * stripped — a build or publish step may need them, and the permission
 * engine gates what commands run in the first place.
 */
export const CREDENTIAL_ENV_VARS: ReadonlySet<string> = new Set([
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "Z_AI_API_KEY",
  "MOONSHOT_API_KEY",
  "OPENCODE_API_KEY",
  "OLLAMA_API_KEY",
])

/** Patterns that match common API key formats without false positives. */
const KEY_PATTERNS: readonly RegExp[] = [
  // OpenRouter: sk-or-v1-… or sk-or-…
  /sk-or-[A-Za-z0-9_-]{16,}/g,
  // OpenAI / Anthropic: sk-… (20+ chars after prefix to avoid matching "sk-1234")
  /sk-[A-Za-z0-9_-]{20,}/g,
  // Bearer tokens in headers or command output
  /[Bb]earer\s+[A-Za-z0-9._-]{16,}/g,
]

/** Collect resolved key values from env + config so they can be redacted too. */
export function collectSecretValues(config?: HaxfordConfig): string[] {
  const secrets: string[] = []

  for (const name of CREDENTIAL_ENV_VARS) {
    const value = Bun.env[name]
    if (value && value.trim().length > 0) secrets.push(value.trim())
  }

  for (const [, entry] of Object.entries(config?.providers ?? {})) {
    const key = entry.apiKey?.trim()
    if (key && key.length > 0) secrets.push(key)
  }

  // Also read keys from the opencode auth store so those values are masked
  // if they appear in captured output.
  secrets.push(...cachedAuthStoreKeys())

  return secrets
}

/**
 * Every api key in opencode's auth store.
 *
 * Reads the whole store rather than a fixed list of provider names: a key
 * that is not redacted because we did not think to name its provider is
 * exactly the leak this exists to stop, and the file is a flat map anyway.
 */
function readOpencodeKeys(): string[] {
  const authPath = Bun.env.OPENCODE_AUTH_PATH?.trim() || join(homedir(), ".local", "share", "opencode", "auth.json")
  try {
    const raw = readFileSync(authPath, "utf8")
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const keys: string[] = []
    for (const entry of Object.values(parsed)) {
      if (typeof entry !== "object" || entry === null) continue
      const { key } = entry as { key?: unknown }
      if (typeof key !== "string") continue
      const trimmed = key.trim()
      if (trimmed !== "") keys.push(trimmed)
    }
    return keys
  } catch {
    return []
  }
}

/**
 * Auth-store keys, cached for the process.
 *
 * `redactSecrets` now runs on every tool result that could carry a key, and
 * re-reading the store from disk each time made redaction cost a synchronous
 * file read per call. Only the FILE read is cached — env vars and config are
 * re-read every time, so a key exported mid-session is still masked. The
 * store changes when the user connects a provider, which calls
 * `invalidateSecretCache`.
 */
let cachedAuthKeys: string[] | undefined

/** Drop the cached auth-store keys — call after writing a new credential. */
export function invalidateSecretCache(): void {
  cachedAuthKeys = undefined
}

function cachedAuthStoreKeys(): string[] {
  if (cachedAuthKeys === undefined) cachedAuthKeys = readOpencodeKeys()
  return cachedAuthKeys
}

/**
 * Replace known key patterns and resolved secret values in a string.
 *
 * Used on bash output, error messages, and anything that might end up in
 * the session JSONL or the model's context. A redacted string is always
 * safe to show — the function never throws and always returns a string.
 */
export function redactSecrets(
  s: string,
  extraSecrets?: readonly string[],
): string {
  let result = s

  // Exact-match redaction of resolved key values first — this catches
  // keys that don't match a standard prefix (custom gateway tokens, etc.).
  const allSecrets = [...(extraSecrets ?? collectSecretValues())]
  // Sort longest-first so a short key that is a prefix of a longer one
  // doesn't mask only part of the longer value.
  allSecrets.sort((a, b) => b.length - a.length)
  for (const secret of allSecrets) {
    if (secret.length < 8) continue
    result = result.split(secret).join(REDACTED)
  }

  // Pattern-based redaction for keys we haven't resolved (e.g. echoed
  // from a file we don't read, or a different provider's key).
  for (const pattern of KEY_PATTERNS) {
    pattern.lastIndex = 0
    result = result.replace(pattern, REDACTED)
  }

  return result
}

/**
 * Return a copy of `process.env` with haxford's provider-credential vars
 * removed. Used as the `env` option for `Bun.spawn` so child processes
 * cannot read or exfiltrate the keys haxford uses to call providers.
 *
 * Non-credential env (PATH, HOME, user-set tokens, …) is passed through
 * unchanged so legitimate tooling continues to work.
 */
export function filteredEnv(): Record<string, string> {
  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (CREDENTIAL_ENV_VARS.has(key)) continue
    if (value !== undefined) filtered[key] = value
  }
  return filtered
}
