import path from "node:path"
import type { HaxfordConfig } from "../types/config.ts"

/** Global config: ~/.config/haxford/haxford.json. Project config: ./haxford.json. */
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

/** Deep-merge global then project config; project wins on scalar conflicts. */
export async function loadConfig(cwd: string): Promise<LoadedConfig> {
  const global = await readJsonFile(path.join(configDir(), "haxford.json"))
  const project = await readJsonFile(path.join(cwd, "haxford.json"))

  const config: HaxfordConfig = {
    ...global,
    ...project,
    providers: { ...global.providers, ...project.providers },
    permission: { ...global.permission, ...project.permission },
  }

  const agentsFile = Bun.file(path.join(cwd, "AGENTS.md"))
  const projectInstructions = (await agentsFile.exists())
    ? await agentsFile.text()
    : undefined

  return { config, projectInstructions }
}
