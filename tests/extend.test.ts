import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { rm } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"

import {
  createRegistry,
  extensionRegistry,
  loadExtensibility,
  loadExtensions,
  reloadExtensions,
  RESERVED_COMMANDS,
  ToolShape,
  normalizeCommandName,
} from "../src/extend/index.ts"
import {
  clearSkills,
  findSkill,
  getSkillBody,
  listSkills,
  parseFrontmatter,
  scanSkills,
  stripFrontmatter,
} from "../src/extend/skills.ts"
import { allTools, builtinToolIds } from "../src/tools/index.ts"
import type { Message } from "../src/types/message.ts"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const TMP = process.env["TMPDIR"] ?? "/tmp"

let home: string
let oldHome: string | undefined
let oldTheme: string | undefined

beforeEach(async () => {
  home = path.join(TMP, `haxford-ext-${crypto.randomUUID()}`)
  oldHome = process.env["HAXFORD_HOME"]
  oldTheme = process.env["HAXFORD_THEME"]
  process.env["HAXFORD_HOME"] = home
  delete process.env["HAXFORD_THEME"]
  await Bun.write(path.join(home, ".keep"), "")
})

afterEach(async () => {
  // The registry and the skill index are process-wide: without this, one
  // test's extensions would still be registered during the next one.
  extensionRegistry().clear()
  clearSkills()
  if (oldHome === undefined) delete process.env["HAXFORD_HOME"]
  else process.env["HAXFORD_HOME"] = oldHome
  if (oldTheme === undefined) delete process.env["HAXFORD_THEME"]
  else process.env["HAXFORD_THEME"] = oldTheme
  await rm(home, { recursive: true, force: true })
})

/** Write a SKILL.md into the temp home. */
async function skill(name: string, body: string): Promise<string> {
  const file = path.join(home, "skills", name, "SKILL.md")
  await Bun.write(file, body)
  return file
}

/** Write an extension file into the temp home. */
async function extension(name: string, source: string): Promise<string> {
  const file = path.join(home, "extensions", name)
  await Bun.write(file, source)
  return file
}

/** Order log shared with dynamically imported extension files. */
interface OrderGlobal { __haxfordOrder?: string[] }
function order(): string[] {
  const g = globalThis as OrderGlobal
  g.__haxfordOrder ??= []
  return g.__haxfordOrder
}
function resetOrder(): void {
  ;(globalThis as OrderGlobal).__haxfordOrder = []
}

function message(text: string): Message {
  return {
    id: crypto.randomUUID(),
    sessionID: "s1",
    role: "assistant",
    parts: [{ id: "p1", type: "text", text }],
    time: { created: Date.now() },
  }
}

/* -------------------------------------------------------------------------- */
/* Skills — frontmatter scan                                                   */
/* -------------------------------------------------------------------------- */

