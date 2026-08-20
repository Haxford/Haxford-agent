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
} from "../src/permission/index.ts"

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
    expect(await handler(req("bash", "ls"))).toBe("deny")
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
    expect(await handler(req("bash", "ls -la"))).toBe("allow")
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

// Silence unused-import warnings if the contract narrows types later.
void (null as unknown as PermissionAction)
