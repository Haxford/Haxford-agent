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
 * Validate that a provider base URL uses HTTPS, or is a local address
 * where HTTP is acceptable.
 *
 * A non-HTTPS URL for a remote provider sends the API key in cleartext
 * over the wire. Local addresses (localhost, 127.0.0.1, 0.0.0.0, [::1],
 * or a bare host without a dot that resolves locally) are allowed over
 * HTTP for dev servers like Ollama.
 *
 * Returns null when the URL is safe, or an error string explaining why
 * it is not — the caller surfaces it as a config error, never embedding
 * the URL in a thrown error the model might see.
 */
export function validateBaseURL(url: string | undefined): string | null {
  if (!url || url.trim().length === 0) return null
  const trimmed = url.trim()
  if (trimmed.startsWith("https://")) return null
  if (trimmed.startsWith("http://")) {
    const rest = trimmed.slice("http://".length)
    // Strip the path and port to get the hostname.
    const hostport = rest.split("/")[0] ?? ""
    // Handle IPv6 bracket notation: [::1]:8080 → [::1]
    let hostname: string
    if (hostport.startsWith("[")) {
      const close = hostport.indexOf("]")
      hostname = close > 0 ? hostport.slice(1, close) : hostport
    } else {
      hostname = hostport.split(":")[0] ?? ""
    }
    if (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "::1" ||
      hostname === ""
    ) {
      return null
    }
    return `Provider base URL ${JSON.stringify(trimmed)} uses HTTP for a non-local host. ` +
      `Use HTTPS to avoid sending API keys in cleartext.`
  }
  return `Provider base URL ${JSON.stringify(trimmed)} has no http(s) scheme. ` +
    `Use a full https:// URL.`
}

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
  /**
   * Liveness check for a provider whose endpoint may simply not be running.
   * When present, availability requires it to pass *in addition* to a
   * credential — a key alone proves nothing about a local daemon.
   */
  probe?: (target: string) => Promise<boolean>
  /** The endpoint `probe` targets; doubles as the cache key for its result. */
  probeTarget?: () => string
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

/** Long enough to survive a burst of picker renders, short enough that
 *  starting the daemon is reflected the next time the picker opens. */
const PROBE_TTL_MS = 30_000
const OLLAMA_PROBE_TIMEOUT_MS = 1_500

/**
 * Ask an ollama server for its model list. Any HTTP answer proves a server is
 * listening; a refused connection, DNS failure or timeout means there is not
 * one, and the models it would serve are dead entries in the picker.
 *
 * Never throws — an unreachable host is a normal outcome, not an error.
 */
async function probeOllama(target: string): Promise<boolean> {
  const root = target.replace(/\/v1\/?$/, "")
  const key = env("OLLAMA_API_KEY")
  try {
    const response = await fetch(`${root}/api/tags`, {
      method: "GET",
      ...(key ? { headers: { Authorization: `Bearer ${key}` } } : {}),
      signal: AbortSignal.timeout(OLLAMA_PROBE_TIMEOUT_MS),
    })
    // We only care that something answered; drop the body promptly.
    await response.body?.cancel()
    return response.ok
  } catch {
    return false
  }
}

/** Clear an in-flight slot once its promise settles, and never let the
 *  bookkeeping chain surface as an unhandled rejection. */
function whenSettled(promise: Promise<unknown>, clear: () => void): void {
  void promise.finally(clear).catch(() => {})
}

interface ProbeResult {
  at: number
  target: string
  reachable: boolean
}

const probeCache = new Map<string, ProbeResult>()
const probeInFlight = new Map<string, Promise<boolean>>()

/** A probe result we can trust right now, or undefined if we must go look. */
function cachedProbe(provider: string, target: string): boolean | undefined {
  const hit = probeCache.get(provider)
  if (!hit || hit.target !== target) return undefined
  if (Date.now() - hit.at > PROBE_TTL_MS) return undefined
  return hit.reachable
}

