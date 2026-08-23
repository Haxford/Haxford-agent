import type { Message } from "../types/message.ts"

/**
 * Shared vertical-rhythm rules for the transcript.
 *
 * Extracted from Transcript.tsx so Markdown.tsx and Diff.tsx can obey the same
 * spacing law without importing the component that renders them (which would
 * be a cycle). Transcript.tsx re-exports these, so existing importers are
 * unaffected.
 */

/**
 * Blank lines to insert before an item, given whether it and its predecessor
 * are multi-line.
 *
 * opencode's rule, and the single biggest source of visual rhythm: a run of
 * one-line tool calls packs into a tight scannable stack, while anything with
 * a body gets air around it. A uniform `gap={1}` spaces everything equally,
 * which is the same as spacing nothing — that flatness is what read as
 * "minimal and plain".
 */
export function separatorBefore(
  prevMultiline: boolean | undefined,
  curMultiline: boolean,
): 0 | 1 {
  if (prevMultiline === undefined) return 0
  return prevMultiline || curMultiline ? 1 : 0
}


/** Rows the footer occupies. One line, always — that is the whole point of it. */
export const FOOTER_LINES = 1

/** Rows the input's two rules occupy (one above, one below). */
export const INPUT_RULE_LINES = 2

/**
 * Lines a string occupies once soft-wrapped to `width`.
 *
 * Rounds up per source line and never returns less than one, because the
 * consumer is bottom-pinning: undercounting pushes the composer off the
 * bottom of the screen, overcounting only gives back a blank line early.
 */
export function wrappedLines(text: string, width: number): number {
  if (width <= 0) return Math.max(1, text.split("\n").length)
  let total = 0
  for (const line of text.split("\n")) {
    total += Math.max(1, Math.ceil([...line].length / width))
  }
  return Math.max(1, total)
}

/**
 * Rendered height of the composer: its two rules plus however many lines the
 * current value wraps to.
 *
 * @inkjs/ui renders its value in a plain `<Text>`, so Ink soft-wraps it and
 * the region grows on its own. This just predicts what it will do, so the
 * padding above stays correct while the user types past the first line.
 */
export function composerHeight(value: string, width: number): number {
  // The glyph and its trailing space are not available to the text.
  return INPUT_RULE_LINES + wrappedLines(value, Math.max(1, width - 2))
}

/** Rows a single message occupies, generously rounded up. */
export function estimateMessageLines(message: Message, width: number): number {
  let lines = 0
  for (const part of message.parts) {
    if (part.type === "text" || part.type === "reasoning") {
      lines += wrappedLines(part.text, width)
    } else if (part.type === "image") {
      lines += 1
    } else {
      // Summary row, plus whatever preview the transcript decided to show.
      const output =
        part.state.status === "completed" ? part.state.output
        : part.state.status === "error" ? part.state.error
        : ""
      lines += 1 + Math.min(4, output.length === 0 ? 0 : wrappedLines(output, width))
    }
  }
  if (message.error !== undefined) lines += 2
  // Every message carries a separator above it in the transcript's rhythm.
  return lines + 1
}

/** Rows a whole transcript occupies, generously rounded up. */
export function estimateTranscriptLines(messages: Message[], width: number): number {
  let total = 0
  for (const m of messages) total += estimateMessageLines(m, width)
  return total
}

/** Most queued prompts shown as their own stacked line before a count hint takes over. */
export const MAX_QUEUE_LINES_SHOWN = 3

/**
 * Rows the queued-prompts display occupies above the composer: up to
 * `MAX_QUEUE_LINES_SHOWN` one-liners, plus one more line for the "+N more"
 * count hint once the queue is deeper than that. Zero when nothing is queued.
 */
export function queueDisplayLines(queueLength: number): number {
  if (queueLength <= 0) return 0
  return Math.min(queueLength, MAX_QUEUE_LINES_SHOWN) + (queueLength > MAX_QUEUE_LINES_SHOWN ? 1 : 0)
}

/** The pieces of the frame that compete for vertical space. */
export interface PinInput {
  /** Terminal height in rows. */
  height: number
  /** Rows the header occupies (it is printed once, into scrollback). */
  banner: number
  /** Rows the input occupies, rules included. */
  input: number
  /** Rows the footer occupies. */
  footer: number
  /** Rows the transcript occupies so far. */
  transcript: number
}

/**
 * The most blank filler rows the frame will draw above the live region,
 * counting EVERY blank row between the header and the composer's rule — the
 * dynamic padding box below plus the chrome stack's own fixed lead-in gap
 * (`CHROME_GAP_LINES`), not just the padding box in isolation.
 *
 * Bottom-pinning used to spend every free row pushing the composer onto the
 * terminal's last rows, which on a fresh session meant a screenful of dead
 * space between the header and the first line of chrome — measured at eight
 * blank lines on a stock terminal. The pin is capped now: a couple of filler
 * rows keeps the first paint tight, and content grows downward from there.
 * pi's own start screen does the same, and it is why small ptys (10-20 rows)
 * still show input + footer on the first frame instead of a wall of nothing.
 */
export const MAX_FILLER_LINES = 2

/**
 * The composer chrome's own leading margin (the `marginTop` on the box
 * holding the hint/queue/Composer/StatusBar group), present whenever no
 * overlay is stealing that job — see app.tsx. It is a real, always-drawn
 * blank row, so `bottomPadding` below reserves room for it out of the same
 * `MAX_FILLER_LINES` budget instead of letting it stack on top unaccounted
 * for, which is what silently turned a "≤2 blank rows" budget into 3.
 */
export const CHROME_GAP_LINES = 1

/**
 * Blank lines to insert in the dynamic padding box above the live region, so
 * that box plus the chrome stack's fixed `CHROME_GAP_LINES` together never
 * exceed `MAX_FILLER_LINES`.
 *
 * The result decays to zero on its own: every line the transcript gains is a
 * line of padding it takes, and once the content fills the viewport the
 * terminal's own scrolling takes over. Clamped at both ends — zero when the
 * frame overflows (never negative), `MAX_FILLER_LINES - CHROME_GAP_LINES`
 * however tall the terminal is.
 */
export function bottomPadding(p: PinInput): number {
  const used = p.banner + p.input + p.footer + p.transcript + CHROME_GAP_LINES
  const free = p.height - used
  if (free <= 0) return 0
  return Math.min(free, MAX_FILLER_LINES - CHROME_GAP_LINES)
}
