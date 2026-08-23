import path from "node:path"
import { stat } from "node:fs/promises"
import { initContextPath } from "../extend/paths.ts"
import { invalidateSecretCache } from "./secrets.ts"
import { LOCAL_SETTINGS_FILE } from "../permission/engine.ts"
import type { TrustConfig } from "../permission/engine.ts"
import type { PermissionAction, PermissionRules } from "../types/config.ts"
import type { HaxfordConfig } from "../types/config.ts"

export type { TrustConfig }

/**
 * The `permission` section as it may be written on disk: per-tool rules, plus
 * an optional `trust` block scoping what auto mode may do unattended.
 *
 * `trust` cannot live in `PermissionRules` itself — that type is frozen in
 * `src/types/config.ts` and every value in it is a `PermissionAction` or a
 * pattern record. So it is declared here, parsed out of the raw file by
 * `readTrust`, and stripped from the rules by `stripTrust` before anything
 * downstream sees them; `LoadedConfig.trust` carries it instead.
 */
export interface PermissionSection {
  /** Scoped trust for auto mode. Not a tool rule. */
  trust?: TrustConfig
  [tool: string]:
    | PermissionAction
    | Record<string, PermissionAction>
    | TrustConfig
    | undefined
}

/**
 * `HaxfordConfig` as it appears in a config file, before the fields the frozen
 * contract has no room for are split off.
 *
 * Two of them: `permission.trust` (see above) and `theme`. Both are real
 * user-facing settings that `src/types/config.ts` does not declare, and that
 * file is frozen — so they are parsed out here and carried on `LoadedConfig`
 * instead of being smuggled into `HaxfordConfig`.
 */
export interface HaxfordConfigFile extends Omit<HaxfordConfig, "permission"> {
  permission?: PermissionSection
  /** Name of a theme in `~/.haxford/themes`. `HAXFORD_THEME` overrides it. */
  theme?: string
}

/** The reserved top-level key that selects a theme, not part of `HaxfordConfig`. */
const THEME_KEY = "theme"

/** Project-level standing context, alongside the shared `AGENTS.md`. */
export const PROJECT_CONTEXT_FILE = ".haxfordcontext"

/** Read `theme` out of one config layer, ignoring anything that is not a name. */
function readThemeName(config: Partial<HaxfordConfigFile>): string | undefined {
  const value: unknown = config[THEME_KEY]
  if (typeof value !== "string") return undefined
  const name = value.trim()
  return name.length > 0 ? name : undefined
}

/** The reserved key in `permission` that is a trust block, not a tool. */
const TRUST_KEY = "trust"

/** Strings from an untrusted config file: anything not a string is dropped. */
function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
  return items.length > 0 ? items : undefined
}

/**
 * Read `permission.trust` out of one config layer.
 *
 * Returns undefined unless the block names at least one path or command:
 * absent trust means "auto mode is unscoped", and a block that scopes nothing
 * would silently turn auto mode into build mode.
 */
function readTrust(config: Partial<HaxfordConfigFile>): TrustConfig | undefined {
  const permission: unknown = config.permission
  if (typeof permission !== "object" || permission === null) return undefined
  const block: unknown = (permission as Record<string, unknown>)[TRUST_KEY]
  if (typeof block !== "object" || block === null || Array.isArray(block)) {
    return undefined
  }

  const paths = stringList((block as Record<string, unknown>)["paths"])
  const commands = stringList((block as Record<string, unknown>)["commands"])
  if (paths === undefined && commands === undefined) return undefined

  return {
    ...(paths !== undefined ? { paths } : {}),
    ...(commands !== undefined ? { commands } : {}),
  }
}

/**
 * Merge two trust blocks. Scopes are additive, because each layer is the same
 * user widening their own trust — a project saying "also trust `bun test`"
 * should not silently revoke what the global config already trusted.
 */
function mergeTrust(
  base: TrustConfig | undefined,
  over: TrustConfig | undefined,
): TrustConfig | undefined {
  if (base === undefined) return over
  if (over === undefined) return base
  const paths = [...new Set([...(base.paths ?? []), ...(over.paths ?? [])])]
  const commands = [
    ...new Set([...(base.commands ?? []), ...(over.commands ?? [])]),
  ]
  return {
    ...(paths.length > 0 ? { paths } : {}),
    ...(commands.length > 0 ? { commands } : {}),
  }
}

