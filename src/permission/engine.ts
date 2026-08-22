import { join } from "node:path"
import type { PermissionAction, PermissionRules } from "../types/config.ts"
import type { PermissionDecision, PermissionRequest } from "../types/tool.ts"

/**
 * How aggressively the agent may act without asking.
 *
 * - build: evaluate rules; anything landing on `ask` prompts the user.
 * - auto:  allow everything except what a rule explicitly denies.
 * - plan:  read-only. Mutating tools are denied outright, without prompting;
 *          bash is allowed only for commands that cannot change anything.
 */
export type Mode = "build" | "auto" | "plan"

/** Tools that never need approval when no rule says otherwise. */
const ALLOW_BY_DEFAULT = new Set([
  "read",
  "glob",
  "grep",
  "todoread",
  "todowrite",
])

/** Denied outright in plan mode — they change the world. */
const MUTATING = new Set(["write", "edit"])

/** Allowed outright in plan mode — they only look. */
const PLAN_READONLY = new Set([
  "read",
  "glob",
  "grep",
  "todoread",
  "todowrite",
  "webfetch",
])

function toolDefault(tool: string): PermissionAction {
  return ALLOW_BY_DEFAULT.has(tool) ? "allow" : "ask"
}

/* -------------------------------------------------------------------------- */
/* Glob matching                                                               */
/* -------------------------------------------------------------------------- */

const compiled = new Map<string, RegExp | null>()

/**
 * Tools whose subject is not a path. `/` carries no structure in a shell
 * command, so segment-scoped `*` would be a trap there: `rm *` must match
 * `rm -rf /`, or a deny rule silently fails to fire.
 */
const FLAT_SUBJECT = new Set(["bash"])

/**
 * Compile a glob-ish pattern. For path subjects `*` matches within a segment,
 * `**` matches across segments, and a trailing-slash `**\/` also matches zero
 * segments so `**\/*.ts` matches a top-level `a.ts`. For flat subjects (shell
 * commands) `*` and `**` both match anything. Everything else is literal.
 */
function globToRegExp(pattern: string, flat: boolean): RegExp | null {
  const key = `${flat ? "f" : "s"}:${pattern}`
  const cached = compiled.get(key)
  if (cached !== undefined) return cached

  // A lone "*" is the tool-wide default, so it matches every subject —
  // including paths containing "/", which segment-scoped "*" would exclude.
  if (pattern === "*") {
    const any = /^[\s\S]*$/
    compiled.set(key, any)
    return any
  }

  let source = "^"
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i]
    if (char === "*") {
      if (pattern[i + 1] === "*") {
        i++
        if (!flat && pattern[i + 1] === "/") {
          i++
          // Zero or more leading segments.
          source += "(?:.*/)?"
        } else {
          source += ".*"
        }
      } else {
        source += flat ? ".*" : "[^/]*"
      }
      continue
    }
    source += (char ?? "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  }

  let regex: RegExp | null
  try {
    regex = new RegExp(`${source}$`)
  } catch {
    // Unbuildable pattern: never matches rather than throwing.
    regex = null
  }
  compiled.set(key, regex)
  return regex
}

function matches(pattern: string, subject: string, flat: boolean): boolean {
  return globToRegExp(pattern, flat)?.test(subject) ?? false
}

/* -------------------------------------------------------------------------- */
/* Read-only shell commands (plan mode)                                        */
/* -------------------------------------------------------------------------- */

/**
 * Anything that could chain, substitute, redirect or expand into a second
 * command. A command containing any of these is never treated as read-only,
 * however safe its first word looks: `ls; rm -rf /` starts with `ls`.
 */
