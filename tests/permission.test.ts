import { describe, expect, test } from "bun:test"

import type {
  PermissionAction,
  PermissionRules,
} from "../src/types/config.ts"
import type {
  PermissionDecision,
  PermissionRequest,
} from "../src/types/tool.ts"

/**
 * NOTE: src/permission/ is owned by another agent and built IN PARALLEL.
 * These tests encode the contract described in the Phase 3b task. If the
 * parallel implementation deviates, failures here are the signal — do NOT
 * edit src/permission/ from this side; report the deviations.
 *
 * Expected public surface (from the task spec):
 *
 *   evaluatePermission(rules, tool, subject) => "allow" | "ask" | "deny"
 *     - tool defaults: read/glob/grep/todoread/todowrite allow; write/edit/bash ask
 *     - pattern records with * and ** globs; longest matching pattern wins
 *     - a bare PermissionAction (not a pattern record) beats patterns
 *
 *   createAskHandler({ rules, mode, onAsk })
 *     - mode "auto": allows anything not denied (no onAsk call)
 *     - mode "plan": denies write/edit/bash WITHOUT calling onAsk
 *     - mode "build": calls onAsk on "ask"; "always" is remembered per
 *       tool+matched-pattern; "deny" never remembered
 *     - returns (req: PermissionRequest) => Promise<PermissionDecision>
 */
import {
  createAskHandler,
  evaluatePermission,
  isReadOnlyChain,
  persistAlwaysRule,
  splitCommand,
  stripWrappers,
  suggestPatterns,
  LOCAL_SETTINGS_FILE,
} from "../src/permission/index.ts"
import { loadConfig } from "../src/config/index.ts"

function req(tool: string, subject: string, title = subject): PermissionRequest {
  // Subject is tool-specific: bash -> command string; read/write/edit -> path.
  const args: Record<string, unknown> =
    tool === "bash" ? { command: subject } : { path: subject }
  return { tool, title, args, sessionID: "s" }
}

/** Build a counting onAsk that returns the given decision. */
function countingAsk(
  decision: PermissionDecision,
  counter: { n: number },
): (r: PermissionRequest) => Promise<PermissionDecision> {
  return async (_r: PermissionRequest): Promise<PermissionDecision> => {
    counter.n++
    return decision
  }
}

describe("evaluatePermission — tool defaults", () => {
  const rules: PermissionRules = {}

  test("read defaults to allow", () => {
    expect(evaluatePermission(rules, "read", "/any/path")).toBe("allow")
  })
  test("glob defaults to allow", () => {
    expect(evaluatePermission(rules, "glob", "**/*.ts")).toBe("allow")
  })
  test("grep defaults to allow", () => {
    expect(evaluatePermission(rules, "grep", "needle")).toBe("allow")
  })
  test("todoread defaults to allow", () => {
    expect(evaluatePermission(rules, "todoread", "x")).toBe("allow")
  })
  test("todowrite defaults to allow", () => {
    expect(evaluatePermission(rules, "todowrite", "x")).toBe("allow")
  })

  test("write defaults to ask", () => {
    expect(evaluatePermission(rules, "write", "/any/path")).toBe("ask")
  })
  test("edit defaults to ask", () => {
    expect(evaluatePermission(rules, "edit", "/any/path")).toBe("ask")
  })
  test("bash defaults to ask", () => {
    expect(evaluatePermission(rules, "bash", "ls -la")).toBe("ask")
  })
})

describe("evaluatePermission — bare action beats patterns", () => {
  test("bare allow overrides a deny pattern", () => {
    const rules: PermissionRules = { bash: "allow" }
    expect(evaluatePermission(rules, "bash", "rm -rf home")).toBe("allow")
  })

  test("bare deny overrides an allow pattern", () => {
    const rules: PermissionRules = { read: "deny" }
    expect(evaluatePermission(rules, "read", "src/x.ts")).toBe("deny")
  })
})

