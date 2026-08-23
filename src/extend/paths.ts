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

/** Env var that repoints the cross-harness Agent Skills root. Primarily tests. */
export const AGENT_SKILLS_ENV = "AGENT_SKILLS_HOME"

/**
 * The cross-harness Agent Skills directory — `~/.agents/skills`.
 *
 * The de-facto standard location several agent harnesses already read, so a
 * skill written once is visible to haxford alongside whichever tool taught
 * it. Secondary to `~/.haxford/skills`: same-name skills there win.
 */
export function agentSkillsDir(): string {
  const override = process.env[AGENT_SKILLS_ENV]?.trim()
  if (override !== undefined && override.length > 0) return override
  return path.join(process.env["HOME"] ?? "~", ".agents", "skills")
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

/** `~/.haxford/EXTENDING.md` — the self-documenting extension guide. */
export function extendingDocPath(): string {
  return path.join(haxfordHome(), "EXTENDING.md")
}

/**
 * `~/.haxford/init.md` — global context loaded at the start of every
 * session, in every project. The user's standing instructions to the agent:
 * conventions, tone, recurring tasks. Loaded before any project-level file
 * so the prefix stays stable across directories (prompt-cache friendly).
 */
export function initContextPath(): string {
  return path.join(haxfordHome(), "init.md")
}
