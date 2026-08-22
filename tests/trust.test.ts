import { afterEach, beforeEach, describe, expect, test } from "bun:test"

import {
  createAskHandler,
  isTrustedAction,
  type TrustConfig,
} from "../src/permission/engine.ts"
import { loadConfig } from "../src/config/index.ts"
import type { PermissionRules } from "../src/types/config.ts"
import type { PermissionRequest } from "../src/types/tool.ts"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const CWD = "/work/proj"

function request(tool: string, args: Record<string, unknown>): PermissionRequest {
  return { tool, args, title: `${tool} ${JSON.stringify(args)}`, sessionID: "s1" }
}

const edit = (filePath: string) => request("edit", { filePath })
const bash = (command: string) => request("bash", { command })

interface Outcome {
  decision: string
  asked: PermissionRequest[]
}

/**
 * Run one request through the handler, recording whether the user was asked.
 * `onAsk` answers "allow" so an escalation is visible as `asked.length === 1`
 * rather than as a different final decision.
 */
async function run(
  req: PermissionRequest,
  opts: {
    mode?: "build" | "auto" | "plan"
    trust?: TrustConfig
    rules?: PermissionRules
  } = {},
): Promise<Outcome> {
  const asked: PermissionRequest[] = []
  const handler = createAskHandler({
    mode: opts.mode ?? "auto",
    ...(opts.trust !== undefined ? { trust: opts.trust } : {}),
    ...(opts.rules !== undefined ? { rules: opts.rules } : {}),
    cwd: CWD,
    onAsk: (r) => {
      asked.push(r)
      return "allow"
    },
  })
  return { decision: await handler(req), asked }
}

const TRUST: TrustConfig = {
  paths: ["src/**", "docs/*.md"],
  commands: ["bun test", "git status"],
}

/* -------------------------------------------------------------------------- */
/* Trusted actions run unattended                                              */
/* -------------------------------------------------------------------------- */

