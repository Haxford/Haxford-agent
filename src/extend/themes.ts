/**
 * Themes: a colour-token map on disk, validated against the TUI's own token set.
 *
 * `~/.haxford/themes/<name>.json`. This module is data-only — it produces a
 * fully-populated `Theme` object and never renders anything. The token names
 * and the fallback values are imported from `src/tui/theme.ts` rather than
 * restated here, so a token renamed in the UI breaks the typecheck instead of
 * silently becoming an "unknown token" warning for every user.
 */

import { readdir } from "node:fs/promises"
import path from "node:path"

import { dark, type Theme } from "../tui/theme.ts"
import { themesDir } from "./paths.ts"

/** The built-in theme's name. Never read from disk. */
export const DEFAULT_THEME_NAME = "default"

/** Env var selecting the active theme; beats the config field. */
export const THEME_ENV = "HAXFORD_THEME"

/** Every token a theme file may set. Derived from the UI's own `Theme`. */
export const THEME_TOKENS: readonly string[] = Object.freeze(Object.keys(dark))

export interface LoadedTheme {
  /** The name that was actually resolved (`"default"` when nothing loaded). */
  name: string
  /** A complete token map: every token present, defaults filling the gaps. */
  theme: Theme
  /** Non-fatal problems: unknown tokens, bad values, a missing file. */
  warnings: string[]
}

/**
 * Which theme is active: `HAXFORD_THEME` first, then the config field, then
 * the built-in. The env var wins so a user can try a theme for one run
 * without editing config.
 */
export function activeThemeName(configured?: string): string {
  const env = process.env[THEME_ENV]?.trim()
  if (env !== undefined && env.length > 0) return env
  const fromConfig = configured?.trim()
  if (fromConfig !== undefined && fromConfig.length > 0) return fromConfig
  return DEFAULT_THEME_NAME
}

/**
 * Overlay a raw token map onto the defaults.
 *
 * Two failure modes, both non-fatal by design: a token the UI does not know
 * is reported and dropped (so a theme written for a newer haxford still
 * mostly works), and a token whose value is not a string is reported and left
 * at its default (so one typo does not blank out a colour). An *absent* token
 * is not a warning — partial themes that override only an accent are the
 * common case, not a mistake.
 */
export function applyTokens(raw: unknown): { theme: Theme; warnings: string[] } {
  const warnings: string[] = []
  const merged: Record<string, string> = {
    ...(dark as unknown as Record<string, string>),
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { theme: merged as unknown as Theme, warnings }
  }

  const known = new Set(THEME_TOKENS)
  for (const [token, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!known.has(token)) {
      warnings.push(`unknown theme token ${JSON.stringify(token)} (ignored)`)
      continue
    }
    if (typeof value !== "string") {
      warnings.push(
        `theme token ${JSON.stringify(token)} must be a string (using the default)`,
      )
      continue
    }
    // Deliberately no emptiness check: `text: ""` is the documented way to
    // say "inherit the terminal's foreground".
    merged[token] = value
  }

  return { theme: merged as unknown as Theme, warnings }
}

/**
 * Load one theme by name.
 *
 * Every failure resolves to the default theme with a warning: a broken theme
 * file must never be the reason a session will not start.
 */
export async function loadTheme(
  name: string,
  dir: string = themesDir(),
): Promise<LoadedTheme> {
  const wanted = name.trim()
  if (wanted.length === 0 || wanted === DEFAULT_THEME_NAME) {
    return { name: DEFAULT_THEME_NAME, theme: { ...dark }, warnings: [] }
  }

  // A theme name is a bare file stem: no traversal, no absolute paths.
  if (wanted.includes("/") || wanted.includes("\\") || wanted.includes("..")) {
    return {
      name: DEFAULT_THEME_NAME,
      theme: { ...dark },
      warnings: [`invalid theme name ${JSON.stringify(name)} (using the default theme)`],
    }
  }

  const file = path.join(dir, `${wanted}.json`)
  const handle = Bun.file(file)
  if (!(await handle.exists())) {
    return {
      name: DEFAULT_THEME_NAME,
      theme: { ...dark },
      warnings: [`theme ${JSON.stringify(wanted)} not found at ${file} (using the default theme)`],
    }
  }

  let raw: unknown
  try {
    raw = await handle.json()
  } catch (error) {
    return {
      name: DEFAULT_THEME_NAME,
      theme: { ...dark },
      warnings: [
        `theme ${JSON.stringify(wanted)} is not valid JSON (${
          error instanceof Error ? error.message : String(error)
        }); using the default theme`,
      ],
    }
  }

  const { theme, warnings } = applyTokens(raw)
  return {
    name: wanted,
    theme,
    warnings: warnings.map((w) => `theme ${JSON.stringify(wanted)}: ${w}`),
  }
}

/** Theme names available on disk, sorted. The built-in is not listed. */
export async function listThemes(dir: string = themesDir()): Promise<string[]> {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isFile() && e.name.endsWith(".json") && !e.name.startsWith("."))
      .map((e) => e.name.slice(0, -".json".length))
      .sort()
  } catch {
    return []
  }
}