const SHELL_CONTROL = /[;&|`$(){}<>\n\r\\!]/

/**
 * Commands that only read. Deliberately excludes anything that can execute
 * code of its own (awk, xargs, node, bun, python, sh) or write files, even
 * when the common invocation is harmless — the cost of a wrong entry here is
 * a mutation in a mode that promised not to make one.
 */
const READONLY_COMMANDS = new Set([
  "basename", "cat", "cksum", "column", "comm", "cut", "date", "df", "diff",
  "dirname", "du", "fd", "fgrep", "file", "grep", "egrep", "head", "hostname",
  "jq", "less", "ls", "md5sum", "nl", "printenv", "pwd", "readlink", "realpath",
  "rg", "sha1sum", "sha256sum", "shasum", "sort", "stat", "tail", "tr", "tree",
  "type", "uname", "uniq", "wc", "which", "whoami", "yq",
])

/** git subcommands that cannot modify the repository, whatever their flags. */
const READONLY_GIT = new Set([
  "blame", "cat-file", "describe", "diff", "log", "ls-files", "ls-tree",
  "name-rev", "reflog", "rev-parse", "shortlog", "show", "status",
])

/** `find` actions that run commands or delete files. */
const FIND_WRITE_FLAGS = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint",
  "-fprint0", "-fprintf",
])

/**
 * Whether a shell command only inspects the workspace.
 *
 * Used by plan mode, where denying bash outright would make the mode useless
 * — you cannot plan a change without running `git diff` or `rg` — but any
 * false positive silently breaks the mode's one promise. So this is an
 * allowlist that answers "no" to everything it does not positively recognise.
 */
export function isReadOnlyCommand(command: string): boolean {
  const trimmed = command.trim()
  if (trimmed === "" || SHELL_CONTROL.test(trimmed)) return false

  const words = trimmed.split(/\s+/)
  const head = words[0]
  if (head === undefined) return false
  const args = words.slice(1)

  if (head === "git") {
    const sub = args.find((word) => !word.startsWith("-"))
    return sub !== undefined && READONLY_GIT.has(sub)
  }

  if (head === "find") {
    return !args.some((word) => FIND_WRITE_FLAGS.has(word))
  }

  // sed only writes with an in-place flag; without one it is a stdout filter.
  if (head === "sed") {
    return !args.some((word) => word === "-i" || word.startsWith("-i") || word === "--in-place")
  }

  return READONLY_COMMANDS.has(head)
}

/* -------------------------------------------------------------------------- */
/* Shell command decomposition                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Split a shell command into the separate commands it actually runs.
 *
 * A pattern rule matches a string, but `git status && rm -rf /` is not one
 * command — it is two, and a rule written for the first must not vouch for
 * the second. Every operator that can start a new command is a boundary:
 * `&&`, `||`, `;`, `|`, `|&`, `&`, newlines, and the grouping/substitution
 * forms `( ) { } \` $(`.
 *
 * Quoted text is never split, so `echo "a && b"` stays one command.
 *
 * Splitting too eagerly is the safe direction: callers require EVERY part to
 * be permitted, so an extra fragment can only add an approval, never remove
 * one. Redirection operators are deliberately not boundaries — `ls > out.txt`
 * is one command whose write must be judged with it.
 */
export function splitCommand(command: string): string[] {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null

  const flush = () => {
    const trimmed = current.trim()
    if (trimmed.length > 0) parts.push(trimmed)
    current = ""
  }

  for (let i = 0; i < command.length; i++) {
    const char = command[i]
    if (char === undefined) continue

    if (quote !== null) {
      // A backslash escapes the next character inside double quotes only.
      if (char === "\\" && quote === '"' && i + 1 < command.length) {
        current += char + (command[i + 1] ?? "")
        i++
        continue
      }
      if (char === quote) quote = null
      current += char
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      current += char
      continue
    }

    if (char === "\\" && i + 1 < command.length) {
      // An escaped operator is literal text, not a boundary.
      current += char + (command[i + 1] ?? "")
      i++
      continue
    }

    if (
      char === "&" ||
      char === "|" ||
      char === ";" ||
      char === "\n" ||
      char === "\r" ||
      char === "(" ||
      char === ")" ||
      char === "{" ||
      char === "}" ||
      char === "`"
    ) {
      flush()
      // Consume the rest of a two-character operator so it cannot re-trigger.
      const next = command[i + 1]
      if (
        (char === "&" && next === "&") ||
        (char === "|" && (next === "|" || next === "&"))
      ) {
        i++
      }
      continue
    }

    current += char
  }
  flush()

  // Never return nothing: a caller that requires every part to be permitted
  // would treat an empty list as vacuously permitted.
  return parts.length > 0 ? parts : [command.trim()]
}

/**
 * Wrappers that run their argument as the real command, so a rule written
 * for the inner command should cover the wrapped form too.
 *
 * Deliberately excludes environment runners — `npx`, `docker exec`,
 * `mise exec`, `direnv exec`, `devbox run` — because they take an arbitrary
 * command from a different resolution context: stripping them would let a
 * rule like `Bash(devbox run *)` stand in for `devbox run rm -rf .`.
 */
const WRAPPERS = new Set(["timeout", "time", "nice", "nohup", "stdbuf", "noglob"])

/**
 * Wrappers whose query form does not run anything. `command -v foo` looks a
 * name up; `command foo` runs it. Strip only the running form.
 */
const CONDITIONAL_WRAPPERS = new Set(["command", "builtin", "xargs"])

/** A leading `NODE_ENV=test` style assignment, which does not change what runs. */
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/

/** `30`, `1.5`, `10s` — a wrapper's duration/count argument, not the command. */
const WRAPPER_ARG = /^\d+(\.\d+)?[smhd]?$/

/**
 * Strip wrapper commands and leading environment assignments so rules match
 * what actually runs: `timeout 30 npm test` and `NODE_ENV=test npm test` are
 * both `npm test`.
 */
export function stripWrappers(command: string): string {
  let tokens = command.trim().split(/\s+/).filter((token) => token.length > 0)

  // Bounded: each pass removes at least one token, and a pathological command
  // should not spin here.
  for (let pass = 0; pass < 8; pass++) {
    const head = tokens[0]
    if (head === undefined || tokens.length < 2) break

    if (ASSIGNMENT.test(head)) {
      tokens = tokens.slice(1)
      continue
    }

    if (CONDITIONAL_WRAPPERS.has(head)) {
      const next = tokens[1]
      // A flag means this is the query form (`command -v`) or a configured
      // xargs (`xargs -n1 grep`), which is its own command, not a wrapper.
      if (next === undefined || next.startsWith("-")) break
      tokens = tokens.slice(1)
      continue
    }

    if (WRAPPERS.has(head)) {
      let index = 1
      while (index < tokens.length) {
        const token = tokens[index]
        if (token === undefined) break
        if (token.startsWith("-") || WRAPPER_ARG.test(token)) {
          index++
          continue
        }
        break
      }
      // Nothing left after the wrapper's own arguments: keep it as the command.
      if (index >= tokens.length) break
      tokens = tokens.slice(index)
      continue
    }

    break
  }

  const stripped = tokens.join(" ")
  return stripped.length > 0 ? stripped : command.trim()
}

/**
 * Whether every command in a chain only inspects the workspace.
 *
 * `ls | grep foo` is two read-only commands and safe; `cat f | sh` is not.
 */
export function isReadOnlyChain(command: string): boolean {
  const parts = splitCommand(command)
  return parts.length > 0 && parts.every((part) => isReadOnlyCommand(part))
}

/* -------------------------------------------------------------------------- */
/* Rule resolution                                                             */
/* -------------------------------------------------------------------------- */

interface Resolution {
  action: PermissionAction
  /**
   * The pattern that decided this, or "" when the decision came from a
   * blanket rule or the tool default. Used as the always-memory key.
   */
  pattern: string
}

/**
 * Resolve a rule set for one tool/subject.
 *
 * A bare action (`{ bash: "deny" }`) wins immediately. Otherwise the longest
 * matching pattern wins — a rule keyed exactly `*` is short enough that any
 * more specific pattern beats it, which makes it the tool-wide default. When
 * equally long patterns disagree the result is ambiguous, so the tool default
 * applies instead.
 */
function resolve(
  rules: PermissionRules | undefined,
  tool: string,
  subject: string,
): Resolution {
  const fallback: Resolution = { action: toolDefault(tool), pattern: "" }

  const rule = rules?.[tool]
  if (rule === undefined) return fallback
  if (typeof rule === "string") return { action: rule, pattern: "" }

  const flat = FLAT_SUBJECT.has(tool)
  let bestLength = -1
  let bestPattern = ""
  let bestAction: PermissionAction | undefined
  let ambiguous = false

  for (const [pattern, action] of Object.entries(rule)) {
    if (!matches(pattern, subject, flat)) continue

    if (pattern.length > bestLength) {
      bestLength = pattern.length
      bestPattern = pattern
      bestAction = action
      ambiguous = false
    } else if (pattern.length === bestLength && action !== bestAction) {
      // Same specificity, conflicting verdicts.
      ambiguous = true
    }
  }

  if (bestAction === undefined || ambiguous) return fallback
  return { action: bestAction, pattern: bestPattern }
}

/** Severity order: the strictest verdict across a chain is the one that stands. */
const SEVERITY: Record<PermissionAction, number> = { allow: 0, ask: 1, deny: 2 }

/**
 * Resolve a whole tool action, decomposing a shell command first.
 *
 * For bash, every command in the chain is resolved independently against the
 * rules and the strictest verdict wins: one `deny` denies the chain, and a
 * part no rule covers falls back to the tool default (ask) rather than
 * inheriting a sibling's allow. This is what stops `{"git status *": "allow"}`
 * from vouching for `git status && rm -rf /`.
 *
 * The reported pattern is the one belonging to the deciding command, so the
 * always-memory key stays tied to the rule the user was actually shown.
 */
function resolveAction(
  rules: PermissionRules | undefined,
  tool: string,
  subject: string,
): Resolution {
  if (tool !== "bash") return resolve(rules, tool, subject)

  let worst: Resolution | undefined
  for (const part of splitCommand(subject)) {
    const current = resolve(rules, tool, stripWrappers(part))
    if (current.action === "deny") return current
    if (worst === undefined || SEVERITY[current.action] > SEVERITY[worst.action]) {
      worst = current
    }
  }
  return worst ?? { action: toolDefault(tool), pattern: "" }
}

/**
 * Evaluate permission rules for a tool action.
 *
 * `subject` is what the rule patterns match against: the command string for
 * bash, the file path for read/write/edit, and "" for tools with no natural
 * subject. Returns the tool default when nothing matches — allow for
 * read/glob/grep/todoread/todowrite, ask for everything else.
 *
 * A bash subject holding several chained commands is judged as all of them.
 */
export function evaluatePermission(
  rules: PermissionRules | undefined,
  tool: string,
  subject: string,
): PermissionAction {
  return resolveAction(rules, tool, subject).action
}

/* -------------------------------------------------------------------------- */
/* Ask handler                                                                 */
/* -------------------------------------------------------------------------- */

export interface AskHandlerOptions {
  rules?: PermissionRules
  mode: Mode
  /**
   * Called only when evaluation lands on ask (build mode). May be sync or
   * async; the result is awaited either way.
   */
  onAsk: (
    req: PermissionRequest,
  ) => PermissionDecision | Promise<PermissionDecision>
  /**
   * Project directory. When given, an "always" answer is written to
   * `<cwd>/.haxford/settings.local.json` so it survives a restart. Omit for
   * subagents and tests, where an approval should not outlive the process.
   */
  cwd?: string
}

/**
 * The subject a request's rules match against. Tools pass their own args, so
 * this reads the conventional keys and falls back to "" for tools with no
 * natural subject.
 */
function subjectOf(request: PermissionRequest): string {
  const args = request.args
  for (const key of ["command", "filePath", "path", "url"]) {
    const value = args[key]
    if (typeof value === "string") return value
  }
  return ""
}

/** Memory key for an "always" decision. */
function memoryKey(tool: string, pattern: string): string {
  return pattern ? `${tool} ${pattern}` : tool
}

/* -------------------------------------------------------------------------- */
/* Always-allow rules                                                          */
/* -------------------------------------------------------------------------- */

/** Project-local, machine-local approvals. Not meant to be committed. */
export const LOCAL_SETTINGS_FILE = ".haxford/settings.local.json"

/** Approving one chained command should not write an unbounded pile of rules. */
const MAX_SUGGESTED_PATTERNS = 5

/** A token stable enough to belong in a rule: a command or a subcommand name. */
const BARE_WORD = /^[A-Za-z][A-Za-z0-9._-]*$/

/**
 * Derive a rule pattern from one shell command.
 *
 * Keeps the leading command and subcommand — the part that names *what runs* —
 * and wildcards the arguments, which are the part that varies: `git commit -m
 * "wip"` becomes `git commit *`, `ls -la` becomes `ls *`. Stops at the first
 * token that looks like data (a flag, a path, a version, a quoted string) so a
 * pattern never hard-codes one invocation's arguments.
 *
 * A command with no stable leading word — `./scripts/deploy.sh` — yields the
 * exact string instead, because there is no prefix that could be widened
 * without also covering scripts the user never approved.
 */
function commandPattern(command: string): string {
  const tokens = command.trim().split(/\s+/).filter((token) => token.length > 0)
  const stable: string[] = []
  for (const token of tokens.slice(0, 2)) {
    if (!BARE_WORD.test(token)) break
    stable.push(token)
  }
  if (stable.length === 0) return command.trim()
  return `${stable.join(" ")} *`
}

/**
 * The rule pattern(s) an "always" answer to this request should create.
 *
 * Exported so the approval UI can show the user exactly what they are about to
 * grant ("Always allow `git commit *`") using the same derivation the engine
 * persists — a dialog that names a different rule than the one written is
 * worse than no dialog at all.
 *
 * A chained command yields one pattern per part, matching how rules are
 * evaluated: each command is judged on its own, so each needs its own rule.
 */
export function suggestPatterns(request: PermissionRequest): string[] {
  const subject = subjectOf(request)
  if (subject === "") return ["*"]
  if (request.tool !== "bash") return [subject]

  const seen = new Set<string>()
  for (const part of splitCommand(subject)) {
    seen.add(commandPattern(stripWrappers(part)))
    if (seen.size >= MAX_SUGGESTED_PATTERNS) break
  }
  return [...seen]
}

interface LocalSettings {
  permission?: PermissionRules
  [key: string]: unknown
}

/**
 * Record an always-allow decision in the project's local settings file.
 *
 * Returns an error string rather than throwing: a decision the user already
 * made must stand for the rest of the session even when it cannot be written
 * to disk, so callers treat failure as "remembered for now, not forever".
 */
export async function persistAlwaysRule(
  cwd: string,
  tool: string,
  patterns: string[],
): Promise<string | null> {
  if (patterns.length === 0) return null
  const path = join(cwd, LOCAL_SETTINGS_FILE)

  let settings: LocalSettings = {}
  try {
    const file = Bun.file(path)
    if (await file.exists()) {
      const parsed: unknown = await file.json()
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        settings = parsed as LocalSettings
      }
    }
  } catch {
    // Unreadable or malformed: start from empty rather than refusing to save.
    // This file holds only approvals, each of which the user can grant again,
    // so losing it costs less than dropping the decision they just made.
    settings = {}
  }

  const permission: PermissionRules = { ...settings.permission }
  const existing = permission[tool]
  // A bare action outranks every pattern, so it has to become the catch-all
  // pattern before per-pattern rules underneath it can mean anything.
  const rules: Record<string, PermissionAction> =
    typeof existing === "string" ? { "*": existing } : { ...(existing ?? {}) }

  for (const pattern of patterns) rules[pattern] = "allow"
  permission[tool] = rules

  try {
    await Bun.write(
      path,
      `${JSON.stringify({ ...settings, permission }, null, 2)}\n`,
    )
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/**
 * Build the callback the agent loop passes as `input.askPermission`.
 *
 * "always" answers are remembered for the rest of the process, keyed by the
 * tool plus the pattern that matched (or the tool alone when the decision was
 * blanket), so later matching requests skip the prompt. Denials are never
 * remembered — the user is asked again next time. The handler never throws;
 * if `onAsk` rejects, the action is denied.
 */
export function createAskHandler(
  opts: AskHandlerOptions,
): (req: PermissionRequest) => Promise<PermissionDecision> {
  const remembered = new Set<string>()

  return async (request: PermissionRequest): Promise<PermissionDecision> => {
    const tool = request.tool
    const subject = subjectOf(request)
    const { action, pattern } = resolveAction(opts.rules, tool, subject)

    // An explicit deny is final in every mode.
    if (action === "deny") return "deny"

    if (opts.mode === "auto") return "allow"

    if (opts.mode === "plan") {
      if (MUTATING.has(tool)) return "deny"
      if (PLAN_READONLY.has(tool)) return "allow"
      if (tool === "bash") {
        // Inspecting the workspace is the whole point of plan mode; changing
        // it is what the mode forbids. The allowlist answers "no" to anything
        // it does not positively recognise, and every command in a chain has
        // to clear it, so an unrecognised command is denied exactly as before.
        return isReadOnlyChain(subject) ? "allow" : "deny"
      }
      // Anything else — including task, whose subagent inherits plan mode and
      // is therefore read-only too — takes the normal evaluate-then-ask path.
    }

    if (action === "allow") return "allow"

    // action === "ask"
    // An empty pattern means no rule matched and this is only the tool
    // default. Inspecting the workspace is not what the user wants to be
    // asked about, so a chain that provably cannot change anything runs
    // without a prompt — while any rule the user did write still decides.
    if (
      opts.mode === "build" &&
      tool === "bash" &&
      pattern === "" &&
      isReadOnlyChain(subject)
    ) {
      return "allow"
    }

    // A previous "always" for this same tool+pattern stands in for the prompt.
    if (remembered.has(memoryKey(tool, pattern))) return "always"

    let decision: PermissionDecision
    try {
      decision = await opts.onAsk(request)
    } catch {
      // A failed prompt must never approve the action.
      return "deny"
    }

    if (decision === "always") {
      remembered.add(memoryKey(tool, pattern))
      if (opts.cwd !== undefined) {
        // Best-effort: the decision stands for this session either way, so a
        // write failure must not turn an approval into a denial.
        await persistAlwaysRule(opts.cwd, tool, suggestPatterns(request))
      }
      return "always"
    }
    // Anything that is not an explicit approval is a refusal.
    return decision === "allow" ? "allow" : "deny"
  }
}
