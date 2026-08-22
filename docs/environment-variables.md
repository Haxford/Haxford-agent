# Environment variables

Every environment variable haxford reads, grouped by purpose. haxford never requires a variable to be set — each has a fallback.

## Runtime

| Variable | Effect |
|---|---|
| `HAXFORD_MODEL` | Fallback default model spec (`provider/model`) when [config](configuration.md) names no `model`. Lowest-priority override: `-m` and config both win. |
| `HAXFORD_DATA_DIR` | Override the session data root. See [Sessions → storage layout](sessions.md#storage-layout). |

Standard XDG variables are honored:

| Variable | Effect |
|---|---|
| `XDG_CONFIG_HOME` | Base for global config; defaults effect: `~/.config/haxford/haxford.json`. |
| `XDG_DATA_HOME` | Base for sessions/todos; defaults effect: `~/.local/share/haxford`. |

## Providers

API keys — see [Providers](providers.md) for the full auth precedence (config key → provider resolver → env var → opencode store):

| Variable | Provider |
|---|---|
| `ANTHROPIC_API_KEY` | `anthropic` |
| `OPENAI_API_KEY` | `openai` |
| `OPENROUTER_API_KEY` | `openrouter` |
| `OLLAMA_API_KEY` | `ollama` — optional; presence switches local-first ollama to the hosted service when no local host is pinned |
| `OLLAMA_HOST` | `ollama` — daemon endpoint, default `http://localhost:11434/v1` |
| `Z_AI_API_KEY` | `zai` |
| `MOONSHOT_API_KEY` | `moonshot` (alias `kimi`) |
| `OPENCODE_API_KEY` | `opencode` (opencode zen) |

Credential-store overrides:

| Variable | Effect |
|---|---|
| `OPENCODE_AUTH_PATH` | Override the opencode auth store path (default `~/.local/share/opencode/auth.json`). Read-only access. |
| `CODEX_HOME` | Location of the codex auth file (default `~/.codex`; reads `auth.json` inside). |
| `CODEX_OAUTH_TOKEN_URL` | Override the codex OAuth token endpoint if it ever changes from the codex CLI's public value. |
| `CODEX_OAUTH_CLIENT_ID` | Override the codex OAuth client id likewise. |

## Installer

Only used by the one-line install script:

| Variable | Effect |
|---|---|
| `HAXFORD_VERSION=v0.1.0` | Install a specific release instead of the latest. |
| `HAXFORD_INSTALL_DIR=<dir>` | Install somewhere other than `~/.local/bin`. |
| `HAXFORD_NO_MODIFY_PATH=1` | Never touch your shell rc files. |
| `HAXFORD_FORCE=1` | Reinstall even if the current version is already present. |

## Next

- [Providers](providers.md) — auth precedence and per-provider setup.
- [Configuration](configuration.md) — the config files these variables interact with.
