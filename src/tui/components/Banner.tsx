import { Box, Text } from "ink"
import React from "react"

import { formatCtx } from "../format.ts"
import { theme } from "../theme.ts"

/**
 * The session header: one bordered box, printed once at session start and
 * never touched again.
 *
 * It is the only box in the UI. That exclusivity is what makes it work — a
 * border reads as "this is a distinct thing" exactly once per screen, and the
 * moment a second one appears both stop meaning anything and the TUI starts
 * reading as a form. Everything else groups with rails and rules.
 *
 * Contents are the four facts you want at a glance when a session opens and
 * never again: what this is, who you are, what model is answering and how much
 * room it has, and where you are. No key hints — the footer points at /help,
 * which is where the full reference lives.
 */

/** The package version, shown in the header. Kept in step with package.json. */
export const VERSION = "0.1.0"

/** Content rows inside the border: title, greeting, blank, model, cwd. */
export const BANNER_CONTENT_LINES = 5

/**
 * Total rows the banner occupies: content, one blank row of inner padding
 * above and below, and the two border edges. Bottom-pinning subtracts this,
 * so it has to match what renders.
 */
export const BANNER_HEIGHT = BANNER_CONTENT_LINES + 2 + 2

/**
 * The name to greet.
 *
 * `USER` and `LOGNAME` are what a shell exports; `whoami` reads the same
 * thing. When none of it resolves — a bare container, a stripped env — the
 * greeting still has to read as a sentence, so it falls back to "there"
 * rather than printing an empty name or dropping the line.
 */
export function greetingName(
  env: Record<string, string | undefined> = process.env,
): string {
  const name = env["USER"] ?? env["LOGNAME"] ?? env["USERNAME"]
  const trimmed = name?.trim() ?? ""
  return trimmed.length > 0 ? trimmed : "there"
}

/** Replace a leading home directory with `~`, so the cwd line stays readable. */
export function tildeCwd(
  cwd: string,
  home: string | undefined = process.env["HOME"],
): string {
  if (home === undefined || home.length === 0) return cwd
  if (cwd === home) return "~"
  const prefix = home.endsWith("/") ? home : `${home}/`
  return cwd.startsWith(prefix) ? `~/${cwd.slice(prefix.length)}` : cwd
}

export interface BannerProps {
  model: string
  cwd: string
  /** Context window for the active model; the "· Nk ctx" suffix is skipped when absent. */
  contextLimit?: number
  /** Injectable environment, for deterministic tests. */
  env?: Record<string, string | undefined>
}

/** Render the session header box. */
export function Banner({ model, cwd, contextLimit, env }: BannerProps): React.ReactElement {
  const ctx = contextLimit !== undefined && contextLimit > 0 ? formatCtx(contextLimit) : undefined
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.dim}
      borderDimColor
      paddingX={2}
      paddingY={1}
    >
      <Text>
        <Text bold color={theme.accent}>haxford</Text>
        <Text dimColor>{" v"}{VERSION}</Text>
      </Text>
      <Text>{"Welcome back, "}{greetingName(env)}</Text>
      <Text>{" "}</Text>
      <Text>
        <Text color={theme.model}>{model}</Text>
        {ctx !== undefined ? <Text dimColor>{" · "}{ctx}{" ctx"}</Text> : null}
      </Text>
      <Text dimColor wrap="truncate-middle">{tildeCwd(cwd)}</Text>
    </Box>
  )
}

/** A short, basename-only cwd for the status bar / banner hint. */
export function shortCwd(cwd: string): string {
  // Tolerate trailing slashes and empty input.
  const clean = cwd.replace(/\/+$/, "")
  if (clean.length === 0) return "/"
  const slash = clean.lastIndexOf("/")
  return slash === -1 ? clean : clean.slice(slash + 1)
}
