/**
 * `/skills` and `/agents`: the discoverability listings.
 *
 * These commands exist so a user can answer "what did haxford actually load,
 * and where is the file" without leaving the TUI, so the tests assert what
 * reaches the screen — name, description, source directory, and the empty
 * state that tells a new user where to put their first one.
 */

import { describe, expect, test } from "bun:test"
import React from "react"

import { HaxfordApp, NO_ARG_COMMANDS, parseSlashCommand } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { COMMANDS, HelpPanel, KEYBINDINGS } from "../src/tui/components/HelpPanel.tsx"
import { ListingPanel, type ListingRow } from "../src/tui/components/ListingPanel.tsx"
import { RESERVED_COMMANDS } from "../src/extend/registry.ts"
import { createTuiStore } from "../src/tui/store.ts"
import { renderFixed } from "./helpers/ink.ts"

function flush(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function mount(
  overrides: {
    listSkills?: () => ListingRow[] | Promise<ListingRow[]>
    listAgents?: () => ListingRow[] | Promise<ListingRow[]>
  } = {},
) {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  const inst = renderFixed(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: "mock/demo",
      mode: "build" as const,
      models: ["mock/demo"],
      onPrompt: () => {},
      onAbort: () => {},
      onModelChange: () => {},
      onModeChange: () => {},
      onExit: () => {},
      onNewSession: () => {},
      listSessions: async () => [],
      onResumeSession: () => {},
      ...overrides,
    }),
  )
  return { store, bridge, inst }
}

/** Type a command into the composer and submit it. */
async function run(inst: ReturnType<typeof mount>["inst"], command: string): Promise<void> {
  inst.stdin.write(command)
  await flush()
  inst.stdin.write("\r")
  await flush()
}

/* -------------------------------------------------------------------------- */
/* command table                                                              */
/* -------------------------------------------------------------------------- */

describe("/skills and /agents are registered commands", () => {
  test("both parse to a listing action", () => {
    expect(parseSlashCommand("/skills", "build")).toEqual({
      kind: "listing",
      listing: "skills",
    })
    expect(parseSlashCommand("/agents", "build")).toEqual({
      kind: "listing",
      listing: "agents",
    })
  })

  test("case-insensitive, like every other command", () => {
    expect(parseSlashCommand("/SKILLS", "build")).toEqual({
      kind: "listing",
      listing: "skills",
    })
    expect(parseSlashCommand("  /Agents  ", "build")).toEqual({
      kind: "listing",
      listing: "agents",
    })
  })

  test("both appear in the help table, so /help documents them", () => {
    const names = COMMANDS.map((c) => c.command)
    expect(names).toContain("/skills")
    expect(names).toContain("/agents")
    for (const row of COMMANDS) expect(row.description.length).toBeGreaterThan(0)
  })

  test("both take no argument, so autocomplete submits on accept", () => {
    expect(NO_ARG_COMMANDS.has("/skills")).toBe(true)
    expect(NO_ARG_COMMANDS.has("/agents")).toBe(true)
  })

  test("an extension cannot shadow either one", () => {
    expect(RESERVED_COMMANDS).toContain("skills")
    expect(RESERVED_COMMANDS).toContain("agents")
  })

  test("the help panel still fits 80 columns with the new rows", () => {
    const inst = renderFixed(React.createElement(HelpPanel), { columns: 80 })
    const lines = (inst.lastFrame() ?? "").split("\n")
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(80)
    }
    // Every command row is one line: two section titles plus one per row.
    const filled = lines.filter((l) => l.trim().length > 0)
    expect(filled).toHaveLength(COMMANDS.length + KEYBINDINGS.length + 2)
  })
})

/* -------------------------------------------------------------------------- */
/* ListingPanel rendering                                                     */
/* -------------------------------------------------------------------------- */

