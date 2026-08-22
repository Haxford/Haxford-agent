import { describe, expect, test } from "bun:test"

import { shortCwd } from "../src/tui/components/Banner.tsx"
import {
  contextPercent,
  modeBadge,
  reasonLabel,
} from "../src/tui/components/StatusBar.tsx"
import {
  displayLabel,
  filterModels,
  formatCtx,
  formatModelMeta,
  formatPrice,
  groupModels,
  groupProviders,
  modelOf,
  normalizeModels,
  pageCount,
  paginate,
  providerConnected,
  providerOf,
  type ModelOption,
  type ProviderCatalogEntry,
} from "../src/tui/components/ModelPicker.tsx"
import { clampCursor, matchCommands, NO_ARG_COMMANDS, parseSlashCommand, takesArg } from "../src/tui/app.tsx"

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
  // Brackets are gone: the word is already a label because of its color, and
  // the composer's rail is now the primary mode indicator.
  test("each mode has a distinct theme color and an unbracketed label", () => {
    expect(modeBadge("build")).toEqual({ text: "build", color: "cyan" })
    expect(modeBadge("auto")).toEqual({ text: "auto", color: "green" })
    expect(modeBadge("plan")).toEqual({ text: "plan", color: "magenta" })
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

describe("ModelPicker.filterModels", () => {
  const models: ModelOption[] = [
    { spec: "anthropic/claude-sonnet", available: true, label: "Sonnet" },
    { spec: "anthropic/claude-opus", available: false, label: "Opus" },
    { spec: "openai/gpt-5", available: true },
  ]
  test("empty query returns all, available-first then alphabetical", () => {
    const out = filterModels(models, "")
    expect(out.map((m) => m.spec)).toEqual([
      "anthropic/claude-sonnet", // available, alphabetical
      "openai/gpt-5",            // available
      "anthropic/claude-opus",   // unavailable last
    ])
  })
  test("substring matches across spec + label, case-insensitive", () => {
    expect(filterModels(models, "sonnet").map((m) => m.spec)).toEqual(["anthropic/claude-sonnet"])
    expect(filterModels(models, "GPT").map((m) => m.spec)).toEqual(["openai/gpt-5"])
    expect(filterModels(models, "opus").map((m) => m.spec)).toEqual(["anthropic/claude-opus"])
  })
  test("no matches -> []", () => {
    expect(filterModels(models, "zzz")).toEqual([])
  })
  test("available-first within filtered results", () => {
    const mixed: ModelOption[] = [
      { spec: "a/x", available: false },
      { spec: "a/y", available: true },
    ]
    expect(filterModels(mixed, "a").map((m) => m.spec)).toEqual(["a/y", "a/x"])
  })
})

describe("ModelPicker.pageCount / paginate", () => {
  test("pageCount", () => {
    expect(pageCount(0, 20)).toBe(1)
    expect(pageCount(1, 20)).toBe(1)
    expect(pageCount(20, 20)).toBe(1)
    expect(pageCount(21, 20)).toBe(2)
    expect(pageCount(60, 20)).toBe(3)
    expect(pageCount(10, 0)).toBe(1) // guard
  })
  test("paginate returns the slice for a page", () => {
    const list = Array.from({ length: 50 }, (_, i) => i)
    expect(paginate(list, 0, 20)).toHaveLength(20)
    expect(paginate(list, 0, 20)[0]).toBe(0)
    expect(paginate(list, 1, 20)).toHaveLength(20)
    expect(paginate(list, 1, 20)[0]).toBe(20)
    expect(paginate(list, 2, 20)).toHaveLength(10)
    expect(paginate(list, 2, 20)[0]).toBe(40)
    expect(paginate(list, 3, 20)).toEqual([]) // out of range
  })
})

describe("Slash autocomplete: matchCommands", () => {
  test("only matches when prefix starts with /", () => {
    expect(matchCommands("hello")).toEqual([])
    expect(matchCommands("")).toEqual([])
  })
  test("exact / and short prefixes match all", () => {
    expect(matchCommands("/").length).toBe(10)
    expect(matchCommands("/m").map((r) => r.command)).toEqual(["/model", "/mode"])
  })
  test("case-insensitive", () => {
    expect(matchCommands("/HELP").map((r) => r.command)).toEqual(["/help"])
    expect(matchCommands("/Mo").map((r) => r.command)).toEqual(["/model", "/mode"])
  })
  test("no match -> []", () => {
    expect(matchCommands("/zzz")).toEqual([])
  })
})

describe("Slash autocomplete: takesArg / NO_ARG_COMMANDS", () => {
  test("no-arg commands are recognized", () => {
    expect(NO_ARG_COMMANDS.has("/help")).toBe(true)
    expect(NO_ARG_COMMANDS.has("/sessions")).toBe(true)
    expect(NO_ARG_COMMANDS.has("/compact")).toBe(true)
    expect(NO_ARG_COMMANDS.has("/clear")).toBe(true)
    expect(NO_ARG_COMMANDS.has("/exit")).toBe(true)
    expect(NO_ARG_COMMANDS.has("/connect")).toBe(true)
  })
  test("takesArg is false for no-arg commands, true otherwise", () => {
    expect(takesArg("/help")).toBe(false)
    expect(takesArg("/exit")).toBe(false)
    expect(takesArg("/connect")).toBe(false)
    expect(takesArg("/model")).toBe(true)
    expect(takesArg("/mode")).toBe(true)
    expect(takesArg("/init")).toBe(true)
  })
})

describe("Slash autocomplete: clampCursor", () => {
  test("wraps within 0..n-1", () => {
    expect(clampCursor(1, 5)).toBe(1)
    expect(clampCursor(-1, 5)).toBe(4)  // wraps to end
    expect(clampCursor(5, 5)).toBe(0)  // wraps to start
    expect(clampCursor(0, 0)).toBe(0)  // empty list
  })
})

describe("parseSlashCommand: /connect", () => {
  test("/connect decodes to a connect action", () => {
    expect(parseSlashCommand("/connect", "build")).toEqual({ kind: "connect" })
  })
  test("/connect is case-insensitive", () => {
    expect(parseSlashCommand("/CONNECT", "build")).toEqual({ kind: "connect" })
  })
})

describe("ModelPicker: providerConnected", () => {
  const models: ModelOption[] = [
    { spec: "anthropic/claude", available: true },
    { spec: "anthropic/haiku", available: false },
    { spec: "openai/gpt", available: false },
    { spec: "ollama/llama", available: true },
  ]
  test("connected when at least one model is available", () => {
    expect(providerConnected("anthropic", models)).toBe(true)
    expect(providerConnected("ollama", models)).toBe(true)
  })
  test("unconnected when every model is unavailable", () => {
    expect(providerConnected("openai", models)).toBe(false)
  })
  test("unknown provider is unconnected", () => {
    expect(providerConnected("zai", models)).toBe(false)
  })
})

describe("ModelPicker: groupProviders (level-1)", () => {
  const models: ModelOption[] = [
    { spec: "openai/gpt-5", available: true },
    { spec: "openai/gpt-4", available: false },
    { spec: "anthropic/claude", available: true },
    { spec: "ollama/llama", available: false }, // unconnected, in catalog
    { spec: "custom-gw/my-model", available: true }, // not in catalog
  ]
  const catalog: ProviderCatalogEntry[] = [
    { name: "anthropic", connected: true },
    { name: "openai", connected: true },
    { name: "ollama", connected: false },
    { name: "moonshot", connected: false }, // catalog-only (no models in list)
  ]

  test("connected providers come first, alphabetical", () => {
    const rows = groupProviders(models, catalog)
    const names = rows.map((r) => r.name)
    // Connected tier (anthropic, custom-gw, openai) alphabetical, then unconnected (moonshot, ollama).
    expect(names).toEqual(["anthropic", "custom-gw", "openai", "moonshot", "ollama"])
  })

  test("connected flag derived from model availability, not the catalog", () => {
    const rows = groupProviders(models, catalog)
    const byName = new Map(rows.map((r) => [r.name, r]))
    expect(byName.get("anthropic")!.connected).toBe(true)
    expect(byName.get("openai")!.connected).toBe(true)
    // ollama has models but all unavailable -> unconnected (catalog agrees).
    expect(byName.get("ollama")!.connected).toBe(false)
    // moonshot has no models at all -> unconnected.
    expect(byName.get("moonshot")!.connected).toBe(false)
  })

  test("connectable reflects catalog membership", () => {
    const rows = groupProviders(models, catalog)
    const byName = new Map(rows.map((r) => [r.name, r]))
    expect(byName.get("anthropic")!.connectable).toBe(true)
    expect(byName.get("ollama")!.connectable).toBe(true)
    expect(byName.get("custom-gw")!.connectable).toBe(false) // not in catalog
  })

  test("modelCount is per-provider", () => {
    const rows = groupProviders(models, catalog)
    const byName = new Map(rows.map((r) => [r.name, r]))
    expect(byName.get("openai")!.modelCount).toBe(2)
    expect(byName.get("anthropic")!.modelCount).toBe(1)
    expect(byName.get("moonshot")!.modelCount).toBe(0)
  })

  test("catalog-only providers (no models) are listed as unconnected", () => {
    const rows = groupProviders(models, catalog)
    const moonshot = rows.find((r) => r.name === "moonshot")
    expect(moonshot).toBeDefined()
    expect(moonshot!.connected).toBe(false)
    expect(moonshot!.modelCount).toBe(0)
  })

  test("without a catalog, providers are still grouped (connectable=false)", () => {
    const rows = groupProviders(models)
    const names = rows.map((r) => r.name)
    expect(names).toEqual(["anthropic", "custom-gw", "openai", "ollama"])
    for (const r of rows) expect(r.connectable).toBe(false)
  })
})
