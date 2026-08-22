import { afterEach, describe, expect, test } from "bun:test"

import {
  APP_NAME,
  APP_URL,
  APP_VERSION,
  USER_AGENT,
  attributionHeaders,
  DEFAULT_MODEL_SPEC,
  fetchOpenRouterCatalog,
  parseModelSpec,
  refreshOpenRouterCatalog,
  resolveModel,
  verifyEndpoint,
  verifyProviderKey,
} from "../src/providers/index.ts"
import { VERSION as BANNER_VERSION } from "../src/tui/components/Banner.tsx"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Obvious fakes. Nothing in this file may hold a real credential — these
 * strings are shaped like keys only so the code under test treats them as
 * non-empty.
 */
const FAKE_KEY = "test-key-not-a-real-credential"

const realFetch = globalThis.fetch

interface Call {
  url: string
  method: string
  headers: Record<string, string>
}

/** Record every fetch and answer with `status`, without touching the network. */
function stubFetch(status = 200, body: unknown = { data: [] }): Call[] {
  const calls: Call[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(
      (init?.headers ?? {}) as Record<string, string>,
    )) {
      headers[k.toLowerCase()] = v
    }
    calls.push({
      url: String(input),
      method: String(init?.method ?? "GET"),
      headers,
    })
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as unknown as typeof fetch
  return calls
}

afterEach(() => {
  globalThis.fetch = realFetch
})

/* -------------------------------------------------------------------------- */
/* Endpoint + auth-header shape, per provider                                  */
/* -------------------------------------------------------------------------- */

/**
 * The contract each provider's verification request must satisfy. A wrong
 * path or the wrong auth header is indistinguishable from a bad key in the
 * dialog ("the provider rejected the key"), so it is pinned here.
 */
const ENDPOINTS: Array<{
  provider: string
  url: string
  auth: [header: string, value: string]
  extra?: Record<string, string>
}> = [
  {
    provider: "anthropic",
    url: "https://api.anthropic.com/v1/models",
    auth: ["x-api-key", FAKE_KEY],
    extra: { "anthropic-version": "2023-06-01" },
  },
  {
    provider: "openai",
    url: "https://api.openai.com/v1/models",
    auth: ["authorization", `Bearer ${FAKE_KEY}`],
  },
  {
    provider: "openrouter",
    url: "https://openrouter.ai/api/v1/key",
    auth: ["authorization", `Bearer ${FAKE_KEY}`],
  },
  {
    provider: "zai",
    url: "https://api.z.ai/api/paas/v4/models",
    auth: ["authorization", `Bearer ${FAKE_KEY}`],
  },
  {
    provider: "moonshot",
    url: "https://api.moonshot.ai/v1/models",
    auth: ["authorization", `Bearer ${FAKE_KEY}`],
  },
  {
    provider: "opencode",
    url: "https://opencode.ai/zen/v1/models",
    auth: ["authorization", `Bearer ${FAKE_KEY}`],
  },
]

function lower(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  )
}

