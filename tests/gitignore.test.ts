import { describe, expect, test } from "bun:test"

import { isIgnored, parseGitignore, readGitignores } from "../src/tools/shared.ts"

async function tmpdir(): Promise<string> {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-git-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, "")
  return dir
}

describe("parseGitignore", () => {
  test("parses basic patterns", () => {
    const patterns = parseGitignore("node_modules\ndist\n*.log\n")
    expect(patterns).toEqual([
      { pattern: "node_modules", negate: false },
      { pattern: "dist", negate: false },
      { pattern: "*.log", negate: false },
    ])
  })

  test("handles negations", () => {
    const patterns = parseGitignore("*.log\n!important.log\n")
    expect(patterns).toEqual([
      { pattern: "*.log", negate: false },
      { pattern: "important.log", negate: true },
    ])
  })

  test("drops comments and blank lines", () => {
    const patterns = parseGitignore("# a comment\n\nnode_modules\n")
    expect(patterns).toEqual([{ pattern: "node_modules", negate: false }])
  })
})

describe("isIgnored", () => {
  test("ignores a matching directory", () => {
    const patterns = parseGitignore("node_modules\n")
    expect(isIgnored("node_modules/foo.ts", patterns)).toBe(true)
  })

  test("does not ignore a non-matching path", () => {
    const patterns = parseGitignore("node_modules\n")
    expect(isIgnored("src/foo.ts", patterns)).toBe(false)
  })

  test("negation un-ignores", () => {
    const patterns = parseGitignore("*.log\n!important.log\n")
    expect(isIgnored("debug.log", patterns)).toBe(true)
    expect(isIgnored("important.log", patterns)).toBe(false)
  })

  test("glob patterns match", () => {
    const patterns = parseGitignore("*.log\n")
    expect(isIgnored("build.log", patterns)).toBe(true)
    expect(isIgnored("src/app.log", patterns)).toBe(true)
  })

  test("trailing slash matches directories only", () => {
    const patterns = parseGitignore("build/\n")
    expect(isIgnored("build/output.ts", patterns)).toBe(true)
    expect(isIgnored("build", patterns)).toBe(false)
  })

  test("bare pattern matches any segment", () => {
    const patterns = parseGitignore("dist\n")
    expect(isIgnored("dist/file.ts", patterns)).toBe(true)
    expect(isIgnored("src/dist/file.ts", patterns)).toBe(true)
  })
})

describe("readGitignores", () => {
  test("reads a .gitignore in the root", async () => {
    const dir = await tmpdir()
    await Bun.write(`${dir}/.gitignore`, "dist\n*.log\n")
    const patterns = await readGitignores(dir)
    expect(patterns.length).toBeGreaterThanOrEqual(2)
    expect(patterns.some((p) => p.pattern === "dist")).toBe(true)
  })

  test("walks up to parent directories", async () => {
    const dir = await tmpdir()
    const sub = `${dir}/packages/app`
    await Bun.write(`${sub}/.keep`, "", { createPath: true } as never)
    await Bun.write(`${dir}/.gitignore`, "node_modules\n")
    await Bun.write(`${sub}/.gitignore`, "dist\n")
    const patterns = await readGitignores(sub)
    // Both the parent and child patterns should be present.
    expect(patterns.some((p) => p.pattern === "node_modules")).toBe(true)
    expect(patterns.some((p) => p.pattern === "dist")).toBe(true)
  })

  test("returns empty when no .gitignore exists", async () => {
    const dir = await tmpdir()
    const patterns = await readGitignores(dir)
    expect(patterns).toEqual([])
  })
})