describe("evaluatePermission — pattern matching", () => {
  test("matching allow pattern returns allow", () => {
    const rules: PermissionRules = { bash: { "ls *": "allow" } }
    expect(evaluatePermission(rules, "bash", "ls -la")).toBe("allow")
  })

  test("non-matching pattern falls through to default (bash -> ask)", () => {
    const rules: PermissionRules = { bash: { "git *": "allow" } }
    expect(evaluatePermission(rules, "bash", "rm -rf home")).toBe("ask")
  })

  test("single * matches one path segment (no slashes)", () => {
    const rules: PermissionRules = { read: { "src/*.ts": "deny" } }
    expect(evaluatePermission(rules, "read", "src/foo.ts")).toBe("deny")
    // * does not cross slashes
    expect(evaluatePermission(rules, "read", "src/a/foo.ts")).not.toBe("deny")
  })

  test("** matches across path separators", () => {
    const rules: PermissionRules = { read: { "src/**": "deny" } }
    expect(evaluatePermission(rules, "read", "src/a/b/c.ts")).toBe("deny")
    expect(evaluatePermission(rules, "read", "src/foo.ts")).toBe("deny")
  })

  test("longest matching pattern wins", () => {
    const rules: PermissionRules = {
      read: {
        "src/**": "allow",
        "src/secrets/**": "deny",
        "src/secrets/key.pem": "allow", // most specific
      },
    }
    expect(evaluatePermission(rules, "read", "src/secrets/key.pem")).toBe("allow")
    expect(evaluatePermission(rules, "read", "src/secrets/other.pem")).toBe("deny")
    expect(evaluatePermission(rules, "read", "src/app/main.ts")).toBe("allow")
  })

  test("deny pattern beats shorter allow pattern", () => {
    const rules: PermissionRules = {
      bash: { "rm *": "deny", "*": "allow" },
    }
    expect(evaluatePermission(rules, "bash", "rm -rf home")).toBe("deny")
    expect(evaluatePermission(rules, "bash", "ls -la")).toBe("allow")
  })
})

describe("createAskHandler — auto mode", () => {
  test("auto allows non-denied tools without calling onAsk", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: {},
      mode: "auto",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("bash", "ls -la"))).toBe("allow")
    expect(await handler(req("write", "/tmp/x"))).toBe("allow")
    expect(c.n).toBe(0)
  })

  test("auto still respects explicit deny", async () => {
    const handler = createAskHandler({
      rules: { bash: { "rm *": "deny" } },
      mode: "auto",
      onAsk: countingAsk("allow", { n: 0 }),
    })
    expect(await handler(req("bash", "rm -rf home"))).toBe("deny")
  })
})

describe("createAskHandler — plan mode", () => {
  test("plan denies write/edit/bash WITHOUT calling onAsk", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: {},
      mode: "plan",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("write", "/x"))).toBe("deny")
    expect(await handler(req("edit", "/x"))).toBe("deny")
    expect(await handler(req("bash", "ls"))).toBe("allow")
    expect(c.n).toBe(0)
  })

  test("plan allows read-only tools without asking", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: {},
      mode: "plan",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("read", "/x"))).toBe("allow")
    expect(await handler(req("grep", "x"))).toBe("allow")
    expect(c.n).toBe(0)
  })

  test("plan denies explicit-deny tools too", async () => {
    const handler = createAskHandler({
      rules: { read: { "/etc/**": "deny" } },
      mode: "plan",
      onAsk: countingAsk("allow", { n: 0 }),
    })
    expect(await handler(req("read", "/etc/passwd"))).toBe("deny")
  })
})

