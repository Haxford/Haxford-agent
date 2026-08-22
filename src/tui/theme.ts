/**
 * The single source of truth for TUI colour.
 *
 * Every value is one of Ink's *named* ANSI colours, which map to the terminal's
 * own 16-colour palette (SGR 30-37 / 90-97). That is deliberate: haxford
 * borrows whatever palette the user already configured instead of asserting a
 * hardcoded one, so it looks correct in any terminal — light, dark, or a
 * custom scheme — without shipping a colour scheme of its own.
 *
 * Role assignment (see the redesign spec):
 *   - `accent` (cyan)   interactive affordances, selection, focus
 *   - `success` (green) completion, the user's own words
 *   - `warning` (yellow) permission prompts, attention
 *   - `error` (red)     failures
 *   - `muted` (gray) + `dimColor` everything structural
 *   - magenta is RESERVED for plan mode and appears nowhere else
 *
 * `""` means "the terminal's default foreground" — Ink treats an empty colour
 * as absent, so plain body text inherits the terminal rather than being forced
 * to white (which is wrong on light backgrounds).
 */

/** A permission mode. Duplicated as a local alias so theme.ts stays dependency-free. */
export type ThemeMode = "build" | "auto" | "plan"

export interface Theme {
  /** Primary interactive colour: selection, focus, active affordances. */
  accent: string
  /** Body text. Empty string = inherit the terminal's default foreground. */
  text: string
  /** Secondary text: metadata, hints, descriptions. */
  muted: string
  /** Tertiary text. Pair with `dimColor` for the faintest tier. */
  dim: string
  /** Success / completion. */
  success: string
  /** Attention: permission prompts, non-fatal end reasons. */
  warning: string
  /** Failure. */
  error: string
  /** Informational, and the plan-mode accent. The only place magenta lives. */
  info: string

  /** Left-rail colour for grouped blocks. Deliberately near-invisible: the
   *  rail groups, it does not announce. Always paired with `borderDimColor`. */
  rail: string
  /** Left-rail colour when the block is active/attention-worthy. */
  railAccent: string

  /** Full-row selection background. */
  selectedBg: string
  /** Foreground on `selectedBg`. */
  selectedFg: string
  /** Popup / panel background. */
  panelBg: string

  /** Diff added / removed / context lines. */
  diffAdd: string
  diffDel: string
  diffCtx: string

  /** The user's own words. */
  user: string
  /** Tool icon glyph when the call is healthy. */
  toolIcon: string
}

/**
 * The default 16-colour ANSI theme.
 *
 * Named colours only — no hex, no 256-index — so the terminal's palette wins.
 */
export const dark: Theme = {
  accent: "cyan",
  text: "",
  muted: "gray",
  dim: "gray",
  success: "green",
  warning: "yellow",
  error: "red",
  info: "magenta",

  rail: "gray",
  railAccent: "cyan",

  selectedBg: "cyan",
  selectedFg: "black",
  panelBg: "black",

  diffAdd: "green",
  diffDel: "red",
  diffCtx: "gray",

  user: "green",
  toolIcon: "cyan",
}

/** The active theme. A loader may swap this in a later round. */
export const theme: Theme = dark

/**
 * Accent colour for a permission mode. This drives the composer's left rail,
 * which is the primary mode indicator — the status bar only echoes it.
 *
 * `plan` is the sole consumer of magenta in the whole UI.
 */
export function modeColor(mode: ThemeMode, t: Theme = theme): string {
  switch (mode) {
    case "build":
      return t.accent
    case "auto":
      return t.success
    case "plan":
      return t.info
  }
}

/**
 * A left-rail border: one vertical line at the start of a block, no corners,
 * no top/bottom/right edge. This is the *only* grouping device in the UI —
 * it replaces the rounded boxes that made the TUI read as a form.
 *
 * `cli-boxes`'s `bold` style supplies `┃` for the vertical. Corner glyphs are
 * blanked explicitly rather than relying on Ink to omit them when the adjacent
 * edges are disabled.
 */
export const RAIL = {
  topLeft: " ",
  top: " ",
  topRight: " ",
  left: "┃",
  right: " ",
  bottomLeft: " ",
  bottom: " ",
  bottomRight: " ",
} as const

/**
 * Props spreading a left-rail border onto an Ink `<Box>`.
 *
 * @param color  rail colour; defaults to the near-invisible structural rail
 * @param dim    whether to additionally dim the rail (default true)
 */
export function railProps(
  color: string = theme.rail,
  dim = true,
): {
  borderStyle: typeof RAIL
  borderTop: false
  borderRight: false
  borderBottom: false
  borderColor: string
  borderDimColor: boolean
} {
  return {
    borderStyle: RAIL,
    borderTop: false,
    borderRight: false,
    borderBottom: false,
    borderColor: color,
    borderDimColor: dim,
  }
}