/**
 * The permission rules of one layer with the `trust` block removed, so no
 * consumer ever sees a "tool" called trust.
 */
function stripTrust(
  config: Partial<HaxfordConfigFile>,
): PermissionRules | undefined {
  const rules = config.permission
  if (rules === undefined) return undefined
  const { [TRUST_KEY]: _trust, ...rest } = rules
  // `PermissionSection`'s index signature admits `undefined` (so `trust?:` can
  // be declared alongside it); `PermissionRules`' does not. Removing the one
  // optional key is exactly what makes the cast sound.
  return rest as PermissionRules
}

/**
 * Global config: ~/.config/haxford/haxford.json.
 * Project config: ./haxford.json.
 * Project-local settings: ./.haxford/settings.local.json — written by the
 * permission engine when the user answers "always", so it is machine-local
 * and should not be committed.
 *
 * Precedence (later wins on scalar conflicts; permission rules merge per
 * pattern): global < project < project-local. For provider credentials this
 * means a project `./haxford.json` can override a global key — convenient
 * for per-project proxies, but a footgun for accidental commits, which is
 * why `warnings` flags any apiKey set in project config.
 */
export interface LoadedConfig {
  config: HaxfordConfig
  /**
   * The merged `permission.trust` block, split out of `config.permission`
   * (which is typed as tool rules only). Pass it to `createAskHandler` as
   * `trust` to scope auto mode; undefined leaves auto mode unscoped.
   */
  trust?: TrustConfig
  /**
   * The `theme` field, split out of the config file for the same reason as
   * `trust`: `HaxfordConfig` is frozen and has no room for it. This is the
   * theme *name*; `HAXFORD_THEME` still overrides it, which is why resolving
   * it is `activeThemeName`'s job and not this loader's.
   */
  theme?: string
  /**
   * Standing context prepended to every session: `~/.haxford/init.md`, then
   * the project's `AGENTS.md`, then `<cwd>/.haxfordcontext` — joined with a
   * blank line, each trimmed, missing sources skipped. Undefined when none of
   * the three exist. See `loadStandingContext`.
   */
  projectInstructions?: string
  /**
   * Security and hygiene warnings discovered during loading: project-config
   * apiKeys, world-readable credential files, unknown providers without a
   * baseURL. The caller surfaces these as notice events (interactive) or
   * stderr lines (print mode) before the first turn.
   */
  warnings: string[]
}

function configDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const base = xdg && xdg.length > 0 ? xdg : path.join(Bun.env.HOME ?? "~", ".config")
  return path.join(base, "haxford")
}

async function readJsonFile(file: string): Promise<Partial<HaxfordConfigFile>> {
  const f = Bun.file(file)
  if (!(await f.exists())) return {}
  try {
    return (await f.json()) as Partial<HaxfordConfigFile>
  } catch {
    return {}
  }
}

/**
 * Keys that are not data when assigned to a plain object.
 *
 * Config files are untrusted — `.haxford/settings.local.json` explicitly so,
 * and `./haxford.json` arrives with any repository you clone. `JSON.parse`
 * makes `__proto__` an ordinary own property, but `merged[tool] = rule`
 * *assigns* it, which sets the merged object's prototype instead. A project
 * config of `{"permission": {"__proto__": {"bash": "allow"}}}` would then
 * answer `rules["bash"]` with "allow" through the prototype chain and hand
 * the model unattended shell access it was never granted.
 *
 * They are dropped rather than escaped: no tool is called `__proto__`, so
 * nothing legitimate is lost.
 */
const POISON_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
])

/** A copy of a rule record with prototype-bearing keys removed. */
function sanitize<T extends object>(record: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (POISON_KEYS.has(key)) continue
    out[key] = value
  }
  return out as T
}

/**
 * Merge permission rules one tool at a time.
 *
 * A shallow spread would let a file that names a single `bash` pattern
 * replace every bash rule from a lower-precedence file — which is exactly
 * what the local settings file does on every "always" answer. Two pattern
 * records merge per pattern instead; a bare action on either side still
 * replaces the whole entry, because a bare action is a statement about the
 * tool as a whole.
 */