describe("createAskHandler — build mode", () => {
  test("build calls onAsk on ask and returns its decision", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: {},
      mode: "build",
      onAsk: countingAsk("allow", c),
    })
    // A command that can change the workspace always reaches the prompt;
    // `ls -la` would not, because build mode auto-allows read-only chains.
    expect(await handler(req("bash", "npm install"))).toBe("allow")
    expect(c.n).toBe(1)
  })

  test("build does not call onAsk for allow/deny rules", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "ls *": "allow", "rm *": "deny" } },
      mode: "build",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("bash", "ls -la"))).toBe("allow")
    expect(await handler(req("bash", "rm -rf home"))).toBe("deny")
    expect(c.n).toBe(0)
  })

  test("build: 'always' is remembered per tool+matched-pattern", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "git *": "ask" } },
      mode: "build",
      onAsk: countingAsk("always", c),
    })
    // First git command asks and is remembered as always for the "git *" pattern.
    expect(await handler(req("bash", "git status"))).toBe("always")
    expect(c.n).toBe(1)
    // Second git command matching the same pattern does NOT ask.
    expect(await handler(req("bash", "git diff"))).toBe("always")
    expect(c.n).toBe(1)
  })

  test("build: 'always' for one pattern does not cover a different pattern", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "git *": "ask", "npm *": "ask" } },
      mode: "build",
      onAsk: countingAsk("always", c),
    })
    expect(await handler(req("bash", "git status"))).toBe("always")
    expect(await handler(req("bash", "npm install"))).toBe("always")
    expect(c.n).toBe(2)
  })

  test("build: 'deny' from onAsk is NOT remembered (asks again next time)", async () => {
    const c = { n: 0 }
    const decisions: PermissionDecision[] = ["deny", "allow"]
    const handler = createAskHandler({
      rules: { bash: { "git *": "ask" } },
      mode: "build",
      onAsk: async (): Promise<PermissionDecision> => {
        const d = decisions[c.n] ?? "allow"
        c.n++
        return d
      },
    })
    expect(await handler(req("bash", "git status"))).toBe("deny")
    expect(await handler(req("bash", "git status"))).toBe("allow")
    expect(c.n).toBe(2)
  })

  test("build: 'allow' (once) is NOT remembered", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "git *": "ask" } },
      mode: "build",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("bash", "git status"))).toBe("allow")
    expect(await handler(req("bash", "git status"))).toBe("allow")
    expect(c.n).toBe(2) // asked both times; allow is per-action
  })
})

