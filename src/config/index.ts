import path from "node:path"
import { stat } from "node:fs/promises"
import { LOCAL_SETTINGS_FILE } from "../permission/engine.ts"
import type { PermissionRules } from "../types/config.ts"
import type { HaxfordConfig } from "../types/config.ts"

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
  /** Verbatim contents of AGENTS.md in the project root, if present. */
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

async function readJsonFile(file: string): Promise<Partial<HaxfordConfig>> {
  const f = Bun.file(file)
  if (!(await f.exists())) return {}
  try {
    return (await f.json()) as Partial<HaxfordConfig>
  } catch {
    return {}
  }
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
  const merged: PermissionRules = { ...base }
  for (const [tool, rule] of Object.entries(over ?? {})) {
    const existing = merged[tool]
    merged[tool] =
      typeof existing === "object" && typeof rule === "object"
        ? { ...existing, ...rule }
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
  globalConfig: Partial<HaxfordConfig>,
  projectConfig: Partial<HaxfordConfig>,
  localConfig: Partial<HaxfordConfig>,
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

  const config: HaxfordConfig = {
    ...global,
    ...project,
    ...local,
    providers: { ...global.providers, ...project.providers, ...local.providers },
    permission: mergePermission(
      mergePermission(global.permission, project.permission),
      local.permission,
    ),
  }

  const warnings = await collectWarnings(
    globalPath,
    projectPath,
    localPath,
    global,
    project,
    local,
  )

  const agentsFile = Bun.file(path.join(cwd, "AGENTS.md"))
  const projectInstructions = (await agentsFile.exists())
    ? await agentsFile.text()
    : undefined

  return { config, projectInstructions, warnings }
}
