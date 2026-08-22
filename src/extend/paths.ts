/**
 * Where user extensibility lives on disk.
 *
 * One root — `~/.haxford` — holding three sibling directories plus the
 * self-documenting `EXTENDING.md`. Everything is resolved through functions
 * rather than module constants so `HAXFORD_HOME` can be repointed per test
 * (and by a user who keeps their dotfiles somewhere else) without the value
 * being frozen at import time.
 */

import path from "node:path"

/** Env var that repoints the whole tree. Primarily for tests and dotfile setups. */
export const HOME_ENV = "HAXFORD_HOME"

/** Root of the user's haxford data directory. */
export function haxfordHome(): string {
  const override = process.env[HOME_ENV]?.trim()
  if (override !== undefined && override.length > 0) return override
  return path.join(process.env["HOME"] ?? "~", ".haxford")
}

/** `~/.haxford/skills` — one directory per skill, each holding a SKILL.md. */
export function skillsDir(): string {
  return path.join(haxfordHome(), "skills")
}

/** `~/.haxford/extensions` — flat directory of TS/JS modules, loaded in filename order. */
export function extensionsDir(): string {
  return path.join(haxfordHome(), "extensions")
}

/** `~/.haxford/themes` — one `<name>.json` per theme. */
export function themesDir(): string {
  return path.join(haxfordHome(), "themes")
}

/** `~/.haxford/EXTENDING.md` — the API doc, written once and never overwritten. */
export function extendingDocPath(): string {
  return path.join(haxfordHome(), "EXTENDING.md")
}