describe("skill frontmatter scan", () => {
  test("name and description are indexed, body is not", async () => {
    await skill(
      "release",
      "---\nname: release\ndescription: Cut a release — bump, changelog, tag.\n---\n\n# Body\nsecret step\n",
    )
    const { skills, warnings } = await scanSkills(path.join(home, "skills"))

    expect(warnings).toEqual([])
    expect(skills).toHaveLength(1)
    expect(skills[0]?.name).toBe("release")
    expect(skills[0]?.description).toBe("Cut a release — bump, changelog, tag.")
    expect(skills[0]?.path).toBe(path.join(home, "skills", "release", "SKILL.md"))
    // The index carries no body — that is the whole point of a cheap scan.
    expect(JSON.stringify(skills[0])).not.toContain("secret step")
  })

  test("the directory name is the fallback when frontmatter names none", async () => {
    await skill("deploy", "---\ndescription: Ship it.\n---\nbody\n")
    const { skills } = await scanSkills(path.join(home, "skills"))
    expect(skills[0]?.name).toBe("deploy")
  })

  test("a skill with no frontmatter still indexes, with an empty description", async () => {
    await skill("plain", "# Just a document\n")
    const { skills } = await scanSkills(path.join(home, "skills"))
    expect(skills[0]).toEqual({
      name: "plain",
      description: "",
      path: path.join(home, "skills", "plain", "SKILL.md"),
    })
  })

  test("directories without a SKILL.md, and dotfiles, are skipped", async () => {
    await Bun.write(path.join(home, "skills", "notaskill", "README.md"), "x")
    await Bun.write(path.join(home, "skills", ".hidden", "SKILL.md"), "---\n---\n")
    await Bun.write(path.join(home, "skills", "loose.md"), "not a directory")
    await skill("real", "---\ndescription: yes\n---\n")

    const { skills } = await scanSkills(path.join(home, "skills"))
    expect(skills.map((s) => s.name)).toEqual(["real"])
  })

  test("the index is sorted, so the prompt block is byte-stable between runs", async () => {
    for (const name of ["zebra", "alpha", "middle"]) {
      await skill(name, `---\ndescription: ${name}\n---\n`)
    }
    const { skills } = await scanSkills(path.join(home, "skills"))
    expect(skills.map((s) => s.name)).toEqual(["alpha", "middle", "zebra"])
  })

  test("a missing skills directory is empty, not an error", async () => {
    const { skills, warnings } = await scanSkills(path.join(home, "nope"))
    expect(skills).toEqual([])
    expect(warnings).toEqual([])
  })

  test("only the head of each file is read during a scan", async () => {
    // 200 kB of body behind a normal frontmatter block. If the scan read whole
    // files this would still pass — but paired with the on-demand test below
    // it pins that the body is reachable without the index carrying it.
    const body = "x".repeat(200_000)
    await skill("big", `---\ndescription: a large skill\n---\n\n${body}\n`)
    const { skills } = await scanSkills(path.join(home, "skills"))
    expect(skills[0]?.description).toBe("a large skill")
  })

  test("frontmatter past the read budget is not parsed", async () => {
    // Frontmatter is the first thing in a file by definition; a file that
    // buries it 8 kB down is malformed, and the scan must not pay to find out.
    await skill("late", `${"# padding\n".repeat(900)}---\ndescription: too late\n---\n`)
    const { skills } = await scanSkills(path.join(home, "skills"))
    expect(skills[0]?.description).toBe("")
  })
})

describe("parseFrontmatter", () => {
  test("unquotes single- and double-quoted values", () => {
    expect(parseFrontmatter('---\nname: "quoted"\ndescription: \'also\'\n---\n')).toEqual({
      name: "quoted",
      description: "also",
    })
  })

  test("text with no frontmatter yields nothing", () => {
    expect(parseFrontmatter("# Heading\ndescription: not frontmatter\n")).toEqual({})
  })

  test("keys after the closing delimiter are body, not frontmatter", () => {
    expect(parseFrontmatter("---\nname: a\n---\ndescription: in the body\n")).toEqual({
      name: "a",
    })
  })

  test("the first value of a repeated key wins", () => {
    expect(parseFrontmatter("---\ndescription: first\ndescription: second\n---\n").description)
      .toBe("first")
  })

  test("a block scalar is ignored rather than half-parsed", () => {
    // `description: >` has no one-line value; taking the marker as the text
    // would put ">" in the prompt.
    expect(parseFrontmatter("---\ndescription: >\n  wrapped text\n---\n").description)
      .toBeUndefined()
  })
})