function mergePermission(
  base: PermissionRules | undefined,
  over: PermissionRules | undefined,
): PermissionRules {
  const merged: PermissionRules = base === undefined ? {} : sanitize(base)
  for (const [tool, rule] of Object.entries(over ?? {})) {
    if (POISON_KEYS.has(tool)) continue
    const existing = merged[tool]
    merged[tool] =
      typeof existing === "object" && typeof rule === "object"
        ? { ...sanitize(existing), ...sanitize(rule) }
        : rule
  }
  return merged
}

/**
 * Known built-in provider names. A provider entry in config that is not in
 * this set MUST have a `baseURL` — otherwise `resolveModel` cannot construct
 * a client for it and will throw at request time. Catching it here gives the
 * user a clear warning before they start a session that will fail.
 */
const KNOWN_PROVIDERS = new Set([
  "anthropic", "openai", "openrouter", "ollama", "zai", "moonshot", "opencode", "codex",
])

/**
 * Warn when a file containing credentials is world- or group-readable.
 *
 * Returns null when the stat cannot be read (file does not exist or is
 * inaccessible) so callers can skip the check rather than surfacing an error
 * about a file that might not even hold secrets.
 */
async function fileMode(file: string): Promise<number | null> {
  try {
    const s = await stat(file)
    return s.mode
  } catch {
    return null
  }
}

/**
 * Collect security warnings by inspecting the three config layers.
 *
 * - Project config with `providers.X.apiKey` is flagged because
 *   `./haxford.json` is easy to accidentally commit. The user should keep
 *   keys in env vars or global config instead.
 * - Credential-bearing files that are world- or group-readable are flagged
 *   so the user can `chmod 600` them.
 * - Unknown provider names without a `baseURL` are flagged because they
 *   cannot resolve to a working client.
 */
async function collectWarnings(
  globalPath: string,
  projectPath: string,
  localPath: string,
  globalConfig: Partial<HaxfordConfigFile>,
  projectConfig: Partial<HaxfordConfigFile>,
  localConfig: Partial<HaxfordConfigFile>,
): Promise<string[]> {
  const warnings: string[] = []

  for (const [name, entry] of Object.entries(projectConfig.providers ?? {})) {
    if (entry.apiKey && entry.apiKey.trim().length > 0) {
      warnings.push(
        `providers.${name}.apiKey is set in project config (${projectPath}). ` +
          `This file is easy to accidentally commit to git. Move the key to an ` +
          `environment variable or global config (${globalPath}) instead.`,
      )
    }
  }

  for (const [name, entry] of Object.entries(localConfig.providers ?? {})) {
    if (entry.apiKey && entry.apiKey.trim().length > 0) {
      warnings.push(
        `providers.${name}.apiKey is set in ${localPath}. ` +
          `That file is machine-local but not gitignored — move the key to an ` +
          `environment variable or global config instead.`,
      )
    }
  }

  for (const [name, entry] of Object.entries(globalConfig.providers ?? {})) {
    if (!entry.apiKey) continue
    const mode = await fileMode(globalPath)
    if (mode !== null && (mode & 0o077) !== 0) {
      const perms = (mode & 0o777).toString(8)
      warnings.push(
        `${globalPath} (containing providers.${name}.apiKey) is mode ${perms} — ` +
          `group or world can read it. Run: chmod 600 ${globalPath}`,
      )
    }
  }

  for (const configs of [globalConfig, projectConfig, localConfig]) {
    for (const [name, entry] of Object.entries(configs.providers ?? {})) {
      if (KNOWN_PROVIDERS.has(name)) continue
      if (!entry.baseURL || entry.baseURL.trim().length === 0) {
        warnings.push(
          `Provider ${JSON.stringify(name)} in config is not a known built-in and has ` +
            `no baseURL — resolveModel will not be able to construct a client for it. ` +
            `Add a baseURL or use a known provider name.`,
        )
      }
    }
  }

  return warnings
}

/**
 * Read a text file, or undefined when it is absent or unreadable.
 *
 * Standing context is a convenience, never a precondition: a file that is
 * missing, a directory, or unreadable because of its permissions costs the
 * user that one source and nothing else. Failing the whole config load over
 * an optional file would be the wrong trade.
 */
