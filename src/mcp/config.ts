import { join } from "node:path"

/** One server entry from `mcpServers` in an mcp.json file. */
export interface McpServerConfig {
  command: string
  args?: string[]
  env?: Record<string, string>
  /**
   * Which layer defined this server.
   *
   * `project` means it came from `<cwd>/.haxford/mcp.json`, which arrives
   * with any repository you clone — see `autoStart` handling in `startMcp`.
   */
  source?: "global" | "project"
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>
  /** Eagerly connect (and bridge tools) at startup. Default true. */
  autoStart: boolean
}

export interface LoadedMcpConfig {
  config: McpConfig
  /** Malformed entries and load failures, as user-facing strings. Never throws. */
  warnings: string[]
}

const CONFIG_FILENAME = "mcp.json"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Parse one `mcpServers.<name>` entry. Returns null (with a warning) for anything malformed. */
function parseServer(
  name: string,
  raw: unknown,
  source: string,
  warnings: string[],
): McpServerConfig | null {
  if (!isRecord(raw)) {
    warnings.push(`${source}: mcpServers.${name} must be an object`)
    return null
  }

  const command = raw["command"]
  if (typeof command !== "string" || command.trim().length === 0) {
    warnings.push(`${source}: mcpServers.${name}.command must be a non-empty string`)
    return null
  }

  let args: string[] | undefined
  const rawArgs = raw["args"]
  if (rawArgs !== undefined) {
    if (!Array.isArray(rawArgs) || !rawArgs.every((a) => typeof a === "string")) {
      warnings.push(`${source}: mcpServers.${name}.args must be an array of strings`)
      return null
    }
    args = rawArgs as string[]
  }

  let env: Record<string, string> | undefined
  const rawEnv = raw["env"]
  if (rawEnv !== undefined) {
    if (!isRecord(rawEnv) || !Object.values(rawEnv).every((v) => typeof v === "string")) {
      warnings.push(`${source}: mcpServers.${name}.env must be an object of strings`)
      return null
    }
    env = rawEnv as Record<string, string>
  }

  return {
    command: command.trim(),
    ...(args !== undefined ? { args } : {}),
    ...(env !== undefined ? { env } : {}),
  }
}

interface Layer {
  servers: Record<string, McpServerConfig>
  autoStart?: boolean
}

async function readLayer(
  path: string,
  source: "global" | "project",
  warnings: string[],
): Promise<Layer> {
  const file = Bun.file(path)
  if (!(await file.exists())) return { servers: {} }

  let parsed: unknown
  try {
    parsed = await file.json()
  } catch (error) {
    warnings.push(
      `${path}: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
    return { servers: {} }
  }
  if (!isRecord(parsed)) {
    warnings.push(`${path}: must be a JSON object`)
    return { servers: {} }
  }

  const servers: Record<string, McpServerConfig> = {}
  const rawServers = parsed["mcpServers"]
  if (rawServers !== undefined) {
    if (!isRecord(rawServers)) {
      warnings.push(`${path}: mcpServers must be an object`)
    } else {
      for (const [name, entry] of Object.entries(rawServers)) {
        const server = parseServer(name, entry, path, warnings)
        if (server) servers[name] = { ...server, source }
      }
    }
  }

  let autoStart: boolean | undefined
  const rawAutoStart = parsed["autoStart"]
  if (rawAutoStart !== undefined) {
    if (typeof rawAutoStart !== "boolean") {
      warnings.push(`${path}: autoStart must be a boolean`)
    } else {
      autoStart = rawAutoStart
    }
  }

  return { servers, ...(autoStart !== undefined ? { autoStart } : {}) }
}

/**
 * Load and merge MCP server config: `~/.haxford/mcp.json` (global) then
 * `<cwd>/.haxford/mcp.json` (project). Project entries win per server name on
 * conflict; `autoStart` from the project layer wins when set, else the
 * global one, else the default (true).
 *
 * Malformed entries are dropped with a warning rather than failing the whole
 * file — one bad server definition should not cost the user every other one.
 */
export async function loadMcpConfig(cwd: string): Promise<LoadedMcpConfig> {
  const warnings: string[] = []
  const globalPath = join(Bun.env.HOME ?? "~", ".haxford", CONFIG_FILENAME)
  const projectPath = join(cwd, ".haxford", CONFIG_FILENAME)

  const global = await readLayer(globalPath, "global", warnings)
  const project = await readLayer(projectPath, "project", warnings)

  const mcpServers = { ...global.servers, ...project.servers }
  const autoStart = project.autoStart ?? global.autoStart ?? true

  return { config: { mcpServers, autoStart }, warnings }
}
