import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import {
  COLLAPSED_DIFF_LINES,
  DiffView,
  diffLineStyle,
  isDiffLike,
  MAX_DIFF_LINES,
  parseDiff,
  stripDiffMeta,
  truncateDiff,
} from "../src/tui/components/Diff.tsx"
import { theme } from "../src/tui/theme.ts"

/** A realistic two-hunk `git diff`, headers and all. */
const GIT_DIFF = `diff --git a/src/tui/app.tsx b/src/tui/app.tsx
index 1234567..89abcde 100644
--- a/src/tui/app.tsx
+++ b/src/tui/app.tsx
@@ -12,7 +12,9 @@ import { theme } from "./theme.ts"
 const a = 1
-const b = 2
+const b = 3
+const c = 4
 const d = 5
@@ -40,3 +42,3 @@ export function App() {
-  return null
+  return <Box />
 }`

/** A bare hunk body, the shape `diff -u` output gets pasted in as. */
const BARE_HUNK = `@@ -1,4 +1,4 @@
 unchanged
-old line
+new line
 tail`

function frameOf(el: React.ReactElement): string {
  const inst = render(el)
  const out = (inst.lastFrame() ?? "").split("\n").map((l) => l.trimEnd()).join("\n")
  inst.unmount()
  return out
}

describe("isDiffLike: what counts as a diff", () => {
  test("a full git diff", () => {
    expect(isDiffLike(GIT_DIFF)).toBe(true)
  })

  test("a bare hunk with a header", () => {
    expect(isDiffLike(BARE_HUNK)).toBe(true)
  })

  test("a headerless block of dense +/- lines", () => {
    expect(isDiffLike("-alpha\n-beta\n+gamma\n+delta")).toBe(true)
  })

  test("--- / +++ headers alone are enough", () => {
    expect(isDiffLike("--- a/x.ts\n+++ b/x.ts\n context only")).toBe(true)
  })
})

describe("isDiffLike: what must NOT count as a diff", () => {
  test("ordinary prose", () => {
    expect(isDiffLike("Wrote 12 lines to src/tui/app.tsx.")).toBe(false)
  })

  test("a markdown-ish bullet list", () => {
    // All dashes, no plus signs — requiring both signs is what excludes this.
    expect(isDiffLike("- first\n- second\n- third\n- fourth")).toBe(false)
  })

  test("a directory listing", () => {
    expect(isDiffLike("drwxr-xr-x  src\n-rw-r--r--  package.json\n-rw-r--r--  bun.lock")).toBe(false)
  })

  test("the edit tool's own line-oriented summary", () => {
    // haxford's edit tool reports `  line N: -"old" +"new"`, indented — the
    // markers are mid-line, so nothing here starts with + or -.
    expect(isDiffLike('Replaced 1 occurrence(s) in x.ts.\n  line 4: -"a" +"b"')).toBe(false)
  })

  test("a sparse +/- mention inside real output", () => {
    const output = [
      "Compiled 40 modules.",
      "-O2 was enabled.",
      "+ optional flag detected",
      "Everything else looked fine and nothing changed.",
      "Done in 4.1s.",
    ].join("\n")
    expect(isDiffLike(output)).toBe(false)
  })

  test("empty output", () => {
    expect(isDiffLike("")).toBe(false)
    expect(isDiffLike("\n\n")).toBe(false)
  })
})

describe("parseDiff: line classification", () => {
  test("every line of a git diff lands in the right bucket", () => {
    expect(parseDiff(GIT_DIFF).map((l) => l.kind)).toEqual([
      "meta", // diff --git
      "meta", // index
      "meta", // ---
      "meta", // +++
      "hunk",
      "context",
      "del",
      "add",
      "add",
      "context",
      "hunk",
      "del",
      "add",
      "context",
    ])
  })

  test("--- and +++ are headers, never a deletion and an addition", () => {
    // The ordering trap: classify these after +/- and every diff would look
    // like it had balanced changes no matter what it contained.
    const kinds = parseDiff("--- a/x\n+++ b/x").map((l) => l.kind)
    expect(kinds).toEqual(["meta", "meta"])
  })

  test("a hunk header needs real line numbers", () => {
    expect(parseDiff("@@ nonsense @@")[0]?.kind).toBe("context")
    expect(parseDiff("@@ -1 +1 @@")[0]?.kind).toBe("hunk")
  })

  test("text is preserved verbatim, markers included", () => {
    expect(parseDiff("+added")[0]).toEqual({ kind: "add", text: "+added" })
  })
})

