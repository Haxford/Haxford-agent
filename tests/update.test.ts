import { describe, expect, test } from "bun:test"
import { isNewer, targetCandidatesForTest } from "../src/update.ts"

describe("update", () => {
  test("isNewer orders dotted versions", () => {
    expect(isNewer("0.2.0", "0.1.0")).toBe(true)
    expect(isNewer("1.0.0", "0.9.9")).toBe(true)
    expect(isNewer("0.1.0", "0.1.0")).toBe(false)
    expect(isNewer("0.1.0", "0.2.3")).toBe(false)
    expect(isNewer("0.10.0", "0.9.0")).toBe(true)
  })
  test("target candidates exist for this platform", async () => {
    const c = await targetCandidatesForTest()
    expect(c.length).toBeGreaterThan(0)
    for (const t of c) expect(t).toMatch(/^(linux|darwin)-(x64|arm64)(-musl)?(-baseline)?$/)
  })
})