describe("createAskHandler — rule precedence end-to-end", () => {
  test("explicit allow rule short-circuits before onAsk", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "ls *": "allow" } },
      mode: "build",
      onAsk: countingAsk("deny", c),
    })
    expect(await handler(req("bash", "ls -la"))).toBe("allow")
    expect(c.n).toBe(0)
  })

  test("explicit deny rule short-circuits before onAsk", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "rm *": "deny" } },
      mode: "build",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("bash", "rm -rf home"))).toBe("deny")
    expect(c.n).toBe(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Shell command decomposition                                                 */
/* -------------------------------------------------------------------------- */

describe("splitCommand", () => {
  test("splits on every operator that can start a new command", () => {
    expect(splitCommand("a && b")).toEqual(["a", "b"])
    expect(splitCommand("a || b")).toEqual(["a", "b"])
    expect(splitCommand("a ; b")).toEqual(["a", "b"])
    expect(splitCommand("a | b")).toEqual(["a", "b"])
    expect(splitCommand("a |& b")).toEqual(["a", "b"])
    expect(splitCommand("a & b")).toEqual(["a", "b"])
    expect(splitCommand("a\nb")).toEqual(["a", "b"])
  })

  test("splits grouping and substitution forms", () => {
    expect(splitCommand("(rm -rf /)")).toEqual(["rm -rf /"])
    expect(splitCommand("echo `rm x`")).toEqual(["echo", "rm x"])
    expect(splitCommand("echo $(rm x)")).toEqual(["echo $", "rm x"])
  })

  test("never splits inside quotes", () => {
    expect(splitCommand('echo "a && b"')).toEqual(['echo "a && b"'])
    expect(splitCommand("echo 'a | b'")).toEqual(["echo 'a | b'"])
  })

  test("does not treat redirection as a boundary", () => {
    expect(splitCommand("ls > out.txt")).toEqual(["ls > out.txt"])
  })

  test("an escaped operator is literal text", () => {
    expect(splitCommand("ls \\; rm x")).toEqual(["ls \\; rm x"])
  })

  test("a simple command is returned unchanged, never an empty list", () => {
    expect(splitCommand("ls -la")).toEqual(["ls -la"])
    expect(splitCommand("&&")).toEqual(["&&"])
  })
})

describe("stripWrappers", () => {
  test("strips wrappers that run their argument", () => {
    expect(stripWrappers("timeout 30 npm test")).toBe("npm test")
    expect(stripWrappers("nice -n 10 npm test")).toBe("npm test")
    expect(stripWrappers("nohup npm test")).toBe("npm test")
    expect(stripWrappers("time npm test")).toBe("npm test")
  })

  test("strips leading environment assignments", () => {
    expect(stripWrappers("NODE_ENV=test npm test")).toBe("npm test")
    expect(stripWrappers("A=1 B=2 npm test")).toBe("npm test")
  })

  test("strips the running form of command/builtin/xargs but not the query form", () => {
    expect(stripWrappers("command npm test")).toBe("npm test")
    expect(stripWrappers("xargs grep pattern")).toBe("grep pattern")
    // `command -v` looks a name up; `xargs -n1` is its own configured command.
    expect(stripWrappers("command -v npm")).toBe("command -v npm")
    expect(stripWrappers("xargs -n1 grep pattern")).toBe("xargs -n1 grep pattern")
  })

  test("does NOT strip environment runners that resolve their own command", () => {
    for (const command of [
      "npx tsc",
      "docker exec c rm -rf /",
      "mise exec -- npm test",
      "devbox run rm -rf .",
    ]) {
      expect(stripWrappers(command)).toBe(command)
    }
  })

  test("leaves a bare wrapper alone rather than emptying the command", () => {
    expect(stripWrappers("timeout")).toBe("timeout")
  })
})

describe("isReadOnlyChain", () => {
  test("a pipeline of read-only commands is read-only", () => {
    expect(isReadOnlyChain("ls | grep foo")).toBe(true)
    expect(isReadOnlyChain("cat a.ts | head -20")).toBe(true)
  })

  test("one writing command taints the whole chain", () => {
    expect(isReadOnlyChain("ls | xargs rm")).toBe(false)
    expect(isReadOnlyChain("git status && rm -rf /")).toBe(false)
    expect(isReadOnlyChain("ls > out.txt")).toBe(false)
  })
})

/* -------------------------------------------------------------------------- */
/* Compound-command bypass (the reason splitting exists)                       */
/* -------------------------------------------------------------------------- */

describe("compound commands cannot ride a rule written for one part", () => {
  const rules: PermissionRules = { bash: { "git status *": "allow" } }

  test("an allow rule for the first part does not allow the whole chain", () => {
    // Before splitting, the flat glob in `git status *` matched the entire
    // string "git status && rm -rf /" and returned allow.
    expect(evaluatePermission(rules, "bash", "git status && rm -rf /")).not.toBe(
      "allow",
    )
    expect(evaluatePermission(rules, "bash", "git status && rm -rf /")).toBe("ask")
  })

  test("the uncovered part forces a prompt instead of running silently", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules,
      mode: "build",
      onAsk: countingAsk("deny", c),
    })
    expect(await handler(req("bash", "git status && rm -rf /"))).toBe("deny")
    expect(c.n).toBe(1)
  })

  test("an explicit deny on any part denies the chain without asking", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "git *": "allow", "rm *": "deny" } },
      mode: "build",
      onAsk: countingAsk("allow", c),
    })
    expect(await handler(req("bash", "git status && rm -rf /"))).toBe("deny")
    expect(c.n).toBe(0)
  })

  test("a chain every part of which is allowed still runs unprompted", async () => {
    const c = { n: 0 }
    const handler = createAskHandler({
      rules: { bash: { "git *": "allow", "npm *": "allow" } },
      mode: "build",
      onAsk: countingAsk("deny", c),
    })
    expect(await handler(req("bash", "git status && npm test"))).toBe("allow")
    expect(c.n).toBe(0)
  })

  test("rules match past a wrapper and an env assignment", () => {
    const wrapped: PermissionRules = { bash: { "npm test *": "allow" } }
    expect(evaluatePermission(wrapped, "bash", "timeout 30 npm test --ci")).toBe(
      "allow",
    )
    expect(evaluatePermission(wrapped, "bash", "NODE_ENV=test npm test --ci")).toBe(
      "allow",
    )
    // …but not past a runner that resolves its own command.
    expect(evaluatePermission(wrapped, "bash", "devbox run npm test --ci")).toBe(
      "ask",
    )
  })

  test("plan mode denies a chain whose tail can write", async () => {
    const handler = createAskHandler({ mode: "plan", onAsk: () => "allow" })
    expect(await handler(req("bash", "ls | grep foo"))).toBe("allow")
    expect(await handler(req("bash", "git status && rm -rf /"))).toBe("deny")
  })
})

/* -------------------------------------------------------------------------- */
/* Build-mode read-only short-circuit                                          */
/* -------------------------------------------------------------------------- */