async function readOptionalText(file: string): Promise<string | undefined> {
  try {
    const handle = Bun.file(file)
    if (!(await handle.exists())) return undefined
    const text = await handle.text()
    return text.trim().length > 0 ? text.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * The standing context prepended to every session, composed from three files.
 *
 * In order, most general to most specific — which is both how a reader would
 * want them and what keeps the prompt cacheable:
 *
 * 1. `~/.haxford/init.md` — the user's own instructions, identical in every
 *    project, so it sits first and the cached prefix survives a directory
 *    change.
 * 2. `<cwd>/AGENTS.md` — the project's convention contract, shared with the
 *    repository and its other contributors.
 * 3. `<cwd>/.haxfordcontext` — project-level standing context that is *not*
 *    the shared contract: local notes, current focus, things a contributor
 *    would not commit.
 *
 * Sections are joined with a blank line and each is trimmed, so a file that
 * ends with three newlines does not push the next one down the prompt. Every
 * source is optional; all three absent yields undefined, which is what the
 * caller already treats as "no project instructions".
 */
async function loadStandingContext(cwd: string): Promise<string | undefined> {
  const sources = [
    initContextPath(),
    path.join(cwd, "AGENTS.md"),
    path.join(cwd, PROJECT_CONTEXT_FILE),
  ]

  const sections: string[] = []
  for (const file of sources) {
    const text = await readOptionalText(file)
    if (text !== undefined) sections.push(text)
  }

  return sections.length > 0 ? sections.join("\n\n") : undefined
}

/**
 * Load config in precedence order: global, then project, then project-local.
 * Later files win on scalar conflicts; permission rules merge per pattern.
 * Security warnings are returned so the caller can surface them before the
 * first turn.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const globalPath = path.join(configDir(), "haxford.json")
  const projectPath = path.join(cwd, "haxford.json")
  const localPath = path.join(cwd, LOCAL_SETTINGS_FILE)

  const global = await readJsonFile(globalPath)
  const project = await readJsonFile(projectPath)
  const local = await readJsonFile(localPath)

  // `theme` is pulled out rather than spread through: `HaxfordConfig` does not
  // declare it, and leaving it on the object would put a field on the frozen
  // contract by the back door.
  const { [THEME_KEY]: _g, ...globalRest } = global
  const { [THEME_KEY]: _p, ...projectRest } = project
  const { [THEME_KEY]: _l, ...localRest } = local

  const config: HaxfordConfig = {
    ...globalRest,
    ...projectRest,
    ...localRest,
    providers: { ...global.providers, ...project.providers, ...local.providers },
    permission: mergePermission(
      mergePermission(stripTrust(global), stripTrust(project)),
      stripTrust(local),
    ),
  }

  // Last layer that names one wins — a theme is a single choice, not a set.
  const theme =
    readThemeName(local) ?? readThemeName(project) ?? readThemeName(global)

  const trust = mergeTrust(
    mergeTrust(readTrust(global), readTrust(project)),
    readTrust(local),
  )

  const warnings = await collectWarnings(
    globalPath,
    projectPath,
    localPath,
    global,
    project,
    local,
  )

  const projectInstructions = await loadStandingContext(cwd)

  return {
    config,
    ...(trust !== undefined ? { trust } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(projectInstructions !== undefined ? { projectInstructions } : {}),
    warnings,
  }
}

/**
 * Persist a provider credential to the global config file (never the project
 * config - that risks accidental commits). The file is chmod 600 after write.
 */
export async function saveGlobalProviderCredential(
  provider: string,
  apiKey: string,
  baseURL?: string,
): Promise<void> {
  const file = path.join(configDir(), "haxford.json")
  const existing = await readJsonFile(file)
  const providers: Record<string, { apiKey?: string; baseURL?: string }> = {
    ...(existing.providers ?? {}),
  }
  providers[provider] = {
    ...providers[provider],
    apiKey,
    ...(baseURL !== undefined && baseURL.trim() !== "" ? { baseURL } : {}),
  }
  await Bun.write(file, JSON.stringify({ ...existing, providers }, null, 2) + "\n")
  const fs = await import("node:fs")
  fs.chmodSync(file, 0o600)
  // The new key must be redactable from tool output straight away.
  invalidateSecretCache()
}
