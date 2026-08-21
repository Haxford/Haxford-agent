import { describe, expect, test } from "bun:test"

import { shortCwd } from "../src/tui/components/Banner.tsx"
import {
  contextPercent,
  modeBadge,
  reasonLabel,
  shortSession,
} from "../src/tui/components/StatusBar.tsx"
import {
  displayLabel,
  formatCtx,
  formatModelMeta,
  formatPrice,
  groupModels,
  modelOf,
  normalizeModels,
  providerOf,
  type ModelOption,
} from "../src/tui/components/ModelPicker.tsx"

describe("Banner.shortCwd", () => {
  test("returns the basename", () => {
    expect(shortCwd("/home/harry/projects/x")).toBe("x")
    expect(shortCwd("/a/b/c")).toBe("c")
  })
  test("handles trailing slashes and root", () => {
    expect(shortCwd("/a/b/")).toBe("b")
    expect(shortCwd("/")).toBe("/")
    expect(shortCwd("nopath")).toBe("nopath")
  })
})

describe("StatusBar.modeBadge", () => {
  test("each mode has a distinct color + bracketed label", () => {
    expect(modeBadge("build")).toEqual({ text: "[build]", color: "cyan" })
    expect(modeBadge("auto")).toEqual({ text: "[auto]", color: "green" })
    expect(modeBadge("plan")).toEqual({ text: "[plan]", color: "magenta" })
  })
})

describe("StatusBar.contextPercent", () => {
  test("undefined when limit is undefined or zero", () => {
    expect(contextPercent({ input: 100, output: 0, reasoning: 0 })).toBeUndefined()
    expect(contextPercent({ input: 100, output: 0, reasoning: 0 }, 0)).toBeUndefined()
  })
  test("0 when nothing used", () => {
    expect(contextPercent({ input: 0, output: 0, reasoning: 0 }, 200_000)).toBe(0)
  })
  test("rounds to a percent, capped at 100", () => {
    expect(contextPercent({ input: 100_000, output: 0, reasoning: 0 }, 200_000)).toBe(50)
    expect(contextPercent({ input: 150_000, output: 0, reasoning: 0 }, 200_000)).toBe(75)
    expect(contextPercent({ input: 300_000, output: 0, reasoning: 0 }, 200_000)).toBe(100)
  })
  test("counts reasoning toward used", () => {
    expect(contextPercent({ input: 100_000, output: 0, reasoning: 50_000 }, 200_000)).toBe(75)
  })
})

describe("StatusBar.shortSession", () => {
  test("8-char prefix", () => {
    expect(shortSession("aaaabbbb-cccc-dddd")).toBe("aaaabbbb")
  })
  test("returns short ids unchanged", () => {
    expect(shortSession("aaaabbbb")).toBe("aaaabbbb")
    expect(shortSession("ab")).toBe("ab")
  })
  test("undefined for undefined", () => {
    expect(shortSession(undefined)).toBeUndefined()
  })
})

describe("StatusBar.reasonLabel", () => {
  test("end_turn is suppressed", () => {
    expect(reasonLabel("end_turn")).toBeUndefined()
  })
  test("aborted/max_turns/permission_denied are yellow", () => {
    expect(reasonLabel("aborted")?.color).toBe("yellow")
    expect(reasonLabel("max_turns")?.color).toBe("yellow")
    expect(reasonLabel("permission_denied")?.color).toBe("yellow")
  })
  test("error is red", () => {
    expect(reasonLabel("error")?.color).toBe("red")
    expect(reasonLabel("error")?.text).toBe("error")
  })
})

describe("ModelPicker.normalizeModels", () => {
  test("strings become available entries", () => {
    const out = normalizeModels(["a/b", "c/d"])
    expect(out).toEqual([
      { spec: "a/b", available: true },
      { spec: "c/d", available: true },
    ])
  })
  test("rich entries pass through", () => {
    const rich: ModelOption[] = [
      { spec: "a/b", available: true, label: "B" },
      { spec: "c/d", available: false },
    ]
    expect(normalizeModels(rich)).toBe(rich)
  })
  test("empty input", () => {
    expect(normalizeModels([])).toEqual([])
  })
})