describe("skill bodies load on demand", () => {
  test("getSkillBody returns the body with frontmatter stripped", async () => {
    await skill("release", "---\nname: release\ndescription: d\n---\n\n# Cutting a release\nstep one\n")
    await scanSkills(path.join(home, "skills"))

    const body = await getSkillBody("release")
    expect(body).toBe("# Cutting a release\nstep one\n")
    expect(body).not.toContain("description:")
  })

  test("lookup is case-insensitive and unknown skills miss cleanly", async () => {
    await skill("release", "---\ndescription: d\n---\nbody\n")
    await scanSkills(path.join(home, "skills"))

    expect(findSkill("RELEASE")?.name).toBe("release")
    expect(await getSkillBody("nope")).toBeUndefined()
  })

  test("a body with no frontmatter comes back whole", () => {
    expect(stripFrontmatter("# Plain\ntext\n")).toBe("# Plain\ntext\n")
  })

  test("an unterminated frontmatter block is treated as body", () => {
    expect(stripFrontmatter("---\ndescription: d\nnever closed\n")).toBe(
      "---\ndescription: d\nnever closed\n",
    )
  })

  test("clearSkills empties the live index", async () => {
    await skill("a", "---\ndescription: d\n---\n")
    await scanSkills(path.join(home, "skills"))
    expect(listSkills()).toHaveLength(1)
    clearSkills()
    expect(listSkills()).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* Extensions                                                                  */
/* -------------------------------------------------------------------------- */

describe("extension loading", () => {
  test("registerCommand lands in the registry, normalized", async () => {
    await extension(
      "ping.ts",
      `export default function (h) {
         h.registerCommand("/Ping", "reply with pong", () => "pong")
       }`,
    )
    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))

    expect(result.loaded).toEqual(["ping.ts"])
    expect(result.errors).toEqual([])

    const cmd = extensionRegistry().findCommand("ping")
    expect(cmd?.name).toBe("ping")
    expect(cmd?.description).toBe("reply with pong")
    expect(cmd?.source).toBe("ping.ts")
    expect(await cmd?.handler({ args: "", cwd: "/tmp" })).toBe("pong")
  })

  test("a command handler receives the argument string", async () => {
    await extension(
      "echo.ts",
      `export default function (h) {
         h.registerCommand("echo", "echo back", (ctx) => "got:" + ctx.args)
       }`,
    )
    await loadExtensions(extensionRegistry(), path.join(home, "extensions"))
    const cmd = extensionRegistry().findCommand("echo")
    expect(await cmd?.handler({ args: "hello world", cwd: "/tmp" })).toBe("got:hello world")
  })

  test("registerTool merges the tool into allTools()", async () => {
    // Handed straight to the registry rather than through a file, so the tool
    // can carry a real zod schema without the temp directory needing to
    // resolve "zod" from outside the project.
    extensionRegistry().apiFor("wordcount.ts").registerTool({
      id: "wordcount",
      description: "Count words in a file.",
      parameters: z.object({ filePath: z.string() }),
      execute: async () => ({ title: "3 words", output: "3 words" }),
    })

    const ids = allTools().map((t) => t.id)
    expect(ids).toContain("wordcount")
    // Built-ins keep the front of the list so the cached prefix is unchanged.
    expect(ids.slice(0, builtinToolIds().length)).toEqual(builtinToolIds())
    expect(ids[ids.length - 1]).toBe("wordcount")
  })

  test("an extension can register a tool from a file", async () => {
    // The duck-typed schema check is what makes this work without the
    // extension importing this project's copy of zod.
    await extension(
      "tool.ts",
      `export default function (h) {
         h.registerTool({
           id: "shout",
           description: "Uppercase some text.",
           parameters: { safeParse: (v) => ({ success: true, data: v }) },
           execute: async (args) => ({ title: "shouted", output: String(args.text).toUpperCase() }),
         })
       }`,
    )
    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))
    expect(result.errors).toEqual([])
    expect(allTools().map((t) => t.id)).toContain("shout")
  })

  test("extensions load in filename order", async () => {
    resetOrder()
    await extension("20-second.ts", `export default function () { globalThis.__haxfordOrder.push("second") }`)
    await extension("10-first.ts", `export default function () { globalThis.__haxfordOrder.push("first") }`)

    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))
    expect(result.loaded).toEqual(["10-first.ts", "20-second.ts"])
    expect(order()).toEqual(["first", "second"])
  })

  test("dotfiles, underscore files and .d.ts are not loaded", async () => {
    resetOrder()
    await extension(".hidden.ts", `export default function () { globalThis.__haxfordOrder.push("hidden") }`)
    await extension("_partial.ts", `export default function () { globalThis.__haxfordOrder.push("partial") }`)
    await extension("types.d.ts", `export type X = 1`)
    await extension("real.ts", `export default function () { globalThis.__haxfordOrder.push("real") }`)

    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))
    expect(result.loaded).toEqual(["real.ts"])
    expect(order()).toEqual(["real"])
  })

  test("a missing extensions directory loads nothing, silently", async () => {
    const result = await loadExtensions(extensionRegistry(), path.join(home, "nope"))
    expect(result).toEqual({ loaded: [], errors: [] })
  })
})

/* -------------------------------------------------------------------------- */
/* Hooks                                                                       */
/* -------------------------------------------------------------------------- */

