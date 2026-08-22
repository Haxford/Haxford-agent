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


/**
 * Rows the breadcrumb costs: its own line, plus the single blank row that
 * separates the whole chrome stack from the transcript above it.
 *
 * The separator is counted here rather than left implicit because it is
 * unconditional — one margin for the group, not one per member — and the pin
 * math is only correct if every row it does not draw is a row it subtracts.
 */
export const BREADCRUMB_LINES = 2

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

/** The pieces of the frame that compete for vertical space. */
export interface PinInput {
  /** Terminal height in rows. */
  height: number
  /** Rows the banner occupies (it is printed once, into scrollback). */
  banner: number
  /** Rows the breadcrumb occupies. */
  breadcrumb: number
  /** Rows the input occupies, rules included. */
  input: number
  /** Rows the footer occupies. */
  footer: number
  /** Rows the transcript occupies so far. */
  transcript: number
}

/**
 * Blank lines to insert above the live region so the input and footer sit on
 * the terminal's last rows.
 *
 * A terminal puts new output wherever the cursor is, so a session that has
 * only just started draws its composer a third of the way down the screen and
 * leaves two thirds of dead space below it. Padding closes that gap at the
 * top instead, which is where empty space is unremarkable.
 *
 * The result decays to zero on its own: every line the transcript gains is a
 * line of padding it takes, and once the content fills the viewport the
 * terminal's own scrolling does the pinning for free. Clamped at zero, so an
 * overflowing frame simply stops padding rather than going negative.
 */
export function bottomPadding(p: PinInput): number {
  const used = p.banner + p.breadcrumb + p.input + p.footer + p.transcript
  const free = p.height - used
  return free > 0 ? free : 0
}