describe("build mode does not prompt for commands that cannot change anything", () => {
  const handler = (onAsk: (r: PermissionRequest) => PermissionDecision) =>
    createAskHandler({ rules: {}, mode: "build", onAsk })

  test("read-only commands and pipelines run unprompted", async () => {
    const c = { n: 0 }
    const h = handler(() => {
      c.n++
      return "deny"
    })
    for (const command of ["ls -la", "git status", "rg TODO src", "ls | grep foo"]) {
      expect(await h(req("bash", command))).toBe("allow")
    }
    expect(c.n).toBe(0)
  })

  test("anything that can write still prompts", async () => {
    const c = { n: 0 }
    const h = handler(() => {
      c.n++
      return "allow"
    })
    for (const command of ["npm install", "rm -rf x", "ls > out.txt", "ls && rm x"]) {
      expect(await h(req("bash", command))).toBe("allow")
    }
    expect(c.n).toBe(4)
  })

  test("an explicit ask rule beats the read-only allowlist", async () => {
    const c = { n: 0 }
    const h = createAskHandler({
      rules: { bash: { "git *": "ask" } },
      mode: "build",
      onAsk: countingAsk("allow", c),
    })
    expect(await h(req("bash", "git status"))).toBe("allow")
    expect(c.n).toBe(1)
  })

  test("an explicit deny rule beats the read-only allowlist", async () => {
    const h = createAskHandler({
      rules: { bash: { "git *": "deny" } },
      mode: "build",
      onAsk: countingAsk("allow", { n: 0 }),
    })
    expect(await h(req("bash", "git status"))).toBe("deny")
  })
})

/* -------------------------------------------------------------------------- */
/* Always-allow: pattern derivation and persistence                            */
/* -------------------------------------------------------------------------- */

describe("suggestPatterns", () => {
  test("keeps command + subcommand and wildcards the arguments", () => {
    expect(suggestPatterns(req("bash", 'git commit -m "wip"'))).toEqual([
      "git commit *",
    ])
    expect(suggestPatterns(req("bash", "npm run test:unit"))).toEqual(["npm run *"])
    expect(suggestPatterns(req("bash", "ls -la"))).toEqual(["ls *"])
  })

  test("a command with no stable leading word yields the exact string", () => {
    expect(suggestPatterns(req("bash", "./scripts/deploy.sh --prod"))).toEqual([
      "./scripts/deploy.sh --prod",
    ])
  })

  test("derives through wrappers and assignments", () => {
    expect(suggestPatterns(req("bash", "timeout 30 npm test"))).toEqual(["npm test *"])
    expect(suggestPatterns(req("bash", "NODE_ENV=test npm test"))).toEqual([
      "npm test *",
    ])
  })

  test("a chain yields one pattern per part, deduplicated", () => {
    expect(suggestPatterns(req("bash", "git status && npm test"))).toEqual([
      "git status *",
      "npm test *",
    ])
    expect(suggestPatterns(req("bash", "git status && git status"))).toEqual([
      "git status *",
    ])
  })

  test("path tools use the exact path, tools with no subject use *", () => {
    expect(suggestPatterns(req("write", "/tmp/a.ts"))).toEqual(["/tmp/a.ts"])
    expect(suggestPatterns({ tool: "task", title: "t", args: {}, sessionID: "s" })).toEqual(
      ["*"],
    )
  })
})

