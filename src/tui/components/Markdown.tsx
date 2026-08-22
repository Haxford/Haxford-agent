import { Box, Text } from "ink"
import React from "react"

import { separatorBefore } from "../layout.ts"
import { railProps, theme } from "../theme.ts"

/**
 * A small markdown renderer for assistant prose.
 *
 * Deliberately hand-rolled rather than pulling in `marked` (which is what pi
 * uses): the subset an agent actually emits is narrow, a parser for it is
 * ~200 lines, and AGENTS.md rule 2 makes a new runtime dependency something
 * to justify rather than assume. The parse is split into two pure functions —
 * `parseBlocks` and `parseInline` — so every construct is unit-testable
 * without rendering anything.
 *
 * Two properties matter more than completeness:
 *
 *  - **Streaming-safe.** Assistant text arrives a token at a time, so every
 *    construct must render sensibly while still half-written. An unterminated
 *    fence renders as a code block, an unmatched `**` renders as literal text.
 *    Nothing throws, nothing disappears and reappears.
 *  - **Palette-safe.** Colour comes only from `theme`, whose whole contract is
 *    named 16-colour ANSI so the terminal's own scheme wins. No truecolor, and
 *    no hardcoded backgrounds — see the note on inline code below.
 */

/* -------------------------------------------------------------------------- */
/* Inline                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A run of text carrying its accumulated emphasis.
 *
 * Styles are flags rather than span kinds so nesting composes for free:
 * `**bold with *italic* inside**` is two spans, the inner one carrying both
 * flags. A kind-per-construct union would have needed a tree instead.
 */
export interface MdSpan {
  text: string
  bold?: boolean
  italic?: boolean
  code?: boolean
  strike?: boolean
  /** Set on link text and on the trailing URL span. */
  href?: string
  /** Rendered dim: the URL tail appended after a link's label. */
  muted?: boolean
}

/** Everything on an MdSpan except its text — the inherited style context. */
export type MdStyle = Omit<MdSpan, "text">

/**
 * One alternation covering every inline construct, tried left to right.
 *
 * Order is the precedence: code first (its content is literal, so a backtick
 * span must win over any emphasis inside it), then the three-marker form
 * before the two-marker form before the one-marker form, or `***x***` would
 * parse as `**` followed by a stray `*`.
 *
 * The emphasis bodies are anchored on non-whitespace at both ends, which is
 * what stops `2 * 3 * 4` from becoming italic. The `_` forms additionally
 * require a non-word character on each side so `snake_case_name` survives.
 *
 * Matched via `matchAll`, never `exec`. `parseInline` recurses into every
 * construct's body, and `exec` on a shared /g/ regex carries `lastIndex` on
 * the regex object itself — an inner call would rewind the outer loop's
 * cursor and the scan would never terminate. `matchAll` clones the regex per
 * call, so each recursion level gets its own cursor.
 */
const INLINE = new RegExp(
  [
    /(`+)([\s\S]+?)\1(?!`)/, //                       1 ticks, 2 code
    /\*\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*\*/, //       3 bold+italic
    /\*\*([^\s](?:[\s\S]*?[^\s])?)\*\*/, //           4 bold
    /__([^\s](?:[\s\S]*?[^\s])?)__/, //               5 bold
    /~~([^\s](?:[\s\S]*?[^\s])?)~~/, //               6 strikethrough
    /\[([^\]]*)\]\(([^)\s]+)\)/, //                   7 link text, 8 href
    /(?<![*\w])\*([^\s*](?:[^*]*?[^\s*])?)\*(?!\*)/, // 9 italic
    /(?<![\w_])_([^\s_](?:[^_]*?[^\s_])?)_(?![\w_])/, // 10 italic
  ]
    .map((r) => r.source)
    .join("|"),
  "g",
)

/** Merge an inherited style with the one a construct adds. */
function withStyle(base: MdStyle, add: MdStyle): MdStyle {
  return { ...base, ...add }
}

/**
 * Split one line of markdown into styled spans.
 *
 * Recurses into every construct's body so emphasis nests, except code spans,
 * whose content is literal by definition. Anything that does not match falls
 * through as plain text, which is what makes a half-streamed `**bo` render as
 * the characters the model actually sent.
 */