describe("ListingPanel", () => {
  test("renders name, description and source for each row", () => {
    const inst = renderFixed(
      React.createElement(ListingPanel, {
        title: "skills",
        rows: [
          { name: "release", description: "Cut a release.", source: "~/.haxford/skills/release" },
          { name: "review", description: "Review a diff.", source: "./.haxford/skills/review" },
        ],
        empty: "none yet",
      }),
    )
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("skills")
    expect(frame).toContain("release")
    expect(frame).toContain("Cut a release.")
    expect(frame).toContain("~/.haxford/skills/release")
    expect(frame).toContain("review")
    expect(frame).toContain("./.haxford/skills/review")
  })

  test("the empty state names where to put the first one", () => {
    const inst = renderFixed(
      React.createElement(ListingPanel, {
        title: "skills",
        rows: [],
        empty: "none yet — see ~/.haxford/EXTENDING.md",
      }),
    )
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("none yet")
    expect(frame).toContain("EXTENDING.md")
  })

  test("a row with no description still reads as a row", () => {
    const inst = renderFixed(
      React.createElement(ListingPanel, {
        title: "agents",
        rows: [{ name: "bare", description: "" }],
        empty: "none",
      }),
    )
    expect(inst.lastFrame() ?? "").toContain("(no description)")
  })

  test("long rows are clipped, never wrapped, at a real 80-column width", () => {
    // Rendered at 80 explicitly: this is the banner-wrap lesson one layer up.
    // A row that silently became two would push the composer off the bottom,
    // because the pin math stands padding down while an overlay is open and
    // cannot measure one.
    const inst = renderFixed(
      React.createElement(ListingPanel, {
        title: "skills",
        rows: [
          {
            name: "verylongskillnamethatkeepsgoing",
            description: "d".repeat(400),
            source: `~/.haxford/skills/${"deep/".repeat(80)}`,
          },
          { name: "short", description: "fine", source: "~/.haxford/skills/short" },
        ],
        empty: "none",
      }),
      { columns: 80 },
    )
    const lines = (inst.lastFrame() ?? "").split("\n")
    for (const line of lines) {
      expect([...line].length).toBeLessThanOrEqual(80)
    }
    // One line for the title, then two per row (name+description, source).
    expect(lines.filter((l) => l.trim().length > 0)).toHaveLength(5)
  })
})

/* -------------------------------------------------------------------------- */
/* end to end through the app                                                 */
/* -------------------------------------------------------------------------- */

describe("/skills end to end", () => {
  test("lists what the host reports, with its source directory", async () => {
    const { inst } = mount({
      listSkills: () => [
        { name: "release", description: "Cut a release.", source: "~/.haxford/skills/release" },
      ],
    })
    await run(inst, "/skills")
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("release")
    expect(frame).toContain("Cut a release.")
    expect(frame).toContain("~/.haxford/skills/release")
  })

  test("an empty index points at EXTENDING.md rather than showing nothing", async () => {
    const { inst } = mount({ listSkills: () => [] })
    await run(inst, "/skills")
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("none yet")
    expect(frame).toContain("EXTENDING.md")
  })

  test("an async host hook is awaited", async () => {
    const { inst } = mount({
      listSkills: async () => {
        await flush(10)
        return [{ name: "later", description: "arrived late", source: "~/.haxford/skills/later" }]
      },
    })
    await run(inst, "/skills")
    await flush(60)
    expect(inst.lastFrame() ?? "").toContain("arrived late")
  })

  test("a host that has not wired it says so instead of crashing", async () => {
    const { inst } = mount({})
    await run(inst, "/skills")
    expect(inst.lastFrame() ?? "").toContain("not wired in this host")
  })

  test("a failing hook reports the failure and closes the overlay", async () => {
    const { inst } = mount({
      listSkills: () => {
        throw new Error("scan exploded")
      },
    })
    await run(inst, "/skills")
    await flush(60)
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("could not list skills")
    expect(frame).toContain("scan exploded")
  })

  test("esc closes the listing", async () => {
    const { inst } = mount({
      listSkills: () => [{ name: "release", description: "Cut a release." }],
    })
    await run(inst, "/skills")
    expect(inst.lastFrame() ?? "").toContain("release")
    inst.stdin.write("")
    await flush()
    expect(inst.lastFrame() ?? "").not.toContain("Cut a release.")
  })
})

describe("/agents end to end", () => {
  test("lists named agents with their description and origin", async () => {
    const { inst } = mount({
      listAgents: () => [
        { name: "reviewer", description: "Read-only reviewer.", source: "~/.haxford/agents (global)" },
        { name: "local", description: "Project one.", source: "./.haxford/agents (project)" },
      ],
    })
    await run(inst, "/agents")
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("reviewer")
    expect(frame).toContain("Read-only reviewer.")
    expect(frame).toContain("(global)")
    expect(frame).toContain("local")
    expect(frame).toContain("(project)")
  })

  test("the empty state points at the agents directory", async () => {
    const { inst } = mount({ listAgents: () => [] })
    await run(inst, "/agents")
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("none yet")
    expect(frame).toContain("agents")
  })

  test("opening one listing replaces the other rather than stacking", async () => {
    const { inst } = mount({
      listSkills: () => [{ name: "skillrow", description: "from skills" }],
      listAgents: () => [{ name: "agentrow", description: "from agents" }],
    })
    await run(inst, "/skills")
    expect(inst.lastFrame() ?? "").toContain("from skills")
    await run(inst, "/agents")
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("from agents")
    expect(frame).not.toContain("from skills")
  })
})
