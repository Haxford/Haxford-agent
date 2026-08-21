import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import type { HaxfordConfig } from "../types/config.ts"
import {
  opencodeAuthPath,
  readCodexAuth,
  readOpencodeApiKey,
  tryReadCodexAuth,
} from "./auth.ts"

/** Used when neither config nor HAXFORD_MODEL specifies a model. */
export const DEFAULT_MODEL_SPEC = "anthropic/claude-sonnet-5"

/**
 * Which wire protocol a provider speaks.
 *
 * - anthropic: the Anthropic Messages API.
 * - responses: OpenAI's Responses API (what `openai(id)` uses by default).
 * - chat:      OpenAI-compatible chat completions, used by every third party
 *              that exposes an OpenAI-shaped endpoint.
 */
export type ProviderApi = "anthropic" | "responses" | "chat"

export interface ProviderDef {
  /** Environment variable holding the API key, when the provider uses one. */
  envKey?: string
  baseURL?: string
  api: ProviderApi
  headers?: Record<string, string>
  /** Model ids offered in the picker; combined with the provider name. */
  knownModels?: string[]
  /** Credential lookup for providers that do not read a plain env var. */
  resolveApiKey?: () => Promise<string | undefined> | string | undefined
  /**
   * Extra fields beyond the base shape, for providers whose endpoint or
   * headers depend on the resolved credential or the environment.
   */
  resolveBaseURL?: () => string | undefined
  resolveHeaders?: (apiKey: string) => Record<string, string> | undefined
}

/** Treat blank/whitespace-only env values as unset. */
function env(name: string): string | undefined {
  const value = Bun.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/* -------------------------------------------------------------------------- */
/* Ollama                                                                      */
/* -------------------------------------------------------------------------- */

function isOllamaCloud(host: string): boolean {
  return host.includes("ollama.com")
}

/**
 * Ollama is local-first: no key needed against a local daemon. When
 * OLLAMA_API_KEY is set and no local host is pinned, target the hosted
 * service instead.
 */
function ollamaTarget(): { baseURL: string; apiKey: string } {
  const key = env("OLLAMA_API_KEY")
  const host = env("OLLAMA_HOST")

  if (key && (!host || isOllamaCloud(host))) {
    return { baseURL: "https://ollama.com/v1", apiKey: key }
  }

  const raw = host ?? "http://localhost:11434"
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  // The local server ignores the key, but the SDK requires a non-empty one.
  return { baseURL: `${withScheme.replace(/\/+$/, "")}/v1`, apiKey: "ollama" }
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    api: "anthropic",
    knownModels: ["claude-sonnet-5", "claude-opus-5", "claude-haiku-4-5"],
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    api: "responses",
    knownModels: ["gpt-5", "gpt-5-mini", "o3"],
  },
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    api: "chat",
    knownModels: [
      "anthropic/claude-sonnet-4",
      "openai/gpt-5",
      "moonshotai/kimi-k2",
      "z-ai/glm-4.6",
    ],
  },
  ollama: {
    api: "chat",
    resolveApiKey: () => ollamaTarget().apiKey,
    resolveBaseURL: () => ollamaTarget().baseURL,
    knownModels: ["llama3.3", "qwen3-coder", "glm-4.6", "gpt-oss:120b"],
  },
  zai: {
    envKey: "Z_AI_API_KEY",
    baseURL: "https://api.z.ai/api/paas/v4",
    api: "chat",
    knownModels: ["glm-5.2", "glm-4.6", "glm-4.5-air"],
  },
  moonshot: {
    envKey: "MOONSHOT_API_KEY",
    baseURL: "https://api.moonshot.ai/v1",
    api: "chat",
    knownModels: ["kimi-k2", "kimi-k2-thinking", "moonshot-v1-128k"],
  },
  opencode: {
    envKey: "OPENCODE_API_KEY",
    baseURL: "https://opencode.ai/zen/v1",
    api: "chat",
    knownModels: ["claude-sonnet-4", "gpt-5", "kimi-k2"],
  },
  codex: {
    baseURL: "https://chatgpt.com/backend-api/codex",
    api: "responses",
    headers: {
      originator: "haxford",
      "OpenAI-Beta": "responses=experimental",
    },
    resolveApiKey: () => readCodexAuth().accessToken,
    resolveHeaders: () => {
      const auth = tryReadCodexAuth()
      return auth?.accountId
        ? { "chatgpt-account-id": auth.accountId }
        : undefined
    },
    knownModels: ["gpt-5-codex", "gpt-5"],
  },
}