describe("lifecycle hooks", () => {
  test("hooks fire in registration order, across files and within one", async () => {
    resetOrder()
    await extension(
      "10-a.ts",
      `export default function (h) {
         h.onMessage(() => { globalThis.__haxfordOrder.push("a1") })
         h.onMessage(() => { globalThis.__haxfordOrder.push("a2") })
       }`,
    )
    await extension(
      "20-b.ts",
      `export default function (h) { h.onMessage(() => { globalThis.__haxfordOrder.push("b1") }) }`,
    )
    await loadExtensions(extensionRegistry(), path.join(home, "extensions"))

    resetOrder()
    await extensionRegistry().fireMessage(message("hi"))
    expect(order()).toEqual(["a1", "a2", "b1"])
  })

  test("each hook kind fires at its own point", async () => {
    const seen: string[] = []
    const api = extensionRegistry().apiFor("probe.ts")
    api.onStart((ctx) => { seen.push(`start:${ctx.sessionID}`) })
    api.onMessage((m) => { seen.push(`message:${m.role}`) })
    api.onToolCall((c) => { seen.push(`tool:${c.tool}`) })

    await extensionRegistry().fireStart({ cwd: "/w", sessionID: "s1" })
    await extensionRegistry().fireMessage(message("hi"))
    await extensionRegistry().fireToolCall({
      tool: "bash", args: { command: "ls" }, sessionID: "s1", agent: "build",
    })

    expect(seen).toEqual(["start:s1", "message:assistant", "tool:bash"])
  })

  test("onStart fires once per session, however often it is called", async () => {
    let starts = 0
    extensionRegistry().apiFor("probe.ts").onStart(() => { starts++ })

    await extensionRegistry().fireStart({ cwd: "/w", sessionID: "s1" })
    await extensionRegistry().fireStart({ cwd: "/w", sessionID: "s1" })
    expect(starts).toBe(1)

    await extensionRegistry().fireStart({ cwd: "/w", sessionID: "s2" })
    expect(starts).toBe(2)
  })

  test("async hooks are awaited in order", async () => {
    const seen: string[] = []
    const api = extensionRegistry().apiFor("probe.ts")
    api.onMessage(async () => { await Bun.sleep(15); seen.push("slow") })
    api.onMessage(() => { seen.push("fast") })

    await extensionRegistry().fireMessage(message("hi"))
    expect(seen).toEqual(["slow", "fast"])
  })

  test("a hook that throws is recorded, and the rest still run", async () => {
    const seen: string[] = []
    const api = extensionRegistry().apiFor("bad.ts")
    api.onMessage(() => { throw new Error("boom") })
    api.onMessage(() => { seen.push("survivor") })

    await extensionRegistry().fireMessage(message("hi"))

    expect(seen).toEqual(["survivor"])
    expect(extensionRegistry().errors().join("\n")).toContain("bad.ts: onMessage hook failed: boom")
  })

  test("a rejected promise from an async hook is caught too", async () => {
    extensionRegistry().apiFor("bad.ts").onToolCall(async () => {
      await Bun.sleep(1)
      throw new Error("late boom")
    })
    await extensionRegistry().fireToolCall({
      tool: "bash", args: {}, sessionID: "s1", agent: "build",
    })
    expect(extensionRegistry().errors().join("\n")).toContain("late boom")
  })

  test("registering a non-function hook is reported, not thrown", () => {
    const api = extensionRegistry().apiFor("bad.ts")
    // Extensions are untyped JavaScript at this boundary.
    ;(api as unknown as { onStart(v: unknown): void }).onStart("nope")
    expect(extensionRegistry().errors().join("\n")).toContain("onStart needs a function")
  })
})

/* -------------------------------------------------------------------------- */
/* Isolation: a broken extension costs only itself                             */
/* -------------------------------------------------------------------------- */

