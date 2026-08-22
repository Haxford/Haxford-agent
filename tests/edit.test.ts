import { describe, expect, test } from "bun:test"

import { editTool } from "../src/tools/edit.ts"
import { recordRead } from "../src/tools/shared.ts"
import type { ToolContext } from "../src/types/tool.ts"

function ctx(cwd = process.cwd()): ToolContext {
  return {
    sessionID: `s-${crypto.randomUUID()}`,
    agent: "test",
    cwd,
    abort: new AbortController().signal,
    askPermission: async () => "allow",
  }
}

async function tmpdir(): Promise<string> {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-edit-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, "")
  return dir
}

async function writeFile(dir: string, name: string, content: string): Promise<string> {
  const path = `${dir}/${name}`
  await Bun.write(path, content)
  return path
}

describe("edit tool — flat single-edit form (backward compat)", () => {
  test("oldString/newString still works", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "const x = 1\nconst y = 2\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      { filePath: path, oldString: "const x = 1", newString: "const x = 42" },
      c,
    )
    expect(result.output).toContain("Replaced")
    expect(await Bun.file(path).text()).toBe("const x = 42\nconst y = 2\n")
  })

  test("replaceAll flat form still works", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "foo\nfoo\nbar\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      { filePath: path, oldString: "foo", newString: "baz", replaceAll: true },
      c,
    )
    expect(result.output).toContain("Replaced")
    expect(await Bun.file(path).text()).toBe("baz\nbaz\nbar\n")
  })
})

describe("edit tool — edits[] multi-edit", () => {
  test("applies multiple disjoint edits in one call", async () => {
    const dir = await tmpdir()
    const path = await writeFile(
      dir,
      "a.ts",
      "const x = 1\nconst y = 2\nconst z = 3\n",
    )
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "const x = 1", newText: "const x = 42" },
          { oldText: "const z = 3", newText: "const z = 99" },
        ],
      },
      c,
    )
    expect(result.output).toContain("Replaced")
    expect(await Bun.file(path).text()).toBe(
      "const x = 42\nconst y = 2\nconst z = 99\n",
    )
  })

  test("every oldText is matched against the ORIGINAL file, not incrementally", async () => {
    const dir = await tmpdir()
    const path = await writeFile(
      dir,
      "a.ts",
      "line1\nline2\nline3\n",
    )
    const c = ctx()
    recordRead(c.sessionID, path)
    // edit[0] changes line1→LINE1; edit[1] still matches the original line3,
    // not the post-edit-0 content.
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "line1", newText: "LINE1" },
          { oldText: "line3", newText: "LINE3" },
        ],
      },
      c,
    )
    expect(result.output).toContain("Replaced")
    expect(await Bun.file(path).text()).toBe("LINE1\nline2\nLINE3\n")
  })

  test("rejects overlapping spans", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "hello world\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "hello world", newText: "HI WORLD" },
          { oldText: "world", newText: "earth" },
        ],
      },
      c,
    )
    expect(result.output).toContain("overlap")
    // File is unchanged.
    expect(await Bun.file(path).text()).toBe("hello world\n")
  })

  test("rejects when one edit in the array does not match (all-or-nothing)", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "aaa\nbbb\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "aaa", newText: "AAA" },
          { oldText: "nonexistent", newText: "XXX" },
        ],
      },
      c,
    )
    expect(result.output).toContain("Error")
    expect(await Bun.file(path).text()).toBe("aaa\nbbb\n")
  })

  test("rejects ambiguous match in one edit of the array", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "dup\ndup\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "dup", newText: "unique" },
        ],
      },
      c,
    )
    expect(result.output).toContain("Error")
    expect(result.output).toContain("2 matches")
  })

  test("replaceAll inside an edits[] entry replaces all occurrences", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "foo\nfoo\nbar\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "foo", newText: "baz", replaceAll: true },
        ],
      },
      c,
    )
    expect(result.output).toContain("Replaced")
    expect(await Bun.file(path).text()).toBe("baz\nbaz\nbar\n")
  })

  test("returns a diff summary in the output", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "const x = 1\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        edits: [
          { oldText: "const x = 1", newText: "const x = 42" },
        ],
      },
      c,
    )
    expect(result.output).toContain("line")
    expect(result.output).toContain("const x = 1")
    expect(result.output).toContain("const x = 42")
  })

  test("rejects both flat and edits[] at once", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "hello\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      {
        filePath: path,
        oldString: "hello",
        newString: "world",
        edits: [{ oldText: "hello", newText: "world" }],
      },
      c,
    )
    expect(result.output).toContain("Error")
  })

  test("rejects empty edits[]", async () => {
    const dir = await tmpdir()
    const path = await writeFile(dir, "a.ts", "hello\n")
    const c = ctx()
    recordRead(c.sessionID, path)
    const result = await editTool.execute(
      { filePath: path, edits: [] },
      c,
    )
    expect(result.output).toContain("Error")
  })
})