/** Alternative names for a provider. Not listed in the model picker. */
const ALIASES: Record<string, string> = {
  kimi: "moonshot",
}

/** Providers we know how to build, for error messages. */
const KNOWN = [...Object.keys(PROVIDERS), ...Object.keys(ALIASES)]
  .sort()
  .join(", ")

function lookup(provider: string): ProviderDef | undefined {
  const target = ALIASES[provider] ?? provider
  return PROVIDERS[target]
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Split "provider/model" on the first slash — model ids may themselves
 * contain slashes (e.g. "openrouter/anthropic/claude-sonnet-4").
 */
export function parseModelSpec(spec: string): {
  provider: string
  modelID: string
} {
  const slash = spec.indexOf("/")
  if (slash <= 0 || slash === spec.length - 1) {
    throw new Error(
      `Invalid model spec ${JSON.stringify(spec)}: expected "provider/model", ` +
        `e.g. "${DEFAULT_MODEL_SPEC}".`,
    )
  }
  return { provider: spec.slice(0, slash), modelID: spec.slice(slash + 1) }
}

function isThenable(value: unknown): value is Promise<string | undefined> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  )
}

/** Credential sources in priority order. May throw (codex) or return async. */
/**
 * Last-resort credential lookup in opencode's store, under the name the user
 * wrote and then the canonical provider name (so `kimi/...` finds a
 * `moonshot` entry). Providers with their own `resolveApiKey` never reach
 * here: codex has its own auth file, and ollama's key is optional.
 */
function opencodeFallback(provider: string): string | undefined {
  const canonical = ALIASES[provider] ?? provider
  return (
    readOpencodeApiKey(provider) ??
    (canonical === provider ? undefined : readOpencodeApiKey(canonical))
  )
}

function credentialOf(
  def: ProviderDef,
  provider: string,
  config?: HaxfordConfig,
): Promise<string | undefined> | string | undefined {
  const override = config?.providers?.[provider]?.apiKey?.trim()
  if (override) return override
  if (def.resolveApiKey) return def.resolveApiKey()
  const fromEnv = def.envKey ? env(def.envKey) : undefined
  if (fromEnv) return fromEnv
  return opencodeFallback(provider)
}

function missingKeyError(def: ProviderDef, provider: string): Error {
  const where = def.envKey
    ? `Set ${def.envKey} in the environment, providers.${provider}.apiKey in config, ` +
      `or add an { "type": "api", "key": … } entry for ${JSON.stringify(provider)} ` +
      `in opencode's auth store (${opencodeAuthPath()}).`
    : `Set providers.${provider}.apiKey in config.`
  return new Error(
    `Missing API key for provider ${JSON.stringify(provider)}. ${where}`,
  )
}

