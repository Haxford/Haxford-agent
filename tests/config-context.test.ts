/**
 * Standing context autoload: `~/.haxford/init.md`, `AGENTS.md`,
 * `.haxfordcontext`.
 *
 * The three answer different questions — how the user works everywhere, what
 * this repository's contract is, and what is going on in this checkout right
 * now — so all three load, in that order, and any of them may be absent.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, writeFile, mkdir, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { loadConfig } from "../src/config/index.ts"
import { HOME_ENV, initContextPath } from "../src/extend/paths.ts"

const INIT = "Global: always prefer small diffs."
const AGENTS = "Project: run bun test before claiming done."
const LOCAL = "Local: we are mid-refactor on the parser."

const savedHome = process.env[HOME_ENV]
afterEach(() => {
  if (savedHome === undefined) delete process.env[HOME_ENV]
  else process.env[HOME_ENV] = savedHome
})

async function tmp(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "haxford-ctx-"))
}

/** Point HAXFORD_HOME at an empty dir so a real ~/.haxford/init.md cannot leak in. */
async function isolatedHome(): Promise<string> {
  const home = await tmp()
  process.env[HOME_ENV] = home
  return home
}

/** Write ~/.haxford/init.md under the isolated home. */
async function writeInit(text: string): Promise<void> {
  const file = initContextPath()
  await mkdir(join(file, ".."), { recursive: true })
  await writeFile(file, text)
}

describe("standing context: each source alone", () => {
  test("only ~/.haxford/init.md", async () => {
    await isolatedHome()
    await writeInit(INIT)
    const { projectInstructions } = await loadConfig(await tmp())
    expect(projectInstructions).toBe(INIT)
  })

  test("only AGENTS.md", async () => {
    await isolatedHome()
    const cwd = await tmp()
    await writeFile(join(cwd, "AGENTS.md"), AGENTS)
    const { projectInstructions } = await loadConfig(cwd)
    expect(projectInstructions).toBe(AGENTS)
  })

  test("only .haxfordcontext", async () => {
    await isolatedHome()
    const cwd = await tmp()
    await writeFile(join(cwd, ".haxfordcontext"), LOCAL)
    const { projectInstructions } = await loadConfig(cwd)
    expect(projectInstructions).toBe(LOCAL)
  })
})

describe("standing context: composition", () => {
  test("all three join in order, general to specific, separated by a blank line", async () => {
    await isolatedHome()
    await writeInit(INIT)
    const cwd = await tmp()
    await writeFile(join(cwd, "AGENTS.md"), AGENTS)
    await writeFile(join(cwd, ".haxfordcontext"), LOCAL)

    const { projectInstructions } = await loadConfig(cwd)
    expect(projectInstructions).toBe(`${INIT}\n\n${AGENTS}\n\n${LOCAL}`)
  })

  test("a missing middle source closes the gap rather than leaving a hole", async () => {
    await isolatedHome()
    await writeInit(INIT)
    const cwd = await tmp()
    await writeFile(join(cwd, ".haxfordcontext"), LOCAL)

    const { projectInstructions } = await loadConfig(cwd)
    expect(projectInstructions).toBe(`${INIT}\n\n${LOCAL}`)
    expect(projectInstructions).not.toContain("\n\n\n")
  })

  test("stray whitespace does not push the next section down the prompt", async () => {
    await isolatedHome()
    await writeInit(`\n\n${INIT}\n\n\n`)
    const cwd = await tmp()
    await writeFile(join(cwd, "AGENTS.md"), `${AGENTS}\n\n\n\n`)

    const { projectInstructions } = await loadConfig(cwd)
    expect(projectInstructions).toBe(`${INIT}\n\n${AGENTS}`)
  })

  test("none present yields undefined, not an empty string", async () => {
    await isolatedHome()
    const { projectInstructions } = await loadConfig(await tmp())
    expect(projectInstructions).toBeUndefined()
  })

  test("an empty or whitespace-only file counts as absent", async () => {
    await isolatedHome()
    const cwd = await tmp()
    await writeFile(join(cwd, "AGENTS.md"), "   \n\n  \n")
    await writeFile(join(cwd, ".haxfordcontext"), LOCAL)
    const { projectInstructions } = await loadConfig(cwd)
    expect(projectInstructions).toBe(LOCAL)
  })
})

describe("standing context: an unreadable source never fails the load", () => {
  test("a directory where a context file was expected is skipped", async () => {
    await isolatedHome()
    const cwd = await tmp()
    // A directory named AGENTS.md: exists, but reading it as text cannot work.
    await mkdir(join(cwd, "AGENTS.md"), { recursive: true })
    await writeFile(join(cwd, ".haxfordcontext"), LOCAL)

    const loaded = await loadConfig(cwd)
    expect(loaded.projectInstructions).toBe(LOCAL)
    // The rest of the config still loaded normally.
    expect(loaded.warnings).toEqual([])
  })

  test("a mode-000 context file is skipped, and the others still load", async () => {
    await isolatedHome()
    const cwd = await tmp()
    const denied = join(cwd, ".haxfordcontext")
    await writeFile(denied, LOCAL)
    await chmod(denied, 0o000)
    await writeFile(join(cwd, "AGENTS.md"), AGENTS)

    try {
      const { projectInstructions } = await loadConfig(cwd)
      // Running as root defeats the permission bit; accept either outcome
      // rather than asserting something the environment controls.
      expect(
        projectInstructions === AGENTS ||
          projectInstructions === `${AGENTS}\n\n${LOCAL}`,
      ).toBe(true)
    } finally {
      await chmod(denied, 0o600)
    }
  })
})