describe("verifyEndpoint: URL and auth header per provider", () => {
  for (const { provider, url, auth, extra } of ENDPOINTS) {
    test(`${provider} → ${url}`, () => {
      const endpoint = verifyEndpoint(provider, FAKE_KEY)
      expect(endpoint?.url).toBe(url)

      const headers = lower(endpoint?.headers ?? {})
      expect(headers[auth[0]]).toBe(auth[1])
      for (const [key, value] of Object.entries(extra ?? {})) {
        expect(headers[key.toLowerCase()]).toBe(value)
      }
    })
  }

  test("anthropic uses x-api-key, never a bearer token", () => {
    const headers = lower(verifyEndpoint("anthropic", FAKE_KEY)?.headers ?? {})
    expect(headers["authorization"]).toBeUndefined()
  })

  test("openrouter hits the key-info endpoint, not /models", () => {
    expect(verifyEndpoint("openrouter", FAKE_KEY)?.url).toBe(
      "https://openrouter.ai/api/v1/key",
    )
  })

  test("an alias resolves to its canonical provider's endpoint", () => {
    expect(verifyEndpoint("kimi", FAKE_KEY)?.url).toBe(
      "https://api.moonshot.ai/v1/models",
    )
  })

  test("a baseURL override replaces the default base", () => {
    expect(
      verifyEndpoint("openai", FAKE_KEY, "https://gateway.internal/v1")?.url,
    ).toBe("https://gateway.internal/v1/models")
  })

  test("a trailing slash on an override does not double up", () => {
    expect(
      verifyEndpoint("openai", FAKE_KEY, "https://gateway.internal/v1/")?.url,
    ).toBe("https://gateway.internal/v1/models")
  })

  test("an unknown provider with no base has no endpoint to check", () => {
    expect(verifyEndpoint("some-custom-gateway", FAKE_KEY)).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* The request that actually goes out                                          */
/* -------------------------------------------------------------------------- */

describe("verifyProviderKey: the request on the wire", () => {
  for (const { provider, url, auth } of ENDPOINTS) {
    test(`${provider} issues one authenticated GET to ${url}`, async () => {
      const calls = stubFetch(200)

      await expect(verifyProviderKey(provider, FAKE_KEY)).resolves.toEqual({
        ok: true,
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(url)
      expect(calls[0]?.method).toBe("GET")
      expect(calls[0]?.headers[auth[0]]).toBe(auth[1])
    })
  }

  test("openai is actually verified — a bad key is not silently accepted", async () => {
    const calls = stubFetch(401)
    const result = await verifyProviderKey("openai", FAKE_KEY)

    expect(calls).toHaveLength(1)
    expect(result.ok).toBe(false)
    expect(result.ok === false && result.error).toMatch(/rejected the key/)
  })

  test("a 403 reads as a rejection, not a transport failure", async () => {
    stubFetch(403)
    const result = await verifyProviderKey("anthropic", FAKE_KEY)
    expect(result.ok === false && result.error).toMatch(/HTTP 403/)
  })

  test("an unexpected status names the URL it came from", async () => {
    stubFetch(500)
    const result = await verifyProviderKey("moonshot", FAKE_KEY)
    expect(result.ok === false && result.error).toMatch(
      /HTTP 500.*api\.moonshot\.ai/,
    )
  })

  test("a network failure is reported, never thrown", async () => {
    globalThis.fetch = (() => {
      throw new Error("ECONNRESET")
    }) as unknown as typeof fetch

    const result = await verifyProviderKey("openai", FAKE_KEY)
    expect(result.ok === false && result.error).toMatch(/Network error/)
  })

  test("codex is trusted without any request", async () => {
    const calls = stubFetch(200)
    await expect(verifyProviderKey("codex", FAKE_KEY)).resolves.toEqual({
      ok: true,
    })
    expect(calls).toHaveLength(0)
  })

  test("an empty key is rejected before any request", async () => {
    const calls = stubFetch(200)
    const result = await verifyProviderKey("openai", "   ")
    expect(result.ok).toBe(false)
    expect(calls).toHaveLength(0)
  })
})

/* -------------------------------------------------------------------------- */
/* Attribution                                                                 */
/* -------------------------------------------------------------------------- */

describe("provider attribution", () => {
  test("openrouter is attributed by HTTP-Referer and X-Title", () => {
    expect(attributionHeaders("openrouter")).toEqual({
      "HTTP-Referer": "https://haxford.dev/haxford-agent",
      "X-Title": "Haxford-Agent",
    })
  })

  test("every other provider carries a versioned User-Agent with a URL", () => {
    for (const provider of ["anthropic", "openai", "zai", "moonshot", "ollama"]) {
      expect(attributionHeaders(provider)).toEqual({
        "User-Agent": `Haxford-Agent/${APP_VERSION} (+${APP_URL})`,
      })
    }
    expect(USER_AGENT).toBe(`${APP_NAME}/${APP_VERSION} (+${APP_URL})`)
  })

  test("the returned object is a fresh copy callers may mutate", () => {
    const first = attributionHeaders("openrouter")
    first["X-Title"] = "mutated"
    expect(attributionHeaders("openrouter")["X-Title"]).toBe("Haxford-Agent")
  })

  test("verification requests are attributed too", async () => {
    const calls = stubFetch(200)
    await verifyProviderKey("openrouter", FAKE_KEY)
    expect(calls[0]?.headers["http-referer"]).toBe(APP_URL)
    expect(calls[0]?.headers["x-title"]).toBe(APP_NAME)

    calls.length = 0
    await verifyProviderKey("anthropic", FAKE_KEY)
    expect(calls[0]?.headers["user-agent"]).toBe(USER_AGENT)
    expect(calls[0]?.headers["http-referer"]).toBeUndefined()
  })

  test("the catalog fetch is attributed to the app", async () => {
    const calls = stubFetch(200, { data: [] })
    await refreshOpenRouterCatalog()

    expect(calls).toHaveLength(1)
    expect(calls[0]?.headers["http-referer"]).toBe(APP_URL)
    expect(calls[0]?.headers["x-title"]).toBe(APP_NAME)
  })

  test("the version is not duplicated out of step with the banner", async () => {
    const pkg = (await Bun.file("package.json").json()) as { version: string }
    expect(APP_VERSION).toBe(pkg.version)
    expect(BANNER_VERSION).toBe(APP_VERSION)
  })
})

/* -------------------------------------------------------------------------- */
/* Catalog refresh after /connect                                              */
/* -------------------------------------------------------------------------- */

describe("refreshOpenRouterCatalog", () => {
  const model = (id: string) => ({
    id,
    name: id,
    context_length: 128_000,
    supported_parameters: ["tools"],
  })

  test("bypasses the cache so a new key's models appear without a restart", async () => {
    const calls = stubFetch(200, { data: [model("vendor/before")] })

    const first = await fetchOpenRouterCatalog()
    expect(first.map((m) => m.spec)).toEqual(["openrouter/vendor/before"])
    expect(calls).toHaveLength(1)

    // A second read inside the TTL is served from cache — no request.
    await fetchOpenRouterCatalog()
    expect(calls).toHaveLength(1)

    // /connect saved a new key: the refresh must go back to the network.
    globalThis.fetch = realFetch
    const afterCalls = stubFetch(200, { data: [model("vendor/after")] })
    const refreshed = await refreshOpenRouterCatalog()

    expect(afterCalls).toHaveLength(1)
    expect(refreshed.map((m) => m.spec)).toEqual(["openrouter/vendor/after"])

    // …and the new list is what later cached reads return.
    expect((await fetchOpenRouterCatalog()).map((m) => m.spec)).toEqual([
      "openrouter/vendor/after",
    ])
    expect(afterCalls).toHaveLength(1)
  })

  test("a failed refresh is not cached", async () => {
    // The refresh clears the cache before it fetches, so a failure here
    // leaves nothing cached — the next read has to go back to the network.
    globalThis.fetch = (() => {
      throw new Error("offline")
    }) as unknown as typeof fetch
    expect(await refreshOpenRouterCatalog()).toEqual([])

    const calls = stubFetch(200, { data: [model("vendor/recovered")] })
    expect((await fetchOpenRouterCatalog()).map((m) => m.spec)).toEqual([
      "openrouter/vendor/recovered",
    ])
    expect(calls).toHaveLength(1)
  })
})

/* -------------------------------------------------------------------------- */
/* The out-of-box default                                                      */
/* -------------------------------------------------------------------------- */

describe("DEFAULT_MODEL_SPEC", () => {
  test("names a provider the registry can actually build", () => {
    const { provider, modelID } = parseModelSpec(DEFAULT_MODEL_SPEC)
    expect(modelID).not.toBe("")

    // An unknown provider throws before resolution ever looks for a key, so a
    // default spec that names one fails on the very first turn of a fresh
    // install — with no config to fall back on.
    expect(() =>
      resolveModel(DEFAULT_MODEL_SPEC, {
        providers: { [provider]: { apiKey: "test-key-not-a-real-credential" } },
      }),
    ).not.toThrow()
  })
})