describe("diffLineStyle", () => {
  test("additions are green and bold", () => {
    expect(diffLineStyle("add")).toEqual({ color: theme.diffAdd, bold: true, dim: false })
  })

  test("deletions are red", () => {
    expect(diffLineStyle("del")).toEqual({ color: theme.diffDel, bold: false, dim: false })
  })

  test("hunk and file headers recede", () => {
    expect(diffLineStyle("hunk").dim).toBe(true)
    expect(diffLineStyle("meta").dim).toBe(true)
  })

  test("context keeps the terminal's own foreground", () => {
    expect(diffLineStyle("context")).toEqual({ bold: false, dim: false })
  })
})

describe("truncateDiff", () => {
  const lines = parseDiff(GIT_DIFF)

  test("a diff inside the budget is untouched", () => {
    expect(truncateDiff(lines, 100)).toEqual({ lines, hidden: 0 })
  })

  test("an over-budget diff reports exactly what it hid", () => {
    const cut = truncateDiff(lines, 6)
    expect(cut.lines).toHaveLength(6)
    expect(cut.hidden).toBe(lines.length - 6)
  })

  test("trailing blank lines are dropped before counting", () => {
    // Otherwise a diff ending in a newline claims "… 1 more lines" for
    // nothing at all.
    const withTail = parseDiff("+a\n+b\n\n\n")
    expect(truncateDiff(withTail, 40)).toEqual({
      lines: [
        { kind: "add", text: "+a" },
        { kind: "add", text: "+b" },
      ],
      hidden: 0,
    })
  })

  test("the default budget is the full-size cap", () => {
    const long = parseDiff(Array.from({ length: 80 }, (_, i) => `+line ${i}`).join("\n"))
    const cut = truncateDiff(long)
    expect(cut.lines).toHaveLength(MAX_DIFF_LINES)
    expect(cut.hidden).toBe(80 - MAX_DIFF_LINES)
  })
})

describe("stripDiffMeta", () => {
  test("file headers go, hunk headers and changes stay", () => {
    const kept = stripDiffMeta(parseDiff(GIT_DIFF))
    expect(kept.some((l) => l.kind === "meta")).toBe(false)
    expect(kept.filter((l) => l.kind === "hunk")).toHaveLength(2)
    expect(kept.filter((l) => l.kind === "add")).toHaveLength(3)
    expect(kept.filter((l) => l.kind === "del")).toHaveLength(2)
  })
})

describe("DiffView rendering", () => {
  test("a multi-hunk diff renders every line in order", () => {
    const frame = frameOf(React.createElement(DiffView, { text: GIT_DIFF }))
    expect(frame).toContain("@@ -12,7 +12,9 @@")
    expect(frame).toContain("-const b = 2")
    expect(frame).toContain("+const b = 3")
    expect(frame).toContain("@@ -40,3 +42,3 @@")
    expect(frame.indexOf("-const b = 2")).toBeLessThan(frame.indexOf("@@ -40,3 +42,3 @@"))
  })

  test("over-budget output ends with the transcript's own overflow wording", () => {
    const long = Array.from({ length: 60 }, (_, i) => `+line ${i}`).join("\n")
    const frame = frameOf(React.createElement(DiffView, { text: long }))
    expect(frame).toContain("… 20 more lines")
    expect(frame).toContain("+line 39")
    expect(frame).not.toContain("+line 40")
  })

  test("compact mode spends its budget on changes, not on file headers", () => {
    // Regression: five header lines out of an eight-line budget meant the
    // collapsed preview showed no changes whatsoever.
    const frame = frameOf(
      React.createElement(DiffView, { text: GIT_DIFF, max: COLLAPSED_DIFF_LINES, compact: true }),
    )
    expect(frame).not.toContain("diff --git")
    expect(frame).not.toContain("index 1234567")
    expect(frame).toContain("-const b = 2")
    expect(frame).toContain("+const b = 3")
    // Hunk headers survive: they carry the line numbers.
    expect(frame).toContain("@@ -12,7 +12,9 @@")
  })

  test("non-compact mode keeps the headers", () => {
    const frame = frameOf(React.createElement(DiffView, { text: GIT_DIFF, compact: false }))
    expect(frame).toContain("diff --git")
    expect(frame).toContain("--- a/src/tui/app.tsx")
  })
})