export function parseInline(text: string, inherit: MdStyle = {}): MdSpan[] {
  if (text.length === 0) return []
  const spans: MdSpan[] = []
  const push = (t: string, style: MdStyle): void => {
    if (t.length > 0) spans.push({ text: t, ...style })
  }

  let cursor = 0
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0
    push(text.slice(cursor, at), inherit)
    cursor = at + match[0].length

    const code = match[2]
    const boldItalic = match[3]
    const boldStar = match[4]
    const boldUnderscore = match[5]
    const strike = match[6]
    const linkText = match[7]
    const href = match[8]
    const italicStar = match[9]
    const italicUnderscore = match[10]

    if (code !== undefined) {
      // Literal: no recursion, and the surrounding emphasis still applies.
      push(code, withStyle(inherit, { code: true }))
    } else if (boldItalic !== undefined) {
      spans.push(...parseInline(boldItalic, withStyle(inherit, { bold: true, italic: true })))
    } else if (boldStar !== undefined) {
      spans.push(...parseInline(boldStar, withStyle(inherit, { bold: true })))
    } else if (boldUnderscore !== undefined) {
      spans.push(...parseInline(boldUnderscore, withStyle(inherit, { bold: true })))
    } else if (strike !== undefined) {
      spans.push(...parseInline(strike, withStyle(inherit, { strike: true })))
    } else if (linkText !== undefined && href !== undefined) {
      const label = linkText.length > 0 ? linkText : href
      spans.push(...parseInline(label, withStyle(inherit, { href })))
      // The URL is the part a terminal user actually needs — it is what they
      // copy or click. A label alone silently discards it, so it trails the
      // link dimmed, and only when it says something the label does not.
      if (label !== href) push(` ${href}`, withStyle(inherit, { href, muted: true }))
    } else if (italicStar !== undefined) {
      spans.push(...parseInline(italicStar, withStyle(inherit, { italic: true })))
    } else if (italicUnderscore !== undefined) {
      spans.push(...parseInline(italicUnderscore, withStyle(inherit, { italic: true })))
    }
  }
  push(text.slice(cursor), inherit)
  return spans
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

/** One entry in a list block, carrying its own nesting depth. */
export interface MdListItem {
  /** Rendered marker: a bullet glyph, or "3." for an ordered item. */
  marker: string
  /** Nesting level, 0 for a top-level item. */
  depth: number
  /** Item text, with any continuation lines already folded in. */
  text: string
}

