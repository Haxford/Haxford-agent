import { describe, expect, test } from "bun:test"

import { webfetchTool } from "../src/tools/webfetch.ts"
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

describe("webfetch tool", () => {
  test("rejects non-https non-local URLs", async () => {
    const result = await webfetchTool.execute(
      { url: "http://example.com/page" },
      ctx(),
    )
    expect(result.output).toContain("Error")
    expect(result.output).toContain("HTTPS")
  })

  test("accepts https URLs", async () => {
    // We don't actually fetch — we just check that validation passes by
    // expecting the tool to NOT reject on the URL scheme. A network call
    // may fail, but the error won't be about the scheme.
    const result = await webfetchTool.execute(
      { url: "https://nonexistent.invalid/never" },
      ctx(),
    )
    expect(result.output).not.toContain("uses HTTP for a non-local host")
  })

  test("accepts http for localhost", async () => {
    const result = await webfetchTool.execute(
      { url: "http://localhost:9999/test" },
      ctx(),
    )
    // The fetch will fail (no server), but not with a URL validation error.
    expect(result.output).not.toContain("HTTPS")
  })

  test("accepts http for 127.0.0.1", async () => {
    const result = await webfetchTool.execute(
      { url: "http://127.0.0.1:9999/test" },
      ctx(),
    )
    expect(result.output).not.toContain("HTTPS")
  })

  test("rejects invalid URLs", async () => {
    const result = await webfetchTool.execute(
      { url: "not a url" },
      ctx(),
    )
    expect(result.output).toContain("Error")
    expect(result.output).toContain("not a valid URL")
  })

  test("rejects non-http(s) protocols", async () => {
    const result = await webfetchTool.execute(
      { url: "ftp://example.com/file" },
      ctx(),
    )
    expect(result.output).toContain("Error")
    expect(result.output).toContain("http(s)")
  })

  test("denied permission returns a refusal", async () => {
    const c = ctx()
    c.askPermission = async () => "deny"
    const result = await webfetchTool.execute(
      { url: "https://example.com/page" },
      c,
    )
    expect(result.output).toContain("declined")
  })
})

describe("webfetch htmlToText (indirectly via tool description)", () => {
  test("tool is registered with id 'webfetch'", () => {
    expect(webfetchTool.id).toBe("webfetch")
  })

  test("description mentions https requirement and caching", () => {
    expect(webfetchTool.description).toContain("https")
    expect(webfetchTool.description).toContain("cache")
  })
})