/** Run (or join) the probe for a provider, caching the outcome. */
function runProbe(
  provider: string,
  probe: (target: string) => Promise<boolean>,
  target: string,
): Promise<boolean> {
  const existing = probeInFlight.get(provider)
  if (existing) return existing

  const started = (async (): Promise<boolean> => {
    let reachable = false
    try {
      reachable = await probe(target)
    } catch {
      reachable = false
    }
    probeCache.set(provider, { at: Date.now(), target, reachable })
    return reachable
  })()

  probeInFlight.set(provider, started)
  whenSettled(started, () => {
    if (probeInFlight.get(provider) === started) probeInFlight.delete(provider)
  })
  return started
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    api: "anthropic",
    knownModels: [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "claude-fable-5",
    ],
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    api: "responses",
    knownModels: ["gpt-5.2", "gpt-5", "gpt-5-mini", "gpt-5-nano", "o3", "o4-mini"],
  },
  // Curated from openrouter's public /models catalog: flagships, a budget
  // tier, and free slugs — every id verified present and tool-capable. The
  // live catalog (fetchOpenRouterCatalog) is the complete list.
  openrouter: {
    envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1",
    api: "chat",
    headers: {
      "HTTP-Referer": "https://haxford.dev/haxford-agent",
      "X-Title": "Haxford Agent",
    },
    knownModels: [
      // flagship / frontier coding
      "anthropic/claude-sonnet-5",
      "anthropic/claude-opus-5",
      "anthropic/claude-haiku-4.5",
      "openai/gpt-5.2-codex",
      "openai/gpt-5.2",
      "openai/o3",
      "moonshotai/kimi-k2-thinking",
      "z-ai/glm-4.6",
      // budget
      "openai/gpt-5-mini",
      "openai/gpt-5-nano",
      "deepseek/deepseek-v3.2",
      "deepseek/deepseek-v4-flash",
      "qwen/qwen3-coder",
      "google/gemini-3.5-flash-lite",
      "mistralai/mistral-small-3.2-24b-instruct",
      "mistralai/mistral-nemo",
      "meta-llama/llama-4-scout",
      // free
      "z-ai/glm-5.2:free",
      "nvidia/nemotron-3-super-120b-a12b:free",
      "google/gemma-4-31b-it:free",
    ],
  },
  ollama: {
    api: "chat",
    resolveApiKey: () => ollamaTarget().apiKey,
    resolveBaseURL: () => ollamaTarget().baseURL,
    probe: probeOllama,
    probeTarget: () => ollamaTarget().baseURL,
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
  // Verified against the zen gateway's own /models listing.
  opencode: {
    envKey: "OPENCODE_API_KEY",
    baseURL: "https://opencode.ai/zen/v1",
    api: "chat",
    knownModels: [
      "claude-sonnet-5",
      "claude-opus-5",
      "claude-haiku-4-5",
      "gpt-5.2-codex",
      "gpt-5.2",
      "gpt-5.1-codex-max",
      "gemini-3.5-flash",
      "grok-4.6",
      "kimi-k3",
      "glm-5.2",
      "deepseek-v4-pro",
      "deepseek-v4-flash-free",
      "nemotron-3-ultra-free",
    ],
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

  // Enforce HTTPS for non-local providers so a misconfigured baseURL can
  // never send the API key in cleartext. This is a config/wiring error,
  // not a model-visible tool failure, so it throws.
  const urlError = validateBaseURL(baseURL)
  if (urlError) throw new Error(urlError)

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
function hasCredential(
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
 * Sync availability. A probed provider counts as available only once a probe
 * has actually confirmed its endpoint — an unconfirmed one reads unavailable
 * and a probe is started so the next call can answer truthfully. Better to
 * under-report for one render than to offer a model that cannot answer.
 */
function isAvailable(
  provider: string,
  def: ProviderDef,
  config?: HaxfordConfig,
): boolean {
  if (!hasCredential(provider, def, config)) return false
  const { probe, probeTarget } = def
  if (!probe || !probeTarget) return true

  const target = probeTarget()
  const cached = cachedProbe(provider, target)
  if (cached !== undefined) return cached
  void runProbe(provider, probe, target)
  return false
}

/** As `isAvailable`, but waits for the probe instead of assuming the worst. */
async function isAvailableAsync(
  provider: string,
  def: ProviderDef,
  config?: HaxfordConfig,
): Promise<boolean> {
  if (!hasCredential(provider, def, config)) return false
  const { probe, probeTarget } = def
  if (!probe || !probeTarget) return true

  const target = probeTarget()
  return cachedProbe(provider, target) ?? (await runProbe(provider, probe, target))
}

export interface KnownModel {
  spec: string
  available: boolean
}

/** One provider's offered models, paired with how to judge its availability. */
interface ProviderModels {
  provider: string
  def?: ProviderDef
  /** For providers only the user knows about: a configured key is all we have. */
  configuredKey?: boolean
  models: string[]
}

function providerModels(config?: HaxfordConfig): ProviderModels[] {
  const groups: ProviderModels[] = []

  for (const [provider, def] of Object.entries(PROVIDERS)) {
    groups.push({ provider, def, models: def.knownModels ?? [] })
  }

  // Anything the user configured explicitly, including unknown providers.
  for (const [provider, entry] of Object.entries(config?.providers ?? {})) {
    const models = entry.models ?? []
    if (models.length === 0) continue
    const def = lookup(provider)
    groups.push({
      provider,
      ...(def ? { def } : { configuredKey: Boolean(entry.apiKey?.trim()) }),
      models,
    })
  }

  return groups
}

function assemble(
  groups: { group: ProviderModels; available: boolean }[],
): KnownModel[] {
  const out: KnownModel[] = []
  const seen = new Set<string>()
  for (const { group, available } of groups) {
    for (const model of group.models) {
      const spec = `${group.provider}/${model}`
      if (seen.has(spec)) continue
      seen.add(spec)
      out.push({ spec, available })
    }
  }
  return out
}

/**
 * Every model we know about as a "provider/model" spec, flagged with whether
 * its provider is usable right now. Feeds the TUI model picker.
 *
 * Prefer `listKnownModelsAsync` where the caller can await: providers backed
 * by a local server (ollama) can only be confirmed by asking, and this sync
 * form reports them unavailable until a probe has come back.
 */
export function listKnownModels(config?: HaxfordConfig): KnownModel[] {
  return assemble(
    providerModels(config).map((group) => ({
      group,
      available: group.def
        ? isAvailable(group.provider, group.def, config)
        : Boolean(group.configuredKey),
    })),
  )
}

/** As `listKnownModels`, but waits for reachability probes to settle. */
export async function listKnownModelsAsync(
  config?: HaxfordConfig,
): Promise<KnownModel[]> {
  const resolved = await Promise.all(
    providerModels(config).map(async (group) => ({
      group,
      available: group.def
        ? await isAvailableAsync(group.provider, group.def, config)
        : Boolean(group.configuredKey),
    })),
  )
  return assemble(resolved)
}

/* -------------------------------------------------------------------------- */
/* Live openrouter catalog                                                     */
/* -------------------------------------------------------------------------- */

/** One entry of openrouter's public catalog, in the units a picker wants. */
export interface CatalogModel {
  spec: string
  label: string
  contextLength?: number
  /** USD per million prompt tokens. 0 for free models. */
  promptPricePerMtok?: number
  /** USD per million completion tokens. 0 for free models. */
  completionPricePerMtok?: number
}

const CATALOG_URL = "https://openrouter.ai/api/v1/models"
const CATALOG_TTL_MS = 60 * 60 * 1000
const CATALOG_TIMEOUT_MS = 10_000

let catalogCache: { at: number; models: CatalogModel[] } | undefined
let catalogInFlight: Promise<CatalogModel[]> | undefined

/** Non-negative finite number from a string or number field, else undefined. */
function numeric(value: unknown): number | undefined {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

/** Per-token USD to per-million USD, without float dust like 0.30000000000004. */
function perMtok(perToken: number | undefined): number | undefined {
  if (perToken === undefined) return undefined
  return Math.round(perToken * 1e6 * 1e6) / 1e6
}

function toCatalogModel(raw: unknown): CatalogModel | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const entry = raw as {
    id?: unknown
    name?: unknown
    context_length?: unknown
    pricing?: unknown
  }

  const id = typeof entry.id === "string" ? entry.id.trim() : ""
  if (id === "") return undefined

  const contextLength = numeric(entry.context_length)
  const pricing =
    typeof entry.pricing === "object" && entry.pricing !== null
      ? (entry.pricing as Record<string, unknown>)
      : undefined
  const prompt = perMtok(numeric(pricing?.["prompt"]))
  const completion = perMtok(numeric(pricing?.["completion"]))

  // Obviously broken: nothing priced and no context window to speak of.
  if (prompt === undefined && completion === undefined && !contextLength) {
    return undefined
  }

  const label = typeof entry.name === "string" && entry.name.trim() !== ""
    ? entry.name.trim()
    : id

  return {
    spec: `openrouter/${id}`,
    label,
    ...(contextLength ? { contextLength } : {}),
    ...(prompt !== undefined ? { promptPricePerMtok: prompt } : {}),
    ...(completion !== undefined ? { completionPricePerMtok: completion } : {}),
  }
}

/**
 * openrouter's full public catalog — hundreds of models across every vendor it
 * fronts. No key required. Cached in-module for an hour; concurrent callers
 * share one request.
 *
 * Never throws: on any failure (offline, timeout, bad payload) this returns an
 * empty array and the caller falls back to the curated `knownModels` list. A
 * failure is not cached, so the next call retries.
 */
export async function fetchOpenRouterCatalog(): Promise<CatalogModel[]> {
  if (catalogCache && Date.now() - catalogCache.at < CATALOG_TTL_MS) {
    return catalogCache.models
  }
  const existing = catalogInFlight
  if (existing) return existing

  const started = (async (): Promise<CatalogModel[]> => {
    try {
      const response = await fetch(CATALOG_URL, {
        signal: AbortSignal.timeout(CATALOG_TIMEOUT_MS),
      })
      if (!response.ok) return []

      const body: unknown = await response.json()
      const data =
        typeof body === "object" && body !== null
          ? (body as { data?: unknown }).data
          : undefined
      if (!Array.isArray(data)) return []

      const models: CatalogModel[] = []
      for (const raw of data) {
        const model = toCatalogModel(raw)
        if (model) models.push(model)
      }

      if (models.length > 0) catalogCache = { at: Date.now(), models }
      return models
    } catch {
      return []
    }
  })()

  catalogInFlight = started
  whenSettled(started, () => {
    if (catalogInFlight === started) catalogInFlight = undefined
  })
  return started
}
