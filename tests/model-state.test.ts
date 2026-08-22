import { describe, expect, test } from "bun:test"

import { loadProjectModel, saveProjectModel } from "../src/config/state.ts"

async function tmpdir(): Promise<string> {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-state-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, "")
  return dir
}

describe("model persistence", () => {
  test("saveProjectModel writes a state file loadProjectModel reads back", async () => {
    const dir = await tmpdir()
    await saveProjectModel(dir, "anthropic/claude-sonnet-5")
    expect(loadProjectModel(dir)).toBe("anthropic/claude-sonnet-5")
  })

  test("loadProjectModel returns undefined when no state file exists", async () => {
    const dir = await tmpdir()
    expect(loadProjectModel(dir)).toBeUndefined()
  })

  test("loadProjectModel returns undefined for a corrupt state file", async () => {
    const dir = await tmpdir()
    await Bun.write(`${dir}/.haxford/state.json`, "not json{")
    expect(loadProjectModel(dir)).toBeUndefined()
  })

  test("loadProjectModel returns undefined when model field is missing", async () => {
    const dir = await tmpdir()
    await Bun.write(`${dir}/.haxford/state.json`, JSON.stringify({ other: "field" }))
    expect(loadProjectModel(dir)).toBeUndefined()
  })

  test("loadProjectModel returns undefined for an empty model string", async () => {
    const dir = await tmpdir()
    await Bun.write(`${dir}/.haxford/state.json`, JSON.stringify({ model: "  " }))
    expect(loadProjectModel(dir)).toBeUndefined()
  })

  test("saveProjectModel overwrites a previous value", async () => {
    const dir = await tmpdir()
    await saveProjectModel(dir, "anthropic/claude-sonnet-5")
    await saveProjectModel(dir, "openai/gpt-5")
    expect(loadProjectModel(dir)).toBe("openai/gpt-5")
  })

  test("saveProjectModel creates the .haxford directory if missing", async () => {
    const dir = await tmpdir()
    // No .haxford dir yet — saveProjectModel must create it.
    await saveProjectModel(dir, "openrouter/z-ai/glm-5.2")
    expect(loadProjectModel(dir)).toBe("openrouter/z-ai/glm-5.2")
  })
})
