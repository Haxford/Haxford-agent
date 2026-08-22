# Configuration

haxford loads JSON config from three layers and deep-merges them. Later layers win on scalar conflicts; `permission` rules merge per-pattern; `providers` merge per-provider object.

## Config files

| Layer | Path | Notes |
|---|---|---|
| Global | `~/.config/haxford/haxford.json` (or `$XDG_CONFIG_HOME/haxford/haxford.json`) | User-wide defaults. |
| Project | `./haxford.json` | Project-specific; safe to commit. |
| Project-local | `./.haxford/settings.local.json` | Written by the permission engine on `always` answers. Machine-local — do **not** commit. |

A fourth file is config-adjacent but not a config layer: `.haxford/state.json`, written when you pick a model in the `/model` picker so the choice survives restarts. It holds `{ "model": "provider/model" }` only — see [model resolution](usage.md#model-resolution) for where it sits in the precedence order.

An `AGENTS.md` in the project root is read verbatim and appended to the system prompt as project instructions. See [Using haxford → context files](usage.md#context-files).

## Merge rules

- **Scalars** (`model`, `maxTurns`, `autoCompactAt`): later layer wins outright.
- **`providers`**: merged per-provider — `providers.openrouter` from global is not replaced by a project entry that only sets `providers.anthropic`; each provider's `{apiKey, baseURL, models}` merges field by field.
- **`permission`**: merged per-pattern — a local file that names a single `bash` pattern does not replace every `bash` rule from a lower layer. Two pattern records merge pattern by pattern; a bare action (`"bash": "deny"`) replaces the whole entry for that tool.

## Full schema

```json
{
  "model": "deepseek/deepseek-chat-v3.1",
  "providers": {
    "openrouter": {
      "apiKey": "sk-or-...",
      "baseURL": "https://openrouter.ai/api/v1",
      "models": ["deepseek/deepseek-chat-v3.1", "anthropic/claude-sonnet-5", "openai/gpt-5.2"]
    }
  },
  "permission": {
    "read": "allow",
    "write": "ask",
    "edit": "ask",
    "bash": {
      "git status": "allow",
      "git diff *": "allow",
      "rm *": "deny",
      "*": "ask"
    }
  },
  "maxTurns": 100,
  "autoCompactAt": 0.9,
  "theme": "violet"
}
```

### Fields

| Field | Type | Default | Description |
|---|---|---|---|
| `model` | string | `deepseek/deepseek-chat-v3.1` | `"provider/model"` spec. Overridden by `-m`/`--model` or `HAXFORD_MODEL`. |
| `providers` | object | — | Per-provider overrides. See below. |
| `permission` | object | — | [Permission rules](permissions.md#rules). |
| `maxTurns` | number | `100` | Max loop turns per prompt before the run stops with reason `max_turns`. |
| `autoCompactAt` | number | `0.9` | Auto-compact when context usage exceeds this fraction (0–1). See [Sessions → compaction](sessions.md#compaction). |
| `theme` | string | — | Name of a theme in `~/.haxford/themes`. The `HAXFORD_THEME` env var overrides it. See [Extending → themes](extending.md#3-themes). |

### `providers` entries

| Field | Description |
|---|---|
| `apiKey` | API key for this provider. Overrides the env var and opencode-store fallback. |
| `baseURL` | Custom endpoint — for proxies, gateways, or self-hosted OpenAI-compatible servers. |
| `models` | Model ids to add to the `/model` picker under this provider. Combined with the built-in `knownModels`. |

Custom providers (any name not in the built-in eight) are spoken to as OpenAI chat completions. There is no per-provider protocol override today.

## Environment variables

haxford reads a handful of runtime variables (`HAXFORD_MODEL`, `HAXFORD_DATA_DIR`, `OPENCODE_AUTH_PATH`, `CODEX_HOME`, …) plus one key per provider. The full reference lives in [Environment variables](environment-variables.md).

## Security

Prefer the environment or opencode's auth store for API keys. A `providers.<name>.apiKey` in `haxford.json` ships the secret into the repo if committed. If you must use a config key, add `haxford.json` to `.gitignore` — or better, keep keys out of project config entirely and let the env-var / opencode-store fallback handle them.

`.haxford/settings.local.json` is written by the permission engine on `always` answers. It holds only approvals, but it is machine-local and should never be committed. It is **not** in `.gitignore` by default — add it yourself, or treat its contents as untrusted when reading config.

## Next

- [Providers](providers.md) - the auth precedence and per-provider keys.
- [Permissions](permissions.md) - the `permission` block in detail.
- [Security](security.md) - credential storage guidance and startup warnings.
- [Environment variables](environment-variables.md) - the env-var reference.
- [Sessions](sessions.md) - `HAXFORD_DATA_DIR` and the storage layout.
