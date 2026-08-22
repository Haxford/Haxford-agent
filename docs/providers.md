# Providers

haxford resolves models through eight built-in providers. A model is always referenced as a `"provider/model"` spec — the spec splits on the **first** slash, so model ids may themselves contain slashes (e.g. `openrouter/anthropic/claude-sonnet-5`). The default spec is `anthropic/claude-sonnet-5`, overridable with `HAXFORD_MODEL`, the `-m`/`--model` flag, or the `model` config key.

## Built-in providers

| Provider | Env key | Base URL | Wire protocol |
|---|---|---|---|
| `anthropic` | `ANTHROPIC_API_KEY` | — | Anthropic Messages |
| `openai` | `OPENAI_API_KEY` | — | OpenAI Responses |
| `openrouter` | `OPENROUTER_API_KEY` | `https://openrouter.ai/api/v1` | OpenAI chat |
| `ollama` | `OLLAMA_API_KEY` (optional), `OLLAMA_HOST` | `http://localhost:11434/v1` (default) | OpenAI chat |
| `zai` | `Z_AI_API_KEY` | `https://api.z.ai/api/paas/v4` | OpenAI chat |
| `moonshot` | `MOONSHOT_API_KEY` | `https://api.moonshot.ai/v1` | OpenAI chat |
| `opencode` | `OPENCODE_API_KEY` | `https://opencode.ai/zen/v1` | OpenAI chat |
| `codex` | — (reads `~/.codex/auth.json`) | `https://chatgpt.com/backend-api/codex` | OpenAI Responses |

`kimi` is an alias for `moonshot` — `kimi/kimi-k2` resolves identically.

## Auth precedence

For any provider, credentials are tried in this order (first non-empty wins):

1. `providers.<name>.apiKey` in [config](configuration.md).
2. The provider's own resolver (codex login file, ollama's local daemon).
3. The provider's env key (e.g. `ANTHROPIC_API_KEY`).
4. opencode's auth store at `~/.local/share/opencode/auth.json` (read-only, `{type:"api",key}` entries only — `oauth` entries are ignored because haxford cannot refresh them). Override the path with `OPENCODE_AUTH_PATH`.

### Security note

Prefer the environment or opencode's auth store over writing keys into `haxford.json`. A project-config `apiKey` ships the secret into the repo if you commit it. If you must use a config key (e.g. for a custom gateway), add `haxford.json` to `.gitignore` or scope the key under `providers` only.

## Ollama: local vs cloud

Ollama is local-first — no key is needed against a local daemon at `http://localhost:11434`. Set `OLLAMA_HOST` to point elsewhere. When `OLLAMA_API_KEY` is set and no local host is pinned (or the host contains `ollama.com`), haxford targets the hosted service at `https://ollama.com/v1` instead.

Availability is **probed live** (a `GET /api/tags` with a 1.5s timeout, cached 30s): the `/model` picker truthfully reports whether the daemon is up. An unreachable host is a normal outcome, not an error — the picker greys out its models until the daemon returns.

## Codex (ChatGPT login)

The `codex` provider reuses a ChatGPT login performed by the `codex` CLI. haxford reads `$CODEX_HOME/auth.json`, falling back to `~/.codex/auth.json`. It extracts `tokens.access_token` and `tokens.account_id` and sends them as a bearer token plus a `chatgpt-account-id` header.

**Token refresh is manual.** haxford does not perform the OAuth refresh exchange. When the stored `access_token` expires, the provider returns 401 and you must re-run `codex login` to refresh it. This is a known limitation, not a bug.

## Model picker

The `/model` picker lists every curated `knownModels` entry plus the **live OpenRouter catalog** (fetched from `https://openrouter.ai/api/v1/models`, cached one hour, never throws — on failure it falls back to the curated list). Each entry shows label, context window, and per-million-token prompt/completion pricing when available. Providers without a credential are greyed out with "needs setup".

## Custom providers

Any provider you add under `providers` in config is available as `"<name>/<model>"`. Provide an `apiKey` and optionally a `baseURL` and `models` list:

```json
{
  "providers": {
    "my-gateway": {
      "apiKey": "sk-...",
      "baseURL": "https://gateway.example.com/v1",
      "models": ["my-model-1", "my-model-2"]
    }
  }
}
```

The wire protocol is OpenAI chat completions for custom providers. There is no per-provider protocol override today.

## Context windows

haxford keeps a small static table of context limits per provider/model family (Anthropic `claude-*` 200k, OpenAI `gpt-4o`/`gpt-5` 128k, `o*` 200k, codex `gpt-5` 200k, zai `glm-*` 128k, moonshot `kimi-k2` 128k / `moonshot-v1-Nk` = N×1000, ollama 32k, gateways 200k). Unknown models default to 200k. This drives [compaction](sessions.md#compaction); being wrong low just compacts a little early.

## Next

- [Permissions](permissions.md) — how tool actions are gated.
- [Configuration](configuration.md) — the full config schema.