describe("ModelPicker.providerOf / modelOf", () => {
  test("splits on the first slash", () => {
    expect(providerOf("anthropic/claude-sonnet-4")).toBe("anthropic")
    expect(modelOf("anthropic/claude-sonnet-4")).toBe("claude-sonnet-4")
  })
  test("model id may contain slashes", () => {
    expect(providerOf("openrouter/anthropic/claude-sonnet-4")).toBe("openrouter")
    expect(modelOf("openrouter/anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4")
  })
})

describe("ModelPicker.groupModels", () => {
  test("groups by provider, alphabetical; available first within provider", () => {
    const models: ModelOption[] = [
      { spec: "openai/gpt-5", available: true },
      { spec: "anthropic/claude", available: true },
      { spec: "anthropic/opus", available: false },
      { spec: "anthropic/sonnet", available: true },
    ]
    const groups = groupModels(models)
    expect(groups.map((g) => g.provider)).toEqual(["anthropic", "openai"])
    // anthropic group: available first (claude, sonnet), then unavailable (opus)
    expect(groups[0]!.entries.map((e) => e.spec)).toEqual([
      "anthropic/claude",
      "anthropic/sonnet",
      "anthropic/opus",
    ])
  })
  test("empty input", () => {
    expect(groupModels([])).toEqual([])
  })
})

describe("ModelPicker.formatCtx / formatPrice", () => {
  test("formatCtx", () => {
    expect(formatCtx(200_000)).toBe("200k")
    expect(formatCtx(128_000)).toBe("128k")
    expect(formatCtx(1_000_000)).toBe("1M")
    expect(formatCtx(1_500_000)).toBe("1.5M")
    expect(formatCtx(500)).toBe("500")
  })
  test("formatPrice", () => {
    expect(formatPrice(0.15)).toBe("$0.15/M")
    expect(formatPrice(0.6)).toBe("$0.60/M")
    expect(formatPrice(0)).toBe("$0.00/M")
  })
})

describe("ModelPicker.formatModelMeta", () => {
  test("context only", () => {
    expect(formatModelMeta({ spec: "a/b", available: true, contextLength: 200_000 })).toBe("200k ctx")
  })
  test("context + both prices nonzero", () => {
    expect(
      formatModelMeta({
        spec: "a/b", available: true, contextLength: 200_000,
        promptPricePerMtok: 0.15, completionPricePerMtok: 0.6,
      }),
    ).toBe("200k ctx · $0.15/M · $0.60/M")
  })
  test("both prices zero -> :free", () => {
    expect(
      formatModelMeta({
        spec: "a/b", available: true,
        promptPricePerMtok: 0, completionPricePerMtok: 0,
      }),
    ).toBe(":free")
  })
  test("context + both prices zero -> ctx + :free", () => {
    expect(
      formatModelMeta({
        spec: "a/b", available: true, contextLength: 128_000,
        promptPricePerMtok: 0, completionPricePerMtok: 0,
      }),
    ).toBe("128k ctx · :free")
  })
  test("no metadata -> empty string", () => {
    expect(formatModelMeta({ spec: "a/b", available: true })).toBe("")
  })
})

describe("ModelPicker.displayLabel", () => {
  test("label wins over spec tail", () => {
    expect(displayLabel({ spec: "anthropic/claude-sonnet-4", available: true, label: "Sonnet 4" })).toBe("Sonnet 4")
  })
  test("falls back to spec tail when no label", () => {
    expect(displayLabel({ spec: "anthropic/claude-sonnet-4", available: true })).toBe("claude-sonnet-4")
  })
  test("blank label falls back to spec tail", () => {
    expect(displayLabel({ spec: "anthropic/claude", available: true, label: "   " })).toBe("claude")
  })
})
