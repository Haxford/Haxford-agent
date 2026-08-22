import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import {
  blockIsMultiline,
  headingStyle,
  Markdown,
  parseBlocks,
  parseInline,
  type MdBlock,
} from "../src/tui/components/Markdown.tsx"
import { theme } from "../src/tui/theme.ts"

/**
 * The parse is two pure functions, so every construct is asserted on the data
 * rather than on a rendered frame. Frames are checked only for the things that
 * are genuinely layout: indentation, rails, spacing, and what reaches the
 * screen at all. Colour is asserted through `headingStyle`, because chalk
 * disables ANSI when stdout is not a TTY and a frame would carry none.
 */

/** Frames from ink-testing-library, minus trailing whitespace per line. */
function frameOf(el: React.ReactElement): string {
  const inst = render(el)
  const out = (inst.lastFrame() ?? "").split("\n").map((l) => l.trimEnd()).join("\n")
  inst.unmount()
  return out
}

describe("parseInline: emphasis", () => {
  test("**bold**", () => {
    expect(parseInline("**bold**")).toEqual([{ text: "bold", bold: true }])
  })

  test("__bold__ and _italic_", () => {
    expect(parseInline("__b__ and _i_")).toEqual([
      { text: "b", bold: true },
      { text: " and " },
      { text: "i", italic: true },
    ])
  })

  test("*italic*", () => {
    expect(parseInline("*italic*")).toEqual([{ text: "italic", italic: true }])
  })

  test("***bold italic*** carries both flags", () => {
    expect(parseInline("***all***")).toEqual([{ text: "all", bold: true, italic: true }])
  })

  test("~~strikethrough~~", () => {
    expect(parseInline("~~gone~~")).toEqual([{ text: "gone", strike: true }])
  })

  test("emphasis nests, accumulating flags", () => {
    expect(parseInline("**bold with *nested* inside**")).toEqual([
      { text: "bold with ", bold: true },
      { text: "nested", bold: true, italic: true },
      { text: " inside", bold: true },
    ])
  })

  test("snake_case_name is not italic", () => {
    // The `_` form requires a non-word character on both sides, or every
    // identifier in an explanation would come out italicised.
    expect(parseInline("snake_case_name")).toEqual([{ text: "snake_case_name" }])
  })

  test("arithmetic is not italic", () => {
    expect(parseInline("2 * 3 * 4")).toEqual([{ text: "2 * 3 * 4" }])
  })
})

describe("parseInline: code and links", () => {
  test("`code` becomes a code span", () => {
    expect(parseInline("a `code` b")).toEqual([
      { text: "a " },
      { text: "code", code: true },
      { text: " b" },
    ])
  })

  test("code spans are literal — emphasis inside them is not parsed", () => {
    expect(parseInline("`**not bold**`")).toEqual([{ text: "**not bold**", code: true }])
  })

  test("a link keeps its label and trails the URL dimmed", () => {
    expect(parseInline("see [docs](https://x.dev/a) now")).toEqual([
      { text: "see " },
      { text: "docs", href: "https://x.dev/a" },
      { text: " https://x.dev/a", href: "https://x.dev/a", muted: true },
      { text: " now" },
    ])
  })

  test("a bare link does not repeat itself", () => {
    // Label equals the URL, so the tail would be pure duplication.
    expect(parseInline("[https://x.dev](https://x.dev)")).toEqual([
      { text: "https://x.dev", href: "https://x.dev" },
    ])
  })
})

describe("parseInline: streaming safety", () => {
  test("an unterminated ** renders as the characters the model sent", () => {
    expect(parseInline("**bo")).toEqual([{ text: "**bo" }])
  })

  test("an unterminated backtick stays literal", () => {
    expect(parseInline("a `cod")).toEqual([{ text: "a `cod" }])
  })

  test("an unterminated link stays literal", () => {
    expect(parseInline("[docs](https://")).toEqual([{ text: "[docs](https://" }])
  })

  test("empty input yields no spans", () => {
    expect(parseInline("")).toEqual([])
  })

  test("deep nesting terminates", () => {
    // Regression: parseInline recurses, and an exec-based scan over a shared
    // /g/ regex had the inner call rewind the outer cursor — an infinite loop.
    expect(parseInline("***a `b` *c* d***")).not.toHaveLength(0)
  })
})

describe("parseBlocks: headings", () => {
  test("levels 1 through 6", () => {
    expect(parseBlocks("# One\n## Two\n#### Four")).toEqual([
      { kind: "heading", level: 1, text: "One" },
      { kind: "heading", level: 2, text: "Two" },
      { kind: "heading", level: 4, text: "Four" },
    ])
  })

  test("a # without a space is a paragraph, not a heading", () => {
    expect(parseBlocks("#nothashtag")).toEqual([{ kind: "paragraph", text: "#nothashtag" }])
  })
})