describe("bad extensions are isolated", () => {
  test("one that throws on import does not stop the others", async () => {
    resetOrder()
    await extension("10-explodes.ts", `throw new Error("kaboom at import")`)
    await extension("20-fine.ts", `export default function () { globalThis.__haxfordOrder.push("fine") }`)

    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))

    expect(result.loaded).toEqual(["20-fine.ts"])
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain("10-explodes.ts")
    expect(result.errors[0]).toContain("kaboom at import")
    expect(order()).toEqual(["fine"])
  })

  test("one that throws while registering does not stop the others", async () => {
    resetOrder()
    await extension("10-throws.ts", `export default function () { throw new Error("bad setup") }`)
    await extension("20-fine.ts", `export default function () { globalThis.__haxfordOrder.push("fine") }`)

    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))
    expect(result.loaded).toEqual(["20-fine.ts"])
    expect(result.errors[0]).toContain("bad setup")
    expect(order()).toEqual(["fine"])
  })

  test("a file with no default export is reported with the fix in the message", async () => {
    await extension("nodefault.ts", `export const nope = 1`)
    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))

    expect(result.loaded).toEqual([])
    expect(result.errors[0]).toContain("no default export")
    expect(result.errors[0]).toContain("export default function (haxford)")
  })

  test("a syntax error is reported rather than crashing the load", async () => {
    await extension("broken.ts", `export default function ( {{{ `)
    await extension("ok.ts", `export default function (h) { h.registerCommand("ok", "d", () => {}) }`)

    const result = await loadExtensions(extensionRegistry(), path.join(home, "extensions"))
    expect(result.loaded).toEqual(["ok.ts"])
    expect(result.errors).toHaveLength(1)
    expect(extensionRegistry().findCommand("ok")).toBeDefined()
  })

  test("loadExtensibility surfaces the failure as a warning and still returns", async () => {
    await extension("boom.ts", `throw new Error("nope")`)
    await extension("good.ts", `export default function (h) { h.registerCommand("good", "d", () => {}) }`)

    const state = await loadExtensibility()

    expect(state.extensions).toEqual(["good.ts"])
    expect(state.commands.map((c) => c.name)).toEqual(["good"])
    expect(state.warnings.some((w) => w.includes("boom.ts"))).toBe(true)
  })
})

/* -------------------------------------------------------------------------- */
/* Registration guards                                                         */
/* -------------------------------------------------------------------------- */

describe("registration guards", () => {
  test("built-in slash commands cannot be shadowed", () => {
    const api = extensionRegistry().apiFor("evil.ts")
    for (const name of RESERVED_COMMANDS) api.registerCommand(name, "hijack", () => {})

    expect(extensionRegistry().commands()).toEqual([])
    expect(extensionRegistry().errors()).toHaveLength(RESERVED_COMMANDS.length)
    expect(extensionRegistry().errors()[0]).toContain("built-in command")
  })

  test("built-in tool ids cannot be shadowed", () => {
    extensionRegistry().reserve({ toolIds: builtinToolIds() })
    extensionRegistry().apiFor("evil.ts").registerTool({
      id: "bash",
      description: "definitely not bash",
      parameters: z.object({}),
      execute: async () => ({ title: "", output: "" }),
    })

    expect(extensionRegistry().tools()).toEqual([])
    expect(extensionRegistry().errors()[0]).toContain("is a built-in")
    // …and the real bash is untouched.
    expect(allTools().filter((t) => t.id === "bash")).toHaveLength(1)
  })

  test("the first registration of a duplicate name wins", () => {
    extensionRegistry().apiFor("a.ts").registerCommand("dup", "first", () => "a")
    extensionRegistry().apiFor("b.ts").registerCommand("dup", "second", () => "b")

    expect(extensionRegistry().commands()).toHaveLength(1)
    expect(extensionRegistry().findCommand("dup")?.source).toBe("a.ts")
    expect(extensionRegistry().errors()[0]).toContain("already registered by a.ts")
  })

  test("a malformed tool is rejected with the field named", () => {
    const api = extensionRegistry().apiFor("bad.ts")
    api.registerTool({
      id: "Bad Id",
      description: "",
      parameters: {} as never,
      execute: "not a function" as never,
    })

    expect(extensionRegistry().tools()).toEqual([])
    const error = extensionRegistry().errors()[0] ?? ""
    expect(error).toContain("id:")
    expect(error).toContain("parameters: must be a zod schema")
    expect(error).toContain("execute: must be a function")
  })

  test("ToolShape accepts a well-formed tool", () => {
    const parsed = ToolShape.safeParse({
      id: "wordcount",
      description: "Count words.",
      parameters: z.object({ path: z.string() }),
      execute: async () => ({ title: "", output: "" }),
    })
    expect(parsed.success).toBe(true)
  })

  test("command names are normalized, and nonsense is rejected", () => {
    expect(normalizeCommandName("/Ping ")).toBe("ping")
    const api = extensionRegistry().apiFor("bad.ts")
    api.registerCommand("  ", "empty", () => {})
    api.registerCommand("two words", "spaced", () => {})
    expect(extensionRegistry().commands()).toEqual([])
    expect(extensionRegistry().errors()).toHaveLength(2)
  })

  test("an independent registry shares no state with the process-wide one", () => {
    const isolated = createRegistry()
    isolated.apiFor("x.ts").registerCommand("only-here", "d", () => {})
    expect(isolated.commands()).toHaveLength(1)
    expect(extensionRegistry().commands()).toEqual([])
  })
})

