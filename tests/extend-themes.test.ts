import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"

import { assembleSystemPrompt } from "../src/agent/prompt.ts"
import { loadConfig } from "../src/config/index.ts"
import { ensureExtendingDoc, EXTENDING_MD } from "../src/extend/doc.ts"
import { extendingDocPath, extensionsDir, haxfordHome, skillsDir, themesDir } from "../src/extend/paths.ts"
import { extensionRegistry, loadExtensibility } from "../src/extend/index.ts"
import { clearSkills, scanSkills, type SkillSummary } from "../src/extend/skills.ts"
import {
  activeThemeName,
  applyTokens,
  DEFAULT_THEME_NAME,
  listThemes,
  loadTheme,
  THEME_TOKENS,
} from "../src/extend/themes.ts"
import { dark } from "../src/tui/theme.ts"

const TMP = process.env["TMPDIR"] ?? "/tmp"

let home: string
let saved: Record<string, string | undefined> = {}

function stash(...names: string[]): void {
  for (const name of names) saved[name] = process.env[name]
}
function restore(): void {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  saved = {}
}

beforeEach(async () => {
  home = path.join(TMP, `haxford-theme-${crypto.randomUUID()}`)
  stash("HAXFORD_HOME", "HAXFORD_THEME", "XDG_CONFIG_HOME")
  process.env["HAXFORD_HOME"] = home
  delete process.env["HAXFORD_THEME"]
  // The real global config is a lower-precedence layer and would leak its own
  // `theme` into the loadConfig assertions below.
  const emptyXdg = path.join(TMP, `haxford-theme-xdg-${crypto.randomUUID()}`)
  await Bun.write(path.join(emptyXdg, ".keep"), "")
  process.env["XDG_CONFIG_HOME"] = emptyXdg
  await Bun.write(path.join(home, ".keep"), "")
})

afterEach(async () => {
  extensionRegistry().clear()
  clearSkills()
  restore()
  await rm(home, { recursive: true, force: true })
})

async function theme(name: string, tokens: unknown): Promise<void> {
  await Bun.write(path.join(home, "themes", `${name}.json`), JSON.stringify(tokens, null, 2))
}

/* -------------------------------------------------------------------------- */
/* Themes                                                                      */
/* -------------------------------------------------------------------------- */

describe("theme token validation", () => {
  test("the token set is derived from the TUI's own Theme, not restated", () => {
    // If this ever drifts, a theme file written against the docs stops working.
    expect([...THEME_TOKENS].sort()).toEqual(Object.keys(dark).sort())
    expect(THEME_TOKENS).toContain("accent")
    expect(THEME_TOKENS).toContain("diffAdd")
  })

  test("declared tokens win and undeclared ones keep their default", async () => {
    await theme("violet", { accent: "magenta", user: "cyan" })
    const loaded = await loadTheme("violet", themesDir())

    expect(loaded.name).toBe("violet")
    expect(loaded.warnings).toEqual([])
    expect(loaded.theme.accent).toBe("magenta")
    expect(loaded.theme.user).toBe("cyan")
    // Everything else is the built-in value — a three-line theme is valid.
    expect(loaded.theme.error).toBe(dark.error)
    expect(loaded.theme.diffAdd).toBe(dark.diffAdd)
    expect(Object.keys(loaded.theme).sort()).toEqual(Object.keys(dark).sort())
  })

  test("an unknown token is warned about and ignored", async () => {
    await theme("odd", { accent: "blue", sparkle: "rainbow" })
    const loaded = await loadTheme("odd", themesDir())

    expect(loaded.theme.accent).toBe("blue")
    expect(loaded.theme).not.toHaveProperty("sparkle")
    expect(loaded.warnings.join("\n")).toContain('unknown theme token "sparkle"')
  })

  test("a non-string value falls back to the default rather than blanking a colour", async () => {
    await theme("wrong", { accent: 42, error: null, success: ["green"] })
    const loaded = await loadTheme("wrong", themesDir())

    expect(loaded.theme.accent).toBe(dark.accent)
    expect(loaded.theme.error).toBe(dark.error)
    expect(loaded.theme.success).toBe(dark.success)
    expect(loaded.warnings).toHaveLength(3)
    expect(loaded.warnings[0]).toContain("must be a string")
  })

  test('an empty string is a valid value — it means "inherit the terminal"', async () => {
    await theme("inherit", { text: "", muted: "" })
    const loaded = await loadTheme("inherit", themesDir())
    expect(loaded.theme.text).toBe("")
    expect(loaded.theme.muted).toBe("")
    expect(loaded.warnings).toEqual([])
  })

  test("a missing theme file falls back to the default, with a warning naming the path", async () => {
    const loaded = await loadTheme("nope", themesDir())
    expect(loaded.name).toBe(DEFAULT_THEME_NAME)
    expect(loaded.theme).toEqual(dark)
    expect(loaded.warnings[0]).toContain("not found")
    expect(loaded.warnings[0]).toContain(path.join(home, "themes", "nope.json"))
  })

  test("a malformed theme file falls back to the default", async () => {
    await Bun.write(path.join(home, "themes", "broken.json"), "{ not json")
    const loaded = await loadTheme("broken", themesDir())
    expect(loaded.theme).toEqual(dark)
    expect(loaded.warnings[0]).toContain("not valid JSON")
  })

  test("a theme file that is not an object falls back cleanly", async () => {
    await theme("list", ["cyan", "green"])
    const loaded = await loadTheme("list", themesDir())
    expect(loaded.theme).toEqual(dark)
  })

  test("the default theme is never read from disk", async () => {
    // Even with a default.json sitting there, "default" means the built-in.
    await theme("default", { accent: "red" })
    const loaded = await loadTheme(DEFAULT_THEME_NAME, themesDir())
    expect(loaded.theme.accent).toBe(dark.accent)
    expect(loaded.warnings).toEqual([])
  })

  test("a theme name cannot escape the themes directory", async () => {
    for (const name of ["../../etc/passwd", "sub/theme", "..\\win"]) {
      const loaded = await loadTheme(name, themesDir())
      expect(loaded.name).toBe(DEFAULT_THEME_NAME)
      expect(loaded.warnings[0]).toContain("invalid theme name")
    }
  })

  test("applyTokens is total: any garbage yields a complete theme", () => {
    for (const input of [null, undefined, 42, "cyan", [], { accent: {} }]) {
      const { theme: result } = applyTokens(input)
      expect(Object.keys(result).sort()).toEqual(Object.keys(dark).sort())
    }
  })

  test("listThemes names what is on disk, sorted, and ignores non-JSON", async () => {
    await theme("zebra", {})
    await theme("alpha", {})
    await Bun.write(path.join(home, "themes", "README.md"), "not a theme")
    await Bun.write(path.join(home, "themes", ".hidden.json"), "{}")

    expect(await listThemes(themesDir())).toEqual(["alpha", "zebra"])
    expect(await listThemes(path.join(home, "nope"))).toEqual([])
  })
})

