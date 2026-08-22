import { readFileSync } from "node:fs"
import { dirname } from "node:path"
import { mkdir } from "node:fs/promises"
import path from "node:path"

/**
 * Project-local state: the model the user chose for this project.
 *
 * Stored in `<cwd>/.haxford/state.json` — machine-local, not committed.
 * Precedence for the active model is:
 *   1. CLI `-m <spec>` (highest — per-run override)
 *   2. Project state (`loadProjectModel`, this file)
 *   3. Global config `model` field
 *   4. `DEFAULT_MODEL_SPEC` (built-in)
 * The host resolves this; these primitives only read and write the file.
 */
const STATE_FILE = ".haxford/state.json"

/**
 * Read the persisted model spec for a project, or undefined when no state
 * file exists or it is unreadable/malformed. Never throws — a corrupt state
 * file should not block startup.
 */
export function loadProjectModel(cwd: string): string | undefined {
  const file = path.join(cwd, STATE_FILE)
  try {
    const text = readFileSync(file, "utf8")
    const parsed = JSON.parse(text) as { model?: unknown }
    const model = parsed.model
    return typeof model === "string" && model.trim().length > 0
      ? model.trim()
      : undefined
  } catch {
    return undefined
  }
}

/**
 * Persist the chosen model spec for a project so it survives restarts.
 * Creates `<cwd>/.haxford/` if needed (recursive). Never throws — a write
 * failure means the model is not remembered, not that the session dies.
 */
export async function saveProjectModel(
  cwd: string,
  modelSpec: string,
): Promise<void> {
  const file = path.join(cwd, STATE_FILE)
  await mkdir(dirname(file), { recursive: true })
  await Bun.write(file, `${JSON.stringify({ model: modelSpec }, null, 2)}\n`)
}