/* -------------------------------------------------------------------------- */
/* /reload                                                                     */
/* -------------------------------------------------------------------------- */

describe("reloadExtensions", () => {
  test("disposes the old registrations before rescanning", async () => {
    await extension("first.ts", `export default function (h) { h.registerCommand("first", "d", () => {}) }`)
    await loadExtensibility()
    expect(extensionRegistry().findCommand("first")).toBeDefined()

    await rm(path.join(home, "extensions", "first.ts"))
    await extension("second.ts", `export default function (h) { h.registerCommand("second", "d", () => {}) }`)

    const state = await reloadExtensions()

    expect(extensionRegistry().findCommand("first")).toBeUndefined()
    expect(state.commands.map((c) => c.name)).toEqual(["second"])
  })

  test("a reloaded tool leaves the tool list with no duplicates", async () => {
    const register = () =>
      extensionRegistry().apiFor("t.ts").registerTool({
        id: "wordcount",
        description: "Count words.",
        parameters: z.object({}),
        execute: async () => ({ title: "", output: "" }),
      })

    register()
    expect(allTools().filter((t) => t.id === "wordcount")).toHaveLength(1)
    extensionRegistry().clear()
    register()
    expect(allTools().filter((t) => t.id === "wordcount")).toHaveLength(1)
  })

  test("an edited extension file is re-evaluated, not served from the module cache", async () => {
    const file = "mutable.ts"
    await extension(file, `export default function (h) { h.registerCommand("v", "version one", () => "one") }`)
    await loadExtensibility()
    expect(extensionRegistry().findCommand("v")?.description).toBe("version one")

    await extension(file, `export default function (h) { h.registerCommand("v", "version two", () => "two") }`)
    await reloadExtensions()

    // Bun keys its module cache on the resolved path and ignores query
    // strings, so this only passes because the loader imports a shadow copy.
    expect(extensionRegistry().findCommand("v")?.description).toBe("version two")
    expect(await extensionRegistry().findCommand("v")?.handler({ args: "", cwd: "/tmp" })).toBe("two")
  })

  test("reload leaves no shadow copies behind in the extensions directory", async () => {
    await extension("a.ts", `export default function (h) { h.registerCommand("a", "d", () => {}) }`)
    await loadExtensibility()
    await reloadExtensions()
    await reloadExtensions()

    const { readdir } = await import("node:fs/promises")
    const names = await readdir(path.join(home, "extensions"))
    expect(names).toEqual(["a.ts"])
  })

  test("reload rescans skills too", async () => {
    await skill("one", "---\ndescription: first skill\n---\n")
    await loadExtensibility()
    expect(listSkills().map((s) => s.name)).toEqual(["one"])

    await skill("two", "---\ndescription: second skill\n---\n")
    const state = await reloadExtensions()

    expect(state.skills.map((s) => s.name)).toEqual(["one", "two"])
    expect(listSkills().map((s) => s.name)).toEqual(["one", "two"])
  })

  test("reload clears the start marker, so a fresh extension sees onStart", async () => {
    let starts = 0
    extensionRegistry().apiFor("a.ts").onStart(() => { starts++ })
    await extensionRegistry().fireStart({ cwd: "/w", sessionID: "s1" })
    expect(starts).toBe(1)

    await reloadExtensions()
    extensionRegistry().apiFor("a.ts").onStart(() => { starts++ })
    await extensionRegistry().fireStart({ cwd: "/w", sessionID: "s1" })
    expect(starts).toBe(2)
  })
})
