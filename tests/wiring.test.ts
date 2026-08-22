import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"

import {
  activeThemeName,
  clearSkills,
  DEFAULT_THEME_NAME,
  extensionRegistry,
  extendingDocPath,
  loadExtensibility,
  listSkills,
  reloadExtensions,
  resolvedTheme,
} from "../src/extend/index.ts"
import { assembleSystemPrompt } from "../src/agent/prompt.ts"
import { NO_ARG_COMMANDS, parseSlashCommand } from "../src/tui/app.tsx"
import { COMMANDS } from "../src/tui/components/HelpPanel.tsx"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const TMP = process.env["TMPDIR"] ?? "/tmp"

let home: string
let oldHome: string | undefined
let oldTheme: string | undefined

beforeEach(async () => {
  home = path.join(TMP, `haxford-wiring-${crypto.randomUUID()}`)
  oldHome = process.env["HAXFORD_HOME"]
  oldTheme = process.env["HAXFORD_THEME"]
  process.env["HAXFORD_HOME"] = home
  delete process.env["HAXFORD_THEME"]
  await Bun.write(path.join(home, ".keep"), "")
})

afterEach(async () => {
  // Both are process-wide; without this one test's extensions and skills
  // would leak into the next.
  extensionRegistry().clear()
  clearSkills()
  if (oldHome === undefined) delete process.env["HAXFORD_HOME"]
  else process.env["HAXFORD_HOME"] = oldHome
  if (oldTheme === undefined) delete process.env["HAXFORD_THEME"]
  else process.env["HAXFORD_THEME"] = oldTheme
  await rm(home, { recursive: true, force: true })
})

async function skill(name: string, body: string): Promise<void> {
  await Bun.write(path.join(home, "skills", name, "SKILL.md"), body)
}

async function extension(name: string, source: string): Promise<void> {
  await Bun.write(path.join(home, "extensions", name), source)
}

/* -------------------------------------------------------------------------- */
/* Startup: EXTENDING.md creation and idempotency                              */
/* -------------------------------------------------------------------------- */