describe("scoped trust in auto mode", () => {
  test("an edit under a trusted glob is allowed without asking", async () => {
    const { decision, asked } = await run(edit("src/agent/loop.ts"), {
      trust: TRUST,
    })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(0)
  })

  test("an absolute path inside the project matches a relative trust glob", async () => {
    const { decision, asked } = await run(edit(`${CWD}/src/tui/app.tsx`), {
      trust: TRUST,
    })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(0)
  })

  test("an edit outside the trusted globs escalates to ask", async () => {
    const { decision, asked } = await run(edit("scripts/deploy.sh"), {
      trust: TRUST,
    })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(1)
    expect(asked[0]?.tool).toBe("edit")
  })

  test("a sibling path that only shares a prefix is not trusted", async () => {
    const { asked } = await run(edit("src-generated/x.ts"), { trust: TRUST })
    expect(asked).toHaveLength(1)
  })

  test("a segment glob does not reach into a subdirectory", async () => {
    const { asked } = await run(edit("docs/api/spec.md"), { trust: TRUST })
    expect(asked).toHaveLength(1)
  })

  test("a bash command with a trusted prefix is allowed without asking", async () => {
    const { decision, asked } = await run(bash("bun test tests/trust.test.ts"), {
      trust: TRUST,
    })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(0)
  })

  test("a prefix has to end on a word boundary", async () => {
    const { asked } = await run(bash("bun testify --all"), { trust: TRUST })
    expect(asked).toHaveLength(1)
  })

  test("an untrusted bash command escalates to ask", async () => {
    const { decision, asked } = await run(bash("rm -rf build"), { trust: TRUST })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(1)
    expect(asked[0]?.tool).toBe("bash")
  })

  test("every command in a chain has to be trusted", async () => {
    const { asked } = await run(bash("git status && rm -rf /"), { trust: TRUST })
    expect(asked).toHaveLength(1)
  })

  test("a wrapped trusted command is still trusted", async () => {
    const { asked } = await run(bash("timeout 120 bun test"), { trust: TRUST })
    expect(asked).toHaveLength(0)
  })

  test("read-only tool defaults still allow without asking", async () => {
    const { decision, asked } = await run(request("read", { filePath: "/etc/hosts" }), {
      trust: TRUST,
    })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(0)
  })

  test("an explicit allow rule outside the scope still allows", async () => {
    const { decision, asked } = await run(edit("scripts/deploy.sh"), {
      trust: TRUST,
      rules: { edit: { "scripts/**": "allow" } },
    })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(0)
  })

  /* ------------------------------------------------------------------------ */
  /* Deny always wins                                                          */
  /* ------------------------------------------------------------------------ */

  test("an explicit deny beats a trusted path", async () => {
    const { decision, asked } = await run(edit("src/secrets.ts"), {
      trust: TRUST,
      rules: { edit: { "src/secrets.ts": "deny" } },
    })
    expect(decision).toBe("deny")
    expect(asked).toHaveLength(0)
  })

  test("an explicit deny beats a trusted command prefix", async () => {
    const { decision, asked } = await run(bash("bun test --coverage"), {
      trust: TRUST,
      rules: { bash: { "bun test *": "deny" } },
    })
    expect(decision).toBe("deny")
    expect(asked).toHaveLength(0)
  })

  test("a deny on one link of a trusted chain denies the chain", async () => {
    const { decision } = await run(bash("bun test && git status"), {
      trust: TRUST,
      rules: { bash: { "git status": "deny" } },
    })
    expect(decision).toBe("deny")
  })

  /* ------------------------------------------------------------------------ */
  /* Absent trust config: today's behaviour, exactly                           */
  /* ------------------------------------------------------------------------ */

  test("auto mode with no trust config allows everything undenied", async () => {
    for (const req of [edit("anywhere/at/all.ts"), bash("rm -rf build")]) {
      const { decision, asked } = await run(req)
      expect(decision).toBe("allow")
      expect(asked).toHaveLength(0)
    }
  })

  test("auto mode with an empty trust block is still unscoped", async () => {
    const { decision, asked } = await run(bash("rm -rf build"), { trust: {} })
    expect(decision).toBe("allow")
    expect(asked).toHaveLength(0)
  })

  test("auto mode with no trust config still honours an explicit deny", async () => {
    const { decision } = await run(bash("rm -rf build"), {
      rules: { bash: { "rm *": "deny" } },
    })
    expect(decision).toBe("deny")
  })

  test("trust does not loosen build mode", async () => {
    const { asked } = await run(edit("src/agent/loop.ts"), {
      mode: "build",
      trust: TRUST,
    })
    expect(asked).toHaveLength(1)
  })

  test("trust does not loosen plan mode", async () => {
    const { decision, asked } = await run(edit("src/agent/loop.ts"), {
      mode: "plan",
      trust: TRUST,
    })
    expect(decision).toBe("deny")
    expect(asked).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* isTrustedAction                                                             */
/* -------------------------------------------------------------------------- */

describe("isTrustedAction", () => {
  test("an absent or empty scope trusts nothing", () => {
    expect(isTrustedAction(undefined, "edit", "src/a.ts", CWD)).toBe(false)
    expect(isTrustedAction({}, "edit", "src/a.ts", CWD)).toBe(false)
    expect(isTrustedAction({ paths: [] }, "edit", "src/a.ts", CWD)).toBe(false)
  })

  test("a paths-only scope does not trust commands, and vice versa", () => {
    expect(isTrustedAction({ paths: ["**"] }, "bash", "ls", CWD)).toBe(false)
    expect(isTrustedAction({ commands: ["ls"] }, "edit", "src/a.ts", CWD)).toBe(
      false,
    )
  })

  test("a trailing slash trusts everything beneath a directory", () => {
    expect(isTrustedAction({ paths: ["src/"] }, "edit", "src/a/b.ts", CWD)).toBe(
      true,
    )
  })

  test("a wildcard command prefix uses the rule glob matcher", () => {
    const trust: TrustConfig = { commands: ["npm run test:*"] }
    expect(isTrustedAction(trust, "bash", "npm run test:unit", CWD)).toBe(true)
    expect(isTrustedAction(trust, "bash", "npm run build", CWD)).toBe(false)
  })

  test("a tool with no subject is never trusted", () => {
    expect(isTrustedAction(TRUST, "task", "", CWD)).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Config loading                                                              */
/* -------------------------------------------------------------------------- */

describe("permission.trust in config", () => {
  // The real ~/.config/haxford/haxford.json is a lower-precedence layer and
  // would leak its own trust block into these assertions.
  let oldXdg: string | undefined
  beforeEach(async () => {
    oldXdg = process.env["XDG_CONFIG_HOME"]
    const empty = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-trust-xdg-${crypto.randomUUID()}`
    await Bun.write(`${empty}/.keep`, "")
    process.env["XDG_CONFIG_HOME"] = empty
  })
  afterEach(() => {
    if (oldXdg === undefined) delete process.env["XDG_CONFIG_HOME"]
    else process.env["XDG_CONFIG_HOME"] = oldXdg
  })

  async function project(files: Record<string, unknown>): Promise<string> {
    const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-trust-${crypto.randomUUID()}`
    for (const [name, body] of Object.entries(files)) {
      await Bun.write(`${dir}/${name}`, JSON.stringify(body, null, 2))
    }
    await Bun.write(`${dir}/.keep`, "")
    return dir
  }

  test("a trust block is parsed out of permission", async () => {
    const dir = await project({
      "haxford.json": {
        permission: {
          bash: { "git *": "allow" },
          trust: { paths: ["src/**"], commands: ["bun test"] },
        },
      },
    })
    const loaded = await loadConfig(dir)

    expect(loaded.trust).toEqual({ paths: ["src/**"], commands: ["bun test"] })
    // …and never reaches the rule engine as a tool called "trust".
    expect(loaded.config.permission).not.toHaveProperty("trust")
    expect(loaded.config.permission?.["bash"]).toEqual({ "git *": "allow" })
  })

  test("no trust block leaves trust undefined", async () => {
    const dir = await project({
      "haxford.json": { permission: { bash: { "git *": "allow" } } },
    })
    expect((await loadConfig(dir)).trust).toBeUndefined()
  })

  test("project and local scopes are additive", async () => {
    const dir = await project({
      "haxford.json": { permission: { trust: { paths: ["src/**"] } } },
      ".haxford/settings.local.json": {
        permission: { trust: { paths: ["src/**", "docs/**"], commands: ["ls"] } },
      },
    })
    const loaded = await loadConfig(dir)

    expect(loaded.trust?.paths).toEqual(["src/**", "docs/**"])
    expect(loaded.trust?.commands).toEqual(["ls"])
  })

  test("malformed trust entries are dropped, not trusted", async () => {
    const dir = await project({
      "haxford.json": {
        permission: {
          trust: { paths: ["src/**", 42, "", "  "], commands: "bun test" },
        },
      },
    })
    const loaded = await loadConfig(dir)

    expect(loaded.trust).toEqual({ paths: ["src/**"] })
  })

  test("a trust block that scopes nothing is treated as absent", async () => {
    const dir = await project({
      "haxford.json": { permission: { trust: { paths: [] } } },
    })
    expect((await loadConfig(dir)).trust).toBeUndefined()
  })
})
