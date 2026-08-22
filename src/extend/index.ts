/**
 * Extensibility: skills, extensions and themes, loaded from `~/.haxford`.
 *
 * This is the wiring layer and the only module a host needs to import. It
 * knows about `src/tools` (to reserve built-in tool ids); the pieces below it
 * do not, which is what keeps `src/tools/index.ts -> registry.ts` from being
 * a cycle.
 *
 * Loading is total: every failure below becomes a warning string. Startup
 * does not have a failure mode that involves a broken plugin.
 */

import { mkdir } from "node:fs/promises"

import { builtinToolIds } from "../tools/index.ts"
import type { Tool } from "../types/tool.ts"
import { ensureExtendingDoc } from "./doc.ts"
import { loadExtensions } from "./extensions.ts"
import { extensionsDir, skillsDir, themesDir } from "./paths.ts"
import {
  extensionRegistry,
  type ExtensionCommand,
} from "./registry.ts"
import { clearSkills, scanSkills, type SkillSummary } from "./skills.ts"
import { activeThemeName, DEFAULT_THEME_NAME, loadTheme, type LoadedTheme } from "./themes.ts"
import { dark, type Theme } from "../tui/theme.ts"

export interface ExtensibilityOptions {
  /**
   * The `theme` field from the loaded config. `HAXFORD_THEME` still wins over
   * it — see `activeThemeName`.
   */
  themeName?: string
}

export interface ExtensibilityState {
  /** Skill index: name + description + path. Bodies are read on demand. */
  skills: SkillSummary[]
  /** Slash commands contributed by extensions, for the TUI to merge. */
  commands: ExtensionCommand[]
  /** Tools contributed by extensions. Already merged into `allTools()`. */
  tools: Tool[]
  /** The resolved theme: a complete token map, defaults filling any gaps. */
  theme: LoadedTheme
  /** Extension files that loaded, in load order. */
  extensions: string[]
  /** Where EXTENDING.md is, and whether this call is what created it. */
  doc: { path: string; created: boolean }
  /**
   * Everything non-fatal, ready to be surfaced as notices: extensions that
   * failed to load, rejected registrations, unknown theme tokens, unreadable
   * skills.
   */
  warnings: string[]
}

/** Create the three directories, once, so the layout is discoverable. */
async function seedLayout(): Promise<void> {
  await Promise.all(
    [skillsDir(), extensionsDir(), themesDir()].map((dir) =>
      mkdir(dir, { recursive: true }).catch(() => {}),
    ),
  )
}

/**
 * The theme resolved by the most recent load/reload, kept here so a host that
 * wants to hand the token map to the TUI does not have to thread
 * `ExtensibilityState.theme` through its own plumbing. Before any load this is
 * the built-in dark theme.
 */
let resolved: LoadedTheme = {
  name: DEFAULT_THEME_NAME,
  theme: { ...dark },
  warnings: [],
}

/** The last resolved theme; defaults until `loadExtensibility` has run. */
export function resolvedTheme(): LoadedTheme {
  return resolved
}

/** The shared scan behind both load and reload. */
async function scanAll(opts: ExtensibilityOptions): Promise<ExtensibilityState> {
  const registry = extensionRegistry()
  // Dispose-first, unconditionally: whether this is a startup retry or a
  // /reload, rescanning over live registrations would double-register every
  // command and tool in the directory. Reserved names survive the clear.
  registry.clear()
  clearSkills()

  // Reserved every time: built-in tool ids are cheap to derive and a caller
  // that forgot would let an extension shadow `bash`.
  registry.reserve({ toolIds: builtinToolIds() })

  const warnings: string[] = []

  const doc = await ensureExtendingDoc()
  if (doc.error !== undefined) {
    warnings.push(`could not write ${doc.path}: ${doc.error}`)
  }
  if (doc.created) await seedLayout()

  const skills = await scanSkills()
  warnings.push(...skills.warnings)

  const extensions = await loadExtensions(registry)
  warnings.push(...extensions.errors)

  const theme = await loadTheme(activeThemeName(opts.themeName))
  warnings.push(...theme.warnings)
  resolved = { name: theme.name, theme: theme.theme, warnings: [] }

  // Registration-time rejections (bad tool shape, name collisions) land in the
  // registry rather than in the loader's result, so collect them last.
  for (const message of registry.errors()) {
    if (!warnings.includes(message)) warnings.push(message)
  }

  return {
    skills: skills.skills,
    commands: registry.commands(),
    tools: registry.tools(),
    theme,
    extensions: extensions.loaded,
    doc: { path: doc.path, created: doc.created },
    warnings,
  }
}

/**
 * Load skills, extensions and themes. Call once at startup, before the first
 * turn — the system prompt reads the skill index straight out of this module,
 * so anything loaded after the first request will not be advertised until the
 * next one.
 */
export async function loadExtensibility(
  opts: ExtensibilityOptions = {},
): Promise<ExtensibilityState> {
  return await scanAll(opts)
}

/**
 * Dispose every registered command, tool and hook, then rescan all three
 * directories. Backs `/reload`.
 *
 * Disposal happens first and unconditionally: a reload that kept the old
 * registrations alive when the new scan failed would leave the user with two
 * generations of the same command and no way to tell which ran.
 *
 * Extension *entry* files are re-evaluated; modules they import are not (Bun
 * caches by resolved path). Editing a shared helper still needs a restart.
 */
export async function reloadExtensions(
  opts: ExtensibilityOptions = {},
): Promise<ExtensibilityState> {
  // `scanAll` disposes first; the explicit clear here keeps the documented
  // guarantee local — old registrations die even if the scan changes.
  extensionRegistry().clear()
  clearSkills()
  return await scanAll(opts)
}

export { ensureExtendingDoc, EXTENDING_MD } from "./doc.ts"
export { isLoadableExtension, loadExtensions, resetExtensionGeneration } from "./extensions.ts"
export {
  extendingDocPath,
  extensionsDir,
  haxfordHome,
  skillsDir,
  themesDir,
} from "./paths.ts"
export {
  createRegistry,
  extensionCommands,
  extensionErrors,
  extensionRegistry,
  extensionTools,
  normalizeCommandName,
  RESERVED_COMMANDS,
  ToolShape,
  type CommandContext,
  type CommandHandler,
  type ExtensionCommand,
  type ExtensionModule,
  type ExtensionRegistry,
  type HaxfordExtensionAPI,
  type MessageHook,
  type StartContext,
  type StartHook,
  type ToolCallHook,
  type ToolCallInfo,
} from "./registry.ts"
export {
  clearSkills,
  findSkill,
  getSkillBody,
  listSkills,
  parseFrontmatter,
  parseFrontmatterFields,
  scanSkills,
  stripFrontmatter,
  type SkillSummary,
} from "./skills.ts"
export {
  activeThemeName,
  applyTokens,
  DEFAULT_THEME_NAME,
  listThemes,
  loadTheme,
  THEME_ENV,
  THEME_TOKENS,
  type LoadedTheme,
} from "./themes.ts"