export type MdBlock =
  | { kind: "heading"; level: number; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "code"; lang: string; lines: string[] }
  | { kind: "list"; ordered: boolean; items: MdListItem[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "rule" }

const FENCE = /^(\s*)(`{3,}|~{3,})\s*(\S*)\s*$/
const HEADING = /^(#{1,6})\s+(.*)$/
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/
const QUOTE = /^\s*>\s?(.*)$/
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const BLANK = /^\s*$/

/** Bullet glyphs by depth; the ramp makes nesting legible without indentation alone. */
const BULLETS = ["•", "◦", "▪"] as const

/** Two spaces of source indent per nesting level, capped so runaway indent stays sane. */
function depthOf(indent: string): number {
  return Math.min(Math.floor(indent.replace(/\t/g, "  ").length / 2), 4)
}

/**
 * Parse markdown into a flat list of blocks.
 *
 * Consecutive list items collapse into one `list` block so items pack tightly
 * and only the list as a whole gets air around it. Consecutive paragraph lines
 * join with a space, which is what markdown means by a soft break — and what
 * lets Ink wrap the paragraph to the real terminal width instead of honouring
 * whatever width the model happened to wrap at.
 */
export function parseBlocks(text: string): MdBlock[] {
  const lines = text.split("\n")
  const blocks: MdBlock[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i] ?? ""

    // Fenced code. An unterminated fence runs to the end of the input rather
    // than falling back to paragraphs, so a streaming block does not flicker
    // between two renderings as its closing fence arrives.
    const fence = FENCE.exec(line)
    if (fence !== null) {
      const marker = fence[2] ?? "```"
      const lang = fence[3] ?? ""
      const body: string[] = []
      i++
      while (i < lines.length) {
        const cur = lines[i] ?? ""
        const close = FENCE.exec(cur)
        if (close !== null && (close[2] ?? "").startsWith(marker[0] ?? "`") && (close[3] ?? "") === "") break
        body.push(cur)
        i++
      }
      if (i < lines.length) i++ // consume the closing fence
      blocks.push({ kind: "code", lang, lines: body })
      continue
    }

    if (BLANK.test(line)) {
      i++
      continue
    }

    // Checked before lists: "---" is a rule, while a list marker needs "- ".
    if (RULE.test(line)) {
      blocks.push({ kind: "rule" })
      i++
      continue
    }

    const heading = HEADING.exec(line)
    if (heading !== null) {
      blocks.push({ kind: "heading", level: (heading[1] ?? "#").length, text: heading[2] ?? "" })
      i++
      continue
    }

    const quote = QUOTE.exec(line)
    if (quote !== null) {
      const body: string[] = []
      while (i < lines.length) {
        const m = QUOTE.exec(lines[i] ?? "")
        if (m === null) break
        body.push(m[1] ?? "")
        i++
      }
      blocks.push({ kind: "quote", lines: body })
      continue
    }

    const item = LIST_ITEM.exec(line)
    if (item !== null) {
      const items: MdListItem[] = []
      let ordered = /\d/.test(item[2] ?? "")
      while (i < lines.length) {
        const m = LIST_ITEM.exec(lines[i] ?? "")
        if (m === null) break
        const indent = m[1] ?? ""
        const raw = m[2] ?? "-"
        const depth = depthOf(indent)
        const isOrdered = /\d/.test(raw)
        if (items.length === 0) ordered = isOrdered
        items.push({
          marker: isOrdered ? raw : (BULLETS[Math.min(depth, BULLETS.length - 1)] ?? "•"),
          depth,
          text: m[3] ?? "",
        })
        i++
        // Continuation: a more-indented, non-blank line that is not itself a
        // new item belongs to the item above it.
        while (i < lines.length) {
          const cont = lines[i] ?? ""
          if (BLANK.test(cont) || LIST_ITEM.test(cont) || FENCE.test(cont)) break
          if (!/^\s{2,}/.test(cont)) break
          const last = items[items.length - 1]
          if (last !== undefined) last.text = `${last.text} ${cont.trim()}`
          i++
        }
      }
      blocks.push({ kind: "list", ordered, items })
      continue
    }

    // Paragraph: fold consecutive plain lines into one wrappable run.
    const para: string[] = []
    while (i < lines.length) {
      const cur = lines[i] ?? ""
      if (
        BLANK.test(cur) ||
        FENCE.test(cur) ||
        HEADING.test(cur) ||
        RULE.test(cur) ||
        QUOTE.test(cur) ||
        LIST_ITEM.test(cur)
      ) {
        break
      }
      para.push(cur.trim())
      i++
    }
    blocks.push({ kind: "paragraph", text: para.join(" ") })
  }

  return blocks
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Colour and weight for a heading level.
 *
 * A terminal cannot vary type size, so "sized by level" becomes a monotone
 * ramp of prominence: accent + underline, accent, plain bold, dim bold. Levels
 * 3 and deeper keep their `#` prefix (dim) because past level 2 the ramp alone
 * no longer separates a heading from bold body text.
 */
export function headingStyle(level: number): {
  color?: string
  underline: boolean
  dim: boolean
  prefix: string
} {
  if (level <= 1) return { color: theme.accent, underline: true, dim: false, prefix: "" }
  if (level === 2) return { color: theme.accent, underline: false, dim: false, prefix: "" }
  if (level === 3) return { underline: false, dim: false, prefix: "###" }
  return { underline: false, dim: true, prefix: "#".repeat(Math.min(level, 6)) }
}

/** Render one line's spans as styled Ink text. */
export function Inline({ spans }: { spans: MdSpan[] }): React.ReactElement {
  return (
    <Text>
      {spans.map((s, i) => (
        <Text
          key={i}
          bold={s.bold === true}
          italic={s.italic === true}
          strikethrough={s.strike === true}
          underline={s.href !== undefined && s.muted !== true}
          dimColor={s.muted === true}
          // Inline code is coloured rather than back-lit. A background would
          // have to name a literal ANSI colour, and every "safe" choice
          // ("black", "white") is wrong on half the terminals out there —
          // exactly the trap theme.ts exists to avoid. Accent-on-default reads
          // as a chip and inherits whatever scheme the user already picked.
          color={s.code === true ? theme.codeSpan : s.href !== undefined ? theme.accent : undefined}
        >
          {s.text}
        </Text>
      ))}
    </Text>
  )
}