describe("persistAlwaysRule", () => {
  const tmp = async (): Promise<string> => {
    const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-perm-${crypto.randomUUID()}`
    await Bun.write(`${dir}/.keep`, "")
    return dir
  }

  test("writes an allow rule the config loader reads back", async () => {
    const dir = await tmp()
    expect(await persistAlwaysRule(dir, "bash", ["git commit *"])).toBeNull()

    const written = await Bun.file(`${dir}/${LOCAL_SETTINGS_FILE}`).json()
    expect(written).toEqual({ permission: { bash: { "git commit *": "allow" } } })

    const { config } = await loadConfig(dir)
    expect(evaluatePermission(config.permission, "bash", "git commit -m x")).toBe(
      "allow",
    )
  })

  test("accumulates rules across calls without dropping earlier ones", async () => {
    const dir = await tmp()
    await persistAlwaysRule(dir, "bash", ["git commit *"])
    await persistAlwaysRule(dir, "bash", ["npm run *"])
    await persistAlwaysRule(dir, "write", ["/tmp/a.ts"])

    const { config } = await loadConfig(dir)
    expect(evaluatePermission(config.permission, "bash", "git commit -m x")).toBe("allow")
    expect(evaluatePermission(config.permission, "bash", "npm run build")).toBe("allow")
    expect(evaluatePermission(config.permission, "write", "/tmp/a.ts")).toBe("allow")
  })

  test("a pre-existing bare action becomes the catch-all pattern", async () => {
    const dir = await tmp()
    await Bun.write(
      `${dir}/${LOCAL_SETTINGS_FILE}`,
      JSON.stringify({ permission: { bash: "deny" } }),
    )
    await persistAlwaysRule(dir, "bash", ["git commit *"])

    const { config } = await loadConfig(dir)
    // The blanket deny survives as `*`, so it still covers everything else.
    expect(evaluatePermission(config.permission, "bash", "rm -rf /")).toBe("deny")
    expect(evaluatePermission(config.permission, "bash", "git commit -m x")).toBe("allow")
  })

  test("a malformed settings file does not lose the new decision", async () => {
    const dir = await tmp()
    await Bun.write(`${dir}/${LOCAL_SETTINGS_FILE}`, "{ not json")
    expect(await persistAlwaysRule(dir, "bash", ["ls *"])).toBeNull()

    const { config } = await loadConfig(dir)
    expect(evaluatePermission(config.permission, "bash", "ls -la")).toBe("allow")
  })

  test("preserves unrelated keys already in the file", async () => {
    const dir = await tmp()
    await Bun.write(
      `${dir}/${LOCAL_SETTINGS_FILE}`,
      JSON.stringify({ model: "anthropic/x" }),
    )
    await persistAlwaysRule(dir, "bash", ["ls *"])

    const written = (await Bun.file(`${dir}/${LOCAL_SETTINGS_FILE}`).json()) as {
      model?: string
    }
    expect(written.model).toBe("anthropic/x")
  })

  test("an unwritable target reports a string instead of throwing", async () => {
    const error = await persistAlwaysRule("/proc/nonexistent-haxford", "bash", ["ls *"])
    expect(typeof error).toBe("string")
  })
})

describe("createAskHandler — always persists when a cwd is given", () => {
  const tmp = async (): Promise<string> => {
    const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-perm-${crypto.randomUUID()}`
    await Bun.write(`${dir}/.keep`, "")
    return dir
  }

  test("an 'always' answer survives into a fresh handler built from the config", async () => {
    const dir = await tmp()
    const first = createAskHandler({
      rules: { bash: { "npm *": "ask" } },
      mode: "build",
      cwd: dir,
      onAsk: () => "always",
    })
    expect(await first(req("bash", "npm install"))).toBe("always")

    // A new process would rebuild its rules from disk; the approval is there.
    const { config } = await loadConfig(dir)
    const c = { n: 0 }
    const second = createAskHandler({
      rules: config.permission,
      mode: "build",
      onAsk: countingAsk("deny", c),
    })
    expect(await second(req("bash", "npm install --save-dev x"))).toBe("allow")
    expect(c.n).toBe(0)
  })

  test("without a cwd nothing is written and the memory stays in-process", async () => {
    const dir = await tmp()
    const handler = createAskHandler({
      rules: { bash: { "npm *": "ask" } },
      mode: "build",
      onAsk: () => "always",
    })
    expect(await handler(req("bash", "npm install"))).toBe("always")
    expect(await Bun.file(`${dir}/${LOCAL_SETTINGS_FILE}`).exists()).toBe(false)
  })

  test("a denial is never persisted", async () => {
    const dir = await tmp()
    const handler = createAskHandler({
      rules: { bash: { "npm *": "ask" } },
      mode: "build",
      cwd: dir,
      onAsk: () => "deny",
    })
    expect(await handler(req("bash", "npm install"))).toBe("deny")
    expect(await Bun.file(`${dir}/${LOCAL_SETTINGS_FILE}`).exists()).toBe(false)
  })
})

// Silence unused-import warnings if the contract narrows types later.
void (null as unknown as PermissionAction)