describe("parseBlocks: code fences", () => {
  test("a fenced block keeps its language and body verbatim", () => {
    expect(parseBlocks("```ts\nlet a = 1\n```")).toEqual([
      { kind: "code", lang: "ts", lines: ["let a = 1"] },
    ])
  })

  test("an unterminated fence still renders as code", () => {
    // Streaming: the closing fence has not arrived yet. Falling back to
    // paragraphs here would make the block flicker as it completes.
    expect(parseBlocks("```py\nx = 1")).toEqual([
      { kind: "code", lang: "py", lines: ["x = 1"] },
    ])
  })

  test("markdown inside a fence is not parsed", () => {
    const blocks = parseBlocks("```\n# not a heading\n- not a list\n```")
    expect(blocks).toEqual([
      { kind: "code", lang: "", lines: ["# not a heading", "- not a list"] },
    ])
  })

  test("~~~ fences work too", () => {
    expect(parseBlocks("~~~sh\nls\n~~~")).toEqual([{ kind: "code", lang: "sh", lines: ["ls"] }])
  })
})

describe("parseBlocks: lists", () => {
  test("unordered items collapse into one block with depth-ramped bullets", () => {
    expect(parseBlocks("- a\n- b\n  - c\n- d")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          { marker: "•", depth: 0, text: "a" },
          { marker: "•", depth: 0, text: "b" },
          { marker: "◦", depth: 1, text: "c" },
          { marker: "•", depth: 0, text: "d" },
        ],
      },
    ])
  })

  test("ordered items keep their own numbering", () => {
    expect(parseBlocks("1. one\n2. two")).toEqual([
      {
        kind: "list",
        ordered: true,
        items: [
          { marker: "1.", depth: 0, text: "one" },
          { marker: "2.", depth: 0, text: "two" },
        ],
      },
    ])
  })

  test("a continuation line folds into the item above it", () => {
    const blocks = parseBlocks("- first line\n  continued here\n- second")
    const list = blocks[0]
    expect(list?.kind).toBe("list")
    if (list?.kind !== "list") throw new Error("expected a list")
    expect(list.items.map((i) => i.text)).toEqual(["first line continued here", "second"])
  })
})

describe("parseBlocks: quotes, rules, paragraphs", () => {
  test("consecutive quote lines become one block", () => {
    expect(parseBlocks("> q1\n> q2")).toEqual([{ kind: "quote", lines: ["q1", "q2"] }])
  })

  test("--- is a rule, not a list", () => {
    expect(parseBlocks("---")).toEqual([{ kind: "rule" }])
  })

  test("soft-wrapped lines join into one paragraph", () => {
    // Markdown semantics, and what lets Ink re-wrap to the real terminal
    // width instead of honouring wherever the model happened to break.
    expect(parseBlocks("line one\nline two\n\nnext para")).toEqual([
      { kind: "paragraph", text: "line one line two" },
      { kind: "paragraph", text: "next para" },
    ])
  })

  test("empty input yields no blocks", () => {
    expect(parseBlocks("")).toEqual([])
    expect(parseBlocks("\n\n  \n")).toEqual([])
  })
})

describe("headingStyle: a prominence ramp, not a size ramp", () => {
  test("h1 is accent, bold and underlined", () => {
    expect(headingStyle(1)).toEqual({ color: theme.accent, underline: true, dim: false, prefix: "" })
  })

  test("h2 drops the underline", () => {
    expect(headingStyle(2)).toEqual({ color: theme.accent, underline: false, dim: false, prefix: "" })
  })

  test("h3 and deeper keep a dim # prefix, because the ramp alone runs out", () => {
    expect(headingStyle(3).prefix).toBe("###")
    expect(headingStyle(4).prefix).toBe("####")
    expect(headingStyle(4).dim).toBe(true)
  })

  test("the prefix never exceeds six hashes", () => {
    expect(headingStyle(9).prefix).toBe("######")
  })
})

describe("blockIsMultiline", () => {
  const cases: [MdBlock, boolean][] = [
    [{ kind: "code", lang: "", lines: ["a"] }, true],
    [{ kind: "quote", lines: ["a"] }, true],
    [{ kind: "list", ordered: false, items: [{ marker: "•", depth: 0, text: "a" }] }, false],
    [
      {
        kind: "list",
        ordered: false,
        items: [
          { marker: "•", depth: 0, text: "a" },
          { marker: "•", depth: 0, text: "b" },
        ],
      },
      true,
    ],
    [{ kind: "heading", level: 1, text: "x" }, false],
    [{ kind: "rule" }, false],
    [{ kind: "paragraph", text: "x" }, true],
  ]

  for (const [block, expected] of cases) {
    test(`${block.kind} -> ${expected}`, () => {
      expect(blockIsMultiline(block)).toBe(expected)
    })
  }
})