/** A fenced code block: dim rail, indented body, language tag right-aligned. */
function CodeBlock({ lang, lines }: { lang: string; lines: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column" {...railProps()} paddingLeft={1}>
      {lang.length > 0 ? (
        <Box>
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor>{lang}</Text>
          </Box>
        </Box>
      ) : null}
      {lines.map((line, i) => (
        <Text key={i} dimColor wrap="truncate-end">
          {line.length === 0 ? " " : line}
        </Text>
      ))}
    </Box>
  )
}

/** A list, indented by depth with the marker in its own cell so text aligns. */
function ListBlock({ items }: { items: MdListItem[] }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {items.map((item, i) => (
        <Box key={i} paddingLeft={item.depth * 2}>
          <Box flexShrink={0} marginRight={1}>
            <Text dimColor>{item.marker}</Text>
          </Box>
          {/*
            The text lives in its own flex child, so Ink wraps continuation
            lines inside that child's width — i.e. aligned under the first
            character of the item, never back under the marker.
          */}
          <Box flexGrow={1}>
            <Text wrap="wrap">
              <Inline spans={parseInline(item.text)} />
            </Text>
          </Box>
        </Box>
      ))}
    </Box>
  )
}

/** A blockquote: dim rail, dim italic body. */
function QuoteBlock({ lines }: { lines: string[] }): React.ReactElement {
  return (
    <Box flexDirection="column" {...railProps()} paddingLeft={1}>
      {lines.map((line, i) => (
        <Text key={i} italic dimColor wrap="wrap">
          {/* Quotes carry prose, so their inline markup is parsed like any
              other prose. Only fenced code is literal. */}
          {line.length === 0 ? " " : <Inline spans={parseInline(line)} />}
        </Text>
      ))}
    </Box>
  )
}

/** Does this block occupy more than one rendered line? Feeds the spacing rule. */
export function blockIsMultiline(block: MdBlock): boolean {
  switch (block.kind) {
    case "code":
      return true
    case "quote":
      return true
    case "list":
      return block.items.length > 1
    case "heading":
      return false
    case "rule":
      return false
    case "paragraph":
      return block.text.length > 0
  }
}

function BlockView({ block }: { block: MdBlock }): React.ReactElement {
  switch (block.kind) {
    case "heading": {
      const s = headingStyle(block.level)
      return (
        <Box>
          {s.prefix.length > 0 ? (
            <Box marginRight={1}>
              <Text dimColor>{s.prefix}</Text>
            </Box>
          ) : null}
          <Text bold underline={s.underline} dimColor={s.dim} color={s.color} wrap="wrap">
            <Inline spans={parseInline(block.text, { bold: true })} />
          </Text>
        </Box>
      )
    }
    case "paragraph":
      return (
        <Text wrap="wrap">
          <Inline spans={parseInline(block.text)} />
        </Text>
      )
    case "code":
      return <CodeBlock lang={block.lang} lines={block.lines} />
    case "list":
      return <ListBlock items={block.items} />
    case "quote":
      return <QuoteBlock lines={block.lines} />
    case "rule":
      return <Text dimColor>{"─".repeat(24)}</Text>
  }
}

export interface MarkdownProps {
  text: string
}

/**
 * Render assistant prose as markdown.
 *
 * Block spacing reuses `separatorBefore`, the same rule the transcript applies
 * between tool calls: neighbours that both fit on one line pack together,
 * anything with a body gets air. One law, applied at both scales.
 */
export function Markdown({ text }: MarkdownProps): React.ReactElement {
  const blocks = parseBlocks(text)
  let prevMultiline: boolean | undefined
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) => {
        const multiline = blockIsMultiline(block)
        // A heading or a rule is a section break by definition, so it takes a
        // blank line above regardless of how tall its neighbours are —
        // otherwise consecutive headings ("## Two" then "### Three") collide
        // and stop reading as a hierarchy. Everything else follows the
        // transcript's own spacing law.
        const forced = i > 0 && (block.kind === "heading" || block.kind === "rule")
        const marginTop = forced ? 1 : separatorBefore(prevMultiline, multiline)
        // Downstream blocks must see a heading as something that wants air
        // after it too, not just before.
        prevMultiline = multiline || block.kind === "heading" || block.kind === "rule"
        return (
          <Box key={i} flexDirection="column" marginTop={marginTop}>
            <BlockView block={block} />
          </Box>
        )
      })}
    </Box>
  )
}
