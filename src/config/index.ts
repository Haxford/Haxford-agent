import path from "node:path"
import { LOCAL_SETTINGS_FILE } from "../permission/engine.ts"
import type { PermissionRules } from "../types/config.ts"
import type { HaxfordConfig } from "../types/config.ts"

/**
 * Global config: ~/.config/haxford/haxford.json.
 * Project config: ./haxford.json.
 * Project-local settings: ./.haxford/settings.local.json — written by the
 * permission engine when the user answers "always", so it is machine-local
 * and should not be committed.
 */
export interface LoadedConfig {
  config: HaxfordConfig
  /** Verbatim contents of AGENTS.md in the project root, if present. */
  projectInstructions?: string
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
 * Load config in precedence order: global, then project, then project-local.
 * Later files win on scalar conflicts; permission rules merge per pattern.
 */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const global = await readJsonFile(path.join(configDir(), "haxford.json"))
  const project = await readJsonFile(path.join(cwd, "haxford.json"))
  const local = await readJsonFile(path.join(cwd, LOCAL_SETTINGS_FILE))

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

  const agentsFile = Bun.file(path.join(cwd, "AGENTS.md"))
  const projectInstructions = (await agentsFile.exists())
    ? await agentsFile.text()
    : undefined

  return { config, projectInstructions }
}