function construct(
  def: ProviderDef,
  provider: string,
  modelID: string,
  apiKey: string,
  config?: HaxfordConfig,
): LanguageModel {
  const override = config?.providers?.[provider]
  const baseURL =
    override?.baseURL?.trim() || def.resolveBaseURL?.() || def.baseURL

  const headers = { ...def.headers, ...def.resolveHeaders?.(apiKey) }

  const settings = {
    apiKey,
    ...(baseURL ? { baseURL } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  }

  switch (def.api) {
    case "anthropic":
      return createAnthropic(settings)(modelID)
    case "responses":
      return createOpenAI(settings).responses(modelID)
    case "chat":
      return createOpenAI(settings).chat(modelID)
  }
}

function defFor(spec: string): { def: ProviderDef; provider: string; modelID: string } {
  const { provider, modelID } = parseModelSpec(spec)
  const def = lookup(provider)
  if (!def) {
    throw new Error(
      `Unknown provider ${JSON.stringify(provider)} in model spec ` +
        `${JSON.stringify(spec)}. Known providers: ${KNOWN}.`,
    )
  }
  // Config overrides are keyed by the name the user wrote.
  return { def, provider, modelID }
}

/**
 * Resolve a "provider/model" spec to an AI SDK language model.
 *
 * The API key comes from `config.providers[provider].apiKey` when set,
 * otherwise from the provider's own credential source (env var, local daemon,
 * or codex CLI login). An optional `baseURL` override is passed through for
 * proxies and gateways.
 *
 * Throws on an unknown provider or a missing key — these are wiring
 * (programmer/config) errors, not model-visible tool failures.
 */
export function resolveModel(
  spec: string,
  config?: HaxfordConfig,
): LanguageModel {
  const { def, provider, modelID } = defFor(spec)

  const credential = credentialOf(def, provider, config)
  if (isThenable(credential)) {
    throw new Error(
      `Provider ${JSON.stringify(provider)} resolves its credentials ` +
        `asynchronously. Use resolveModelAsync() instead of resolveModel().`,
    )
  }
  if (!credential) throw missingKeyError(def, provider)

  return construct(def, provider, modelID, credential, config)
}

/** As `resolveModel`, but awaits providers with async credential lookup. */
export async function resolveModelAsync(
  spec: string,
  config?: HaxfordConfig,
): Promise<LanguageModel> {
  const { def, provider, modelID } = defFor(spec)

  const credential = await credentialOf(def, provider, config)
  if (!credential) throw missingKeyError(def, provider)

  return construct(def, provider, modelID, credential, config)
}

/** Default "provider/model" spec: HAXFORD_MODEL, else the built-in default. */
export function defaultModelSpec(): string {
  return env("HAXFORD_MODEL") ?? DEFAULT_MODEL_SPEC
}

/* -------------------------------------------------------------------------- */
/* Model listing                                                               */
/* -------------------------------------------------------------------------- */

/** Whether this provider could produce a credential right now. */
function isAvailable(
  provider: string,
  def: ProviderDef,
  config?: HaxfordConfig,
): boolean {
  try {
    const credential = credentialOf(def, provider, config)
    // An async source cannot be probed synchronously; assume unavailable
    // rather than claiming a credential we have not seen.
    if (isThenable(credential)) return false
    return Boolean(credential)
  } catch {
    // e.g. codex with no auth.json.
    return false
  }
}

/**
 * Every model we know about as a "provider/model" spec, flagged with whether
 * its provider currently has credentials. Feeds the TUI model picker.
 */
export function listKnownModels(
  config?: HaxfordConfig,
): { spec: string; available: boolean }[] {
  const out: { spec: string; available: boolean }[] = []
  const seen = new Set<string>()

  const add = (provider: string, model: string, available: boolean) => {
    const spec = `${provider}/${model}`
    if (seen.has(spec)) return
    seen.add(spec)
    out.push({ spec, available })
  }

  for (const [provider, def] of Object.entries(PROVIDERS)) {
    const available = isAvailable(provider, def, config)
    for (const model of def.knownModels ?? []) add(provider, model, available)
  }

  // Anything the user configured explicitly, including unknown providers.
  for (const [provider, entry] of Object.entries(config?.providers ?? {})) {
    const def = lookup(provider)
    const available = def
      ? isAvailable(provider, def, config)
      : Boolean(entry.apiKey?.trim())
    for (const model of entry.models ?? []) add(provider, model, available)
  }

  return out
}