describe("startup", () => {
  test("the first load creates EXTENDING.md, the second does not overwrite it", async () => {
    const first = await loadExtensibility()
    expect(first.doc.created).toBe(true)

    // The file is the user's once it exists — edits must survive a restart.
    const doc = path.join(home, "EXTENDING.md")
    expect(await Bun.file(extendingDocPath()).exists()).toBe(true)
    const original = await Bun.file(doc).text()
    await Bun.write(doc, "# my notes\n")

    const second = await loadExtensibility()
    expect(second.doc.created).toBe(false)
    expect(await Bun.file(doc).text()).toBe("# my notes\n")
    expect(original.startsWith("# Extending haxford")).toBe(true)
  })

  test("a second load is idempotent: same skills, no duplicate registrations", async () => {
    await extension("ping.ts", `export default function (h) { h.registerCommand("ping", "d", () => "pong") }`)
    await skill("release", "---\ndescription: cut releases\n---\nbody\n")

    const first = await loadExtensibility()
    const second = await loadExtensibility()

    expect(first.extensions).toEqual(["ping.ts"])
    expect(second.extensions).toEqual(["ping.ts"])
    expect(second.commands.map((c) => c.name)).toEqual(["ping"])
    expect(listSkills().map((s) => s.name)).toEqual(["release"])
    expect(second.warnings).toEqual([])
  })

  test("a failing extension is isolated: reported as strings, others still load", async () => {
    await extension("10-boom.ts", `throw new Error("kaboom")`)
    await extension("20-good.ts", `export default function (h) { h.registerCommand("good", "d", () => "ok") }`)

    const state = await loadExtensibility()

    expect(state.extensions).toEqual(["20-good.ts"])
    expect(extensionRegistry().findCommand("good")).toBeDefined()
    expect(state.warnings.some((w) => w.includes("10-boom.ts") && w.includes("kaboom"))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* /reload counts                                                              */
/* -------------------------------------------------------------------------- */

describe("reload counts", () => {
  test("reports exactly the extensions that loaded after each rescan", async () => {
    await extension("a.ts", `export default function (h) { h.registerCommand("a", "d", () => {}) }`)
    await extension("b.ts", `export default function (h) { h.registerCommand("b", "d", () => {}) }`)

    const first = await reloadExtensions()
    expect(first.extensions).toHaveLength(2)

    await rm(path.join(home, "extensions", "b.ts"))
    const second = await reloadExtensions()
    expect(second.extensions).toEqual(["a.ts"])
    // The disposed command is gone with its file.
    expect(extensionRegistry().findCommand("b")).toBeUndefined()
  })

  test("a reload that breaks an extension still counts the survivors", async () => {
    await extension("ok.ts", `export default function (h) { h.registerCommand("ok", "d", () => {}) }`)
    await reloadExtensions()

    await extension("broken.ts", `export default function ( {{{ `)
    const state = await reloadExtensions()

    expect(state.extensions).toEqual(["ok.ts"])
    expect(state.warnings.some((w) => w.includes("broken.ts"))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* System prompt blocks                                                        */
/* -------------------------------------------------------------------------- */

describe("system prompt", () => {
  test("always documents the extension API at EXTENDING.md", () => {
    const prompt = assembleSystemPrompt("/w")
    expect(prompt).toContain("# Extending yourself")
    expect(prompt).toContain(extendingDocPath())
    expect(prompt).toContain("/reload")
  })

  test("lists loaded skills by name and description", async () => {
    await skill("release", "---\nname: release\ndescription: Cut a release — bump, changelog, tag.\n---\nsecret body\n")
    await loadExtensibility()

    const prompt = assembleSystemPrompt("/w")
    expect(prompt).toContain("# Skills")
    expect(prompt).toContain("- release — Cut a release — bump, changelog, tag.")
    // The index carries paths, not bodies — bodies cost context until read.
    expect(prompt).not.toContain("secret body")
  })

  test("omits the skills block entirely when none exist", async () => {
    await loadExtensibility()
    expect(assembleSystemPrompt("/w")).not.toContain("# Skills")
  })
})

/* -------------------------------------------------------------------------- */
/* Themes                                                                      */
/* -------------------------------------------------------------------------- */

describe("themes", () => {
  test("resolution order: env var beats config field, then the default", () => {
    expect(activeThemeName(undefined)).toBe(DEFAULT_THEME_NAME)
    expect(activeThemeName("violet")).toBe("violet")
    process.env["HAXFORD_THEME"] = "mono"
    expect(activeThemeName("violet")).toBe("mono")
  })

  test("an unknown theme falls back to the built-in with a warning", async () => {
    const state = await loadExtensibility({ themeName: "no-such-theme" })

    expect(resolvedTheme().name).toBe(DEFAULT_THEME_NAME)
    // A complete token map either way: every known token present.
    expect(typeof resolvedTheme().theme.accent).toBe("string")
    expect(state.warnings.some((w) => w.includes("no-such-theme"))).toBe(true)
  })

  test("a theme on disk resolves and lands in resolvedTheme()", async () => {
    await Bun.write(
      path.join(home, "themes", "violet.json"),
      JSON.stringify({ accent: "magenta", notAToken: "red" }),
    )
    const state = await loadExtensibility({ themeName: "violet" })

    expect(resolvedTheme().name).toBe("violet")
    expect(resolvedTheme().theme.accent).toBe("magenta")
    // Unknown tokens warn but do not fail the load.
    expect(state.warnings.some((w) => w.includes("notAToken"))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* The /reload seam                                                            */
/* -------------------------------------------------------------------------- */

describe("/reload dispatch", () => {
  test("parses as a no-argument command", () => {
    expect(parseSlashCommand("/reload", "build")).toEqual({ kind: "reload" })
    expect(parseSlashCommand("/RELOAD", "build")).toEqual({ kind: "reload" })
    expect(NO_ARG_COMMANDS.has("/reload")).toBe(true)
  })

  test("is listed in help so autocomplete offers it", () => {
    expect(COMMANDS.some((c) => c.command === "/reload")).toBe(true)
  })
})
