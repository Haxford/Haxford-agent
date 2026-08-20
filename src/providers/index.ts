import { createAnthropic } from "@ai-sdk/anthropic"
import { createOpenAI } from "@ai-sdk/openai"
import type { LanguageModel } from "ai"
import type { HaxfordConfig } from "../types/config.ts"

/** Used when neither config nor HAXFORD_MODEL specifies a model. */
export const DEFAULT_MODEL_SPEC = "anthropic/claude-sonnet-5"

interface ProviderSettings {
  apiKey: string
  baseURL?: string
}

interface ProviderDef {
  /** Environment variable holding the API key for this provider. */
  envKey: string
  build(settings: ProviderSettings, modelID: string): LanguageModel
}

const PROVIDERS: Record<string, ProviderDef> = {
  anthropic: {
    envKey: "ANTHROPIC_API_KEY",
    build: (settings, modelID) => createAnthropic(settings)(modelID),
  },
  openai: {
    envKey: "OPENAI_API_KEY",
    build: (settings, modelID) => createOpenAI(settings)(modelID),
  },
}

/** Providers we know how to build, for error messages. */
const KNOWN = Object.keys(PROVIDERS).sort().join(", ")

/** Treat blank/whitespace-only env values as unset. */
function env(name: string): string | undefined {
  const value = Bun.env[name]
  if (value === undefined) return undefined
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

/**
 * Split "provider/model" on the first slash — model ids may themselves
 * contain slashes (e.g. "openrouter"-style ids proxied via a baseURL).
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

/**
 * Resolve a "provider/model" spec to an AI SDK language model.
 *
 * The API key comes from `config.providers[provider].apiKey` when set,
 * otherwise from the provider's environment variable. An optional
 * `baseURL` override is passed through for proxies and gateways.
 *
 * Throws on an unknown provider or a missing key — these are wiring
 * (programmer/config) errors, not model-visible tool failures.
 */
export function resolveModel(
  spec: string,
  config?: HaxfordConfig,
): LanguageModel {
  const { provider, modelID } = parseModelSpec(spec)

  const def = PROVIDERS[provider]
  if (!def) {
    throw new Error(
      `Unknown provider ${JSON.stringify(provider)} in model spec ` +
        `${JSON.stringify(spec)}. Known providers: ${KNOWN}.`,
    )
  }

  const override = config?.providers?.[provider]
  const apiKey = override?.apiKey?.trim() || env(def.envKey)
  if (!apiKey) {
    throw new Error(
      `Missing API key for provider ${JSON.stringify(provider)}. ` +
        `Set ${def.envKey} in the environment or providers.${provider}.apiKey in config.`,
    )
  }

  const baseURL = override?.baseURL?.trim()
  return def.build(baseURL ? { apiKey, baseURL } : { apiKey }, modelID)
}

/** Default "provider/model" spec: HAXFORD_MODEL, else the built-in default. */
export function defaultModelSpec(): string {
  return env("HAXFORD_MODEL") ?? DEFAULT_MODEL_SPEC
}