describe("Markdown rendering", () => {
  test("emphasis markers are consumed, not printed", () => {
    const frame = frameOf(React.createElement(Markdown, { text: "a **b** and *c* and `d`" }))
    expect(frame).toContain("a b and c and d")
    expect(frame).not.toContain("**")
    expect(frame).not.toContain("`")
  })

  test("a code block gets a rail and a right-aligned language tag", () => {
    const frame = frameOf(React.createElement(Markdown, { text: "```ts\nconst x = 1\n```" }))
    expect(frame).toContain("┃")
    expect(frame).toContain("const x = 1")
    // The tag sits at the far right of its own line, above the code.
    const lines = frame.split("\n")
    const tagLine = lines.findIndex((l) => l.trimEnd().endsWith("ts"))
    const codeLine = lines.findIndex((l) => l.includes("const x = 1"))
    expect(tagLine).toBeGreaterThanOrEqual(0)
    expect(tagLine).toBeLessThan(codeLine)
    // No fence markers leak through.
    expect(frame).not.toContain("```")
  })

  test("a blockquote gets a rail and no > markers", () => {
    const frame = frameOf(React.createElement(Markdown, { text: "> quoted words" }))
    expect(frame).toContain("┃")
    expect(frame).toContain("quoted words")
    expect(frame).not.toContain(">")
  })

  test("a blockquote parses its inline markup like any other prose", () => {
    // Regression: quote lines were rendered raw, so backticks and asterisks
    // showed through inside quotes but nowhere else.
    const frame = frameOf(React.createElement(Markdown, { text: "> needs `a flag` and **care**" }))
    expect(frame).toContain("needs a flag and care")
    expect(frame).not.toContain("`")
    expect(frame).not.toContain("**")
  })

  test("nested list items are indented under their parent", () => {
    const frame = frameOf(React.createElement(Markdown, { text: "- top\n  - nested" }))
    const lines = frame.split("\n")
    const top = lines.find((l) => l.includes("top")) ?? ""
    const nested = lines.find((l) => l.includes("nested")) ?? ""
    expect(top).toContain("•")
    expect(nested).toContain("◦")
    expect(nested.indexOf("◦")).toBeGreaterThan(top.indexOf("•"))
  })

  test("consecutive headings are separated so the hierarchy reads", () => {
    // Regression: both headings are single-line, so the generic spacing rule
    // packed them together and "## Two" ran straight into "### Three".
    const frame = frameOf(React.createElement(Markdown, { text: "## Two\n### Three" }))
    const lines = frame.split("\n")
    const two = lines.findIndex((l) => l.includes("Two"))
    const three = lines.findIndex((l) => l.includes("Three"))
    expect(three - two).toBe(2)
  })

  test("a single paragraph gets no leading blank line", () => {
    expect(frameOf(React.createElement(Markdown, { text: "just words" }))).toBe("just words")
  })

  test("a combined document renders every construct in order", () => {
    const doc = [
      "# Title",
      "",
      "Intro with **bold**, *italic*, `code`, and a [link](https://ex.dev).",
      "",
      "## Section",
      "",
      "- alpha",
      "- beta",
      "  - beta nested",
      "",
      "1. first",
      "2. second",
      "",
      "> a quote",
      "",
      "```ts",
      "const answer = 42",
      "```",
      "",
      "---",
      "",
      "Closing line.",
    ].join("\n")

    const frame = frameOf(React.createElement(Markdown, { text: doc }))
    for (const expected of [
      "Title",
      "Intro with bold, italic, code",
      "https://ex.dev",
      "Section",
      "• alpha",
      "• beta",
      "◦ beta nested",
      "1. first",
      "2. second",
      "a quote",
      "const answer = 42",
      "Closing line.",
    ]) {
      expect(frame).toContain(expected)
    }
    // Markers are consumed, not echoed.
    expect(frame).not.toContain("**")
    expect(frame).not.toContain("```")
    expect(frame).not.toContain("# Title")
    // Order is preserved.
    expect(frame.indexOf("Title")).toBeLessThan(frame.indexOf("Section"))
    expect(frame.indexOf("Section")).toBeLessThan(frame.indexOf("const answer = 42"))
    expect(frame.indexOf("const answer = 42")).toBeLessThan(frame.indexOf("Closing line."))
  })

  test("a half-streamed document still renders", () => {
    const frame = frameOf(
      React.createElement(Markdown, { text: "# Title\n\nSome **bo\n\n```ts\nconst x =" }),
    )
    expect(frame).toContain("Title")
    expect(frame).toContain("**bo")
    expect(frame).toContain("const x =")
  })
})
