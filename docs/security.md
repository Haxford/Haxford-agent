# Security

How haxford handles trust, credentials, and untrusted content — and what it deliberately does not do.

## Trust model

haxford runs as a single process with the permissions of the user who launched it. There is no sandbox, no container, and no filesystem jail: a `bash` command the agent runs can do anything your shell can. Treat a session as "this program may modify my workspace and run commands" — because in `auto` mode, or after an `always` answer, it will.

Mitigations are procedural, not architectural:

- [Permission modes](permissions.md) gate every mutating tool call. `plan` mode denies writes outright and restricts bash to a [read-only allowlist](permissions.md#read-only-bash-allowlist) that answers "no" to anything it does not positively recognise.
- Compound bash commands are split on every shell boundary and every part must be permitted — approving `git status` never vouches for `git status && rm -rf /`.
- Denials are never remembered. Only approvals persist, and only to machine-local files.

For defense in depth, run haxford inside a container or VM when working against an untrusted checkout. There is no built-in integration yet.

## Credentials

Where API keys can live, best first:

1. **Environment variables** (`ANTHROPIC_API_KEY`, …) — never touch disk.
2. **opencode's auth store** (`~/.local/share/opencode/auth.json`) — read read-only; haxford never writes it.
3. **Global config** (`~/.config/haxford/haxford.json`) — written by `/connect` with mode `600`. Keys here stay on your machine but sit in a JSON file.
4. **Project config** — supported but discouraged; flagged at startup (see below).

Startup inspects all three config layers and prints `[security]` warnings to stderr before the first turn:

- An `apiKey` in project config or project-local config — both are easy to commit by accident.
- A credential-bearing global config whose file mode lets group or world read it (with the exact `chmod 600` to fix it).
- A custom provider with no `baseURL` — cannot resolve to a client, so any session using it will fail.

The codex token refresh merge-writes back to `auth.json` preserving unknown fields, with mode `600`.

## Machine-local files

Two files under `.haxford/` in a project are machine-local and must not be committed:

| File | Written by | Contents |
|---|---|---|
| `settings.local.json` | Permission engine on `always` answers | Approval rules only |
| `state.json` | `/model` picker | Last chosen model spec |

Neither is created in a fresh checkout by haxford itself — add them to `.gitignore` if you commit projects that use haxford. Treat their contents as untrusted input when reading config: they live inside the workspace the agent writes to.

## Untrusted content

Everything the model reads — repository files, tool output, `AGENTS.md`, and pages fetched through [webfetch](tools.md#webfetch) — becomes part of its context. A malicious page or file can attempt prompt injection: instructions that try to make the agent fetch something odd, edit files it should not, or exfiltrate content via another `webfetch` call.

The permission engine is the boundary that matters: injected instructions still have to pass the same rules as everything else. Practical guidance:

- Work in `build` or `plan` mode when reading untrusted material; deny prompts you did not expect.
- Keep `auto` mode scoped with [`permission.trust`](permissions.md#scoped-trust).
- Prefer explicit `deny` rules for paths that must never change (e.g. `"edit": { ".github/**": "deny" }`).

## Network traffic

haxford itself talks to exactly these endpoints: your chosen model provider, the OpenRouter model catalog (cached one hour), the ollama reachability probe, `/connect` key verification, and the codex OAuth token endpoint on refresh. Every outbound request carries identifying attribution headers — see [Attribution](providers.md#attribution). There is no telemetry.

## Reporting vulnerabilities

Please report security issues privately via [GitHub security advisories](https://github.com/Haxford/Haxford-agent/security/advisories/new) rather than a public issue. Include the haxford version (`~/.local/share/haxford/version` records what the installer installed), a minimal reproduction, and the affected page or code path.