describe("theme selection", () => {
  test("HAXFORD_THEME beats the config field, which beats the built-in", () => {
    expect(activeThemeName()).toBe(DEFAULT_THEME_NAME)
    expect(activeThemeName("fromconfig")).toBe("fromconfig")
    process.env["HAXFORD_THEME"] = "fromenv"
    expect(activeThemeName("fromconfig")).toBe("fromenv")
  })

  test("blank values do not count as a selection", () => {
    process.env["HAXFORD_THEME"] = "   "
    expect(activeThemeName("  ")).toBe(DEFAULT_THEME_NAME)
  })

  test("loadExtensibility resolves the configured theme", async () => {
    await theme("violet", { accent: "magenta" })
    const state = await loadExtensibility({ themeName: "violet" })
    expect(state.theme.name).toBe("violet")
    expect(state.theme.theme.accent).toBe("magenta")
  })

  test("a broken theme is a warning, not a failed startup", async () => {
    const state = await loadExtensibility({ themeName: "missing" })
    expect(state.theme.name).toBe(DEFAULT_THEME_NAME)
    expect(state.theme.theme).toEqual(dark)
    expect(state.warnings.some((w) => w.includes("missing"))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* config.theme                                                                */
/* -------------------------------------------------------------------------- */

describe("theme in config", () => {
  async function project(files: Record<string, unknown>): Promise<string> {
    const dir = path.join(TMP, `haxford-cfg-${crypto.randomUUID()}`)
    for (const [name, body] of Object.entries(files)) {
      await Bun.write(path.join(dir, name), JSON.stringify(body, null, 2))
    }
    await Bun.write(path.join(dir, ".keep"), "")
    return dir
  }

  test("theme is parsed out and never reaches HaxfordConfig", async () => {
    const dir = await project({ "haxford.json": { theme: "violet", maxTurns: 12 } })
    const loaded = await loadConfig(dir)

    expect(loaded.theme).toBe("violet")
    expect(loaded.config.maxTurns).toBe(12)
    // `HaxfordConfig` is frozen and has no `theme`; smuggling one in via the
    // spread would put an undeclared field on the contract.
    expect(loaded.config).not.toHaveProperty("theme")
  })

  test("the highest-precedence layer that names a theme wins", async () => {
    const dir = await project({
      "haxford.json": { theme: "project" },
      ".haxford/settings.local.json": { theme: "local" },
    })
    expect((await loadConfig(dir)).theme).toBe("local")
  })

  test("a layer with no theme does not blank a lower one", async () => {
    const dir = await project({
      "haxford.json": { theme: "project" },
      ".haxford/settings.local.json": { maxTurns: 3 },
    })
    expect((await loadConfig(dir)).theme).toBe("project")
  })

  test("a non-string or blank theme is ignored", async () => {
    for (const value of [42, "", "   ", null]) {
      const dir = await project({ "haxford.json": { theme: value } })
      expect((await loadConfig(dir)).theme).toBeUndefined()
    }
  })

  test("no theme field leaves it undefined", async () => {
    const dir = await project({ "haxford.json": { maxTurns: 5 } })
    expect((await loadConfig(dir)).theme).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* EXTENDING.md                                                                */
/* -------------------------------------------------------------------------- */

describe("EXTENDING.md", () => {
  test("is created on first run", async () => {
    const result = await ensureExtendingDoc()
    expect(result.created).toBe(true)
    expect(result.path).toBe(path.join(home, "EXTENDING.md"))
    expect(await Bun.file(result.path).text()).toBe(EXTENDING_MD)
  })

  test("is never overwritten, so user edits survive", async () => {
    const file = extendingDocPath()
    await Bun.write(file, "# my own notes\n")

    const first = await ensureExtendingDoc()
    const second = await ensureExtendingDoc()

    expect(first.created).toBe(false)
    expect(second.created).toBe(false)
    expect(await Bun.file(file).text()).toBe("# my own notes\n")
  })

  test("creation is idempotent across repeated startups", async () => {
    expect((await loadExtensibility()).doc.created).toBe(true)
    expect((await loadExtensibility()).doc.created).toBe(false)
    expect(await Bun.file(extendingDocPath()).text()).toBe(EXTENDING_MD)
  })

  test("first run seeds the three directories so the layout is discoverable", async () => {
    const { readdir } = await import("node:fs/promises")
    await loadExtensibility()
    for (const dir of [skillsDir(), extensionsDir(), themesDir()]) {
      // readdir throws on a missing directory, so this asserts both that each
      // one exists and that nothing was invented inside it.
      expect(await readdir(dir)).toEqual([])
    }
  })

  test("documents each layer, both hook signatures and a working example each", () => {
    for (const needle of [
      "~/.haxford/skills/<name>/SKILL.md",
      "~/.haxford/extensions/*.ts",
      "~/.haxford/themes/<name>.json",
      "registerCommand",
      "registerTool",
      "onStart",
      "onMessage",
      "onToolCall",
      '/reload',
      'haxford.registerCommand("ping"',
      'id: "wordcount"',
      '"accent": "magenta"',
    ]) {
      expect(EXTENDING_MD).toContain(needle)
    }
  })

  test("the in-repo copy at docs/extending.md has not drifted", async () => {
    const committed = await Bun.file("docs/extending.md").text()
    expect(committed).toBe(EXTENDING_MD)
  })

  test("haxfordHome honours HAXFORD_HOME", () => {
    expect(haxfordHome()).toBe(home)
    expect(skillsDir()).toBe(path.join(home, "skills"))
    expect(extensionsDir()).toBe(path.join(home, "extensions"))
  })
})

/* -------------------------------------------------------------------------- */
/* System prompt                                                               */
/* -------------------------------------------------------------------------- */

describe("system prompt", () => {
  const entries: SkillSummary[] = [
    { name: "release", description: "Cut a release.", path: "/h/skills/release/SKILL.md" },
    { name: "bare", description: "", path: "/h/skills/bare/SKILL.md" },
  ]

  test("tells the model where its own extension API is documented", () => {
    const prompt = assembleSystemPrompt("/work", undefined, [])
    expect(prompt).toContain("# Extending yourself")
    expect(prompt).toContain(path.join(home, "EXTENDING.md"))
    expect(prompt).toContain("/reload")
  })

  test("lists each skill with its description and path", () => {
    const prompt = assembleSystemPrompt("/work", undefined, entries)
    expect(prompt).toContain("# Skills")
    expect(prompt).toContain("- release — Cut a release.")
    expect(prompt).toContain("  /h/skills/release/SKILL.md")
    // A skill with no description still gets a line, without a dangling dash.
    expect(prompt).toContain("- bare\n  /h/skills/bare/SKILL.md")
  })

  test("the block is omitted entirely when there are no skills", () => {
    expect(assembleSystemPrompt("/work", undefined, [])).not.toContain("# Skills")
  })

  test("the index is advertised, never the bodies", () => {
    const prompt = assembleSystemPrompt("/work", undefined, entries)
    expect(prompt).toContain("read its file with the read tool")
    expect(prompt.length).toBeLessThan(4000)
  })

  test("project instructions still come last", () => {
    const prompt = assembleSystemPrompt("/work", "# AGENTS.md rules", entries)
    expect(prompt.indexOf("# Skills")).toBeLessThan(prompt.indexOf("# AGENTS.md rules"))
    expect(prompt.endsWith("# AGENTS.md rules")).toBe(true)
  })

  test("it defaults to the live skill index, which is what keeps it current", async () => {
    await Bun.write(
      path.join(home, "skills", "live", "SKILL.md"),
      "---\ndescription: loaded at runtime\n---\n",
    )
    expect(assembleSystemPrompt("/work")).not.toContain("loaded at runtime")

    await scanSkills(skillsDir())
    expect(assembleSystemPrompt("/work")).toContain("- live — loaded at runtime")

    clearSkills()
    expect(assembleSystemPrompt("/work")).not.toContain("loaded at runtime")
  })
})
