/**
 * The extension loader.
 *
 * `~/.haxford/extensions/*.ts` — a flat directory of modules, each default-
 * exporting `(haxford) => void`, imported in filename order so authors can
 * control sequence with a numeric prefix. Bun imports TypeScript natively, so
 * there is no build step between writing an extension and running it.
 *
 * Nothing here throws at the caller. An extension that fails to import, has
 * no default export, or explodes while registering is reported as a string
 * and skipped — a broken plugin costs you that plugin, never the session.
 */

import { readdir, unlink } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"

import { extensionsDir } from "./paths.ts"
import type { ExtensionRegistry } from "./registry.ts"

/** File suffixes treated as loadable modules. */
const LOADABLE = [".ts", ".mts", ".js", ".mjs"]

/** Prefix of the shadow copies made to defeat the module cache. See `shadow`. */
const SHADOW_PREFIX = ".haxford-reload-"

export interface ExtensionLoadResult {
  /** Basenames that loaded and ran their default export without throwing. */
  loaded: string[]
  /** Human-readable failures, one per extension that did not load. */
  errors: string[]
}

/** Reload generation, so each reload imports from a path never seen before. */
let generation = 0

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Is this a file we should try to import? */
export function isLoadableExtension(name: string): boolean {
  if (name.startsWith(".") || name.startsWith("_")) return false
  if (name.endsWith(".d.ts")) return false
  return LOADABLE.some((ext) => name.endsWith(ext))
}

/**
 * Import an extension, defeating the module cache when reloading.
 *
 * Bun 1.3 keys its module cache on the resolved path and *ignores* the query
 * string, so the usual `import(url + "?t=" + Date.now())` trick does not work
 * — a second import of an edited file returns the first version. The only
 * thing that re-evaluates is a path never imported before, so on reload we
 * write a shadow copy next to the original and import that instead.
 *
 * The copy sits in the *same directory* deliberately: an extension's own
 * `./helper.ts` imports and its node_modules lookups both resolve relative to
 * where the file lives, so a copy in a temp directory would break them. It is
 * unlinked as soon as the import resolves — the module is already evaluated
 * and held by the cache at that point.
 *
 * Known limit: this re-evaluates the *entry* file only. Modules it imports
 * keep the version first loaded, because their paths have not changed. A
 * restart is still the way to pick up edits to shared helpers.
 */
async function importExtension(dir: string, file: string, gen: number): Promise<unknown> {
  const source = path.join(dir, file)
  if (gen === 0) return await import(pathToFileURL(source).href)

  const shadowPath = path.join(dir, `${SHADOW_PREFIX}${gen}-${file}`)
  await Bun.write(shadowPath, await Bun.file(source).text())
  try {
    return await import(pathToFileURL(shadowPath).href)
  } finally {
    await unlink(shadowPath).catch(() => {})
  }
}

/** Remove shadow copies left behind by a reload that died mid-flight. */
async function sweepShadows(dir: string, names: string[]): Promise<void> {
  await Promise.all(
    names
      .filter((name) => name.startsWith(SHADOW_PREFIX))
      .map((name) => unlink(path.join(dir, name)).catch(() => {})),
  )
}

/**
 * Load every extension in the directory into `registry`.
 *
 * The registry is not cleared here — `reloadExtensions` owns that decision,
 * because clearing is also what disposes commands and tools and the caller
 * may want the old set to stay live until the new one is known good.
 */
export async function loadExtensions(
  registry: ExtensionRegistry,
  dir: string = extensionsDir(),
): Promise<ExtensionLoadResult> {
  const result: ExtensionLoadResult = { loaded: [], errors: [] }

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    // No extensions directory: nothing to load, and nothing worth saying.
    return result
  }

  await sweepShadows(dir, names)

  const gen = generation++
  const files = names.filter(isLoadableExtension).sort()

  for (const file of files) {
    try {
      const mod = (await importExtension(dir, file, gen)) as {
        default?: unknown
      }
      const entry = mod.default
      if (typeof entry !== "function") {
        result.errors.push(
          `${file}: no default export — an extension must export default function (haxford) { … }`,
        )
        continue
      }
      await (entry as (api: unknown) => unknown)(registry.apiFor(file))
      result.loaded.push(file)
    } catch (error) {
      result.errors.push(`${file}: ${errorText(error)}`)
    }
  }

  for (const message of result.errors) registry.report(message)
  return result
}

/** Reset the reload counter. Tests only — keeps shadow filenames predictable. */
export function resetExtensionGeneration(): void {
  generation = 0
}
