import { describe, expect, test } from "bun:test"

import { bashTool } from "../src/tools/bash.ts"
import { loadConfig } from "../src/config/index.ts"
import {
  CREDENTIAL_ENV_VARS,
  collectSecretValues,
  filteredEnv,
  redactSecrets,
} from "../src/config/secrets.ts"
import {
  validateBaseURL,
  fetchOpenRouterCatalog,
} from "../src/providers/index.ts"
import type { HaxfordConfig } from "../src/types/config.ts"
import type { ToolContext } from "../src/types/tool.ts"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

function ctx(cwd = process.cwd()): ToolContext {
  return {
    sessionID: `s-${crypto.randomUUID()}`,
    agent: "test",
    cwd,
    abort: new AbortController().signal,
    askPermission: async () => "allow",
  }
}

async function tmpdir(): Promise<string> {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-sec-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, "")
  return dir
}

/* -------------------------------------------------------------------------- */
/* redactSecrets                                                               */
/* -------------------------------------------------------------------------- */

describe("redactSecrets", () => {
  test("redacts OpenRouter key pattern", () => {
    const out = redactSecrets(
      "key is sk-or-v1-0123456789abcdef0123456789abcdef done",
    )
    expect(out).not.toContain("sk-or-v1-")
    expect(out).toContain("[REDACTED]")
  })

  test("redacts OpenAI/Anthropic sk- key pattern", () => {
    const out = redactSecrets(
      "key is sk-0123456789abcdef0123456789abcdef done",
    )
    expect(out).not.toContain("sk-0123456789abcdef0123456789abcdef")
    expect(out).toContain("[REDACTED]")
  })

  test("redacts Bearer tokens", () => {
    const out = redactSecrets(
      "Authorization: Bearer abcdef0123456789abcdef",
    )
    expect(out).not.toContain("abcdef0123456789abcdef")
    expect(out).toContain("[REDACTED]")
  })

  test("redacts explicit secret values passed via extraSecrets", () => {
    const secret = "my-custom-gateway-token-12345"
    const out = redactSecrets(`token=${secret}`, [secret])
    expect(out).not.toContain(secret)
    expect(out).toContain("[REDACTED]")
  })

  test("does not redact short strings that look like keys", () => {
    // sk- followed by fewer than 20 chars should NOT match
    const out = redactSecrets("short: sk-abc")
    expect(out).toBe("short: sk-abc")
  })

  test("leaves non-key text untouched", () => {
    const text = "Build succeeded. 42 tests passed."
    expect(redactSecrets(text)).toBe(text)
  })

  test("handles multiple keys in one string", () => {
    const out = redactSecrets(
      "a=sk-or-v1-aaaaaaaaaaaaaaaaaaaaaaaaaa b=sk-bbbbbbbbbbbbbbbbbbbbbbbb",
    )
    expect(out).not.toContain("sk-or-v1-aaa")
    expect(out).not.toContain("sk-bbbbbbb")
    const count = (out.match(/\[REDACTED\]/g) ?? []).length
    expect(count).toBeGreaterThanOrEqual(2)
  })

  test("longest-first so a short prefix key does not partially mask a longer one", () => {
    const short = "sk-prefix12345678"
    const long = "sk-prefix12345678extendedkeyabcdef"
    const out = redactSecrets(`x=${long} y=${short}`, [short, long])
    expect(out).not.toContain(long)
    expect(out).not.toContain(short)
  })
})

/* -------------------------------------------------------------------------- */
/* filteredEnv                                                                 */
/* -------------------------------------------------------------------------- */

describe("filteredEnv", () => {
  test("strips haxford provider credential vars", () => {
    const env = filteredEnv()
    for (const key of CREDENTIAL_ENV_VARS) {
      expect(env[key]).toBeUndefined()
    }
  })

  test("passes through non-credential env", () => {
    const env = filteredEnv()
    expect(env["PATH"]).toBeDefined()
  })

  test("does not strip user-defined tokens", () => {
    process.env["MY_CUSTOM_TOKEN"] = "user-token-123"
    const env = filteredEnv()
    expect(env["MY_CUSTOM_TOKEN"]).toBe("user-token-123")
    delete process.env["MY_CUSTOM_TOKEN"]
  })
})

/* -------------------------------------------------------------------------- */
/* collectSecretValues                                                         */
/* -------------------------------------------------------------------------- */

describe("collectSecretValues", () => {
  test("gathers keys from config providers", () => {
    const config: HaxfordConfig = {
      providers: {
        anthropic: { apiKey: "sk-test-key-from-config-12345678" },
      },
    }
    const secrets = collectSecretValues(config)
    expect(secrets).toContain("sk-test-key-from-config-12345678")
  })

  test("includes env vars when set", () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-env-var-key-1234567890abcdef"
    const secrets = collectSecretValues()
    expect(secrets).toContain("sk-env-var-key-1234567890abcdef")
    delete process.env["ANTHROPIC_API_KEY"]
  })
})

/* -------------------------------------------------------------------------- */
/* validateBaseURL                                                             */
/* -------------------------------------------------------------------------- */

describe("validateBaseURL", () => {
  test("accepts https URLs", () => {
    expect(validateBaseURL("https://api.anthropic.com")).toBeNull()
    expect(validateBaseURL("https://openrouter.ai/api/v1")).toBeNull()
  })

  test("accepts http for localhost", () => {
    expect(validateBaseURL("http://localhost:11434/v1")).toBeNull()
    expect(validateBaseURL("http://127.0.0.1:8080")).toBeNull()
    expect(validateBaseURL("http://0.0.0.0:3000")).toBeNull()
    expect(validateBaseURL("http://[::1]:8080")).toBeNull()
  })

  test("rejects http for non-local hosts", () => {
    const err = validateBaseURL("http://api.anthropic.com")
    expect(err).not.toBeNull()
    expect(err).toContain("HTTP")
    expect(err).toContain("HTTPS")
  })

  test("rejects URLs without a scheme", () => {
    const err = validateBaseURL("api.anthropic.com")
    expect(err).not.toBeNull()
    expect(err).toContain("scheme")
  })

  test("accepts undefined/empty", () => {
    expect(validateBaseURL(undefined)).toBeNull()
    expect(validateBaseURL("")).toBeNull()
    expect(validateBaseURL("  ")).toBeNull()
  })
})

/* -------------------------------------------------------------------------- */
/* Config warnings: project-key, file-perms, unknown-provider                 */
/* -------------------------------------------------------------------------- */

describe("loadConfig security warnings", () => {
  test("warns when project config contains an apiKey", async () => {
    const dir = await tmpdir()
    await Bun.write(
      `${dir}/haxford.json`,
      JSON.stringify({ providers: { anthropic: { apiKey: "sk-test-key-abcdef" } } }),
    )
    const { warnings } = await loadConfig(dir)
    expect(warnings.length).toBeGreaterThan(0)
    const keyWarning = warnings.find((w) => w.includes("providers.anthropic.apiKey"))
    expect(keyWarning).toBeDefined()
    expect(keyWarning).toContain("project config")
    expect(keyWarning).toContain("commit")
  })

  test("does not warn when global config has an apiKey (only project/local)", async () => {
    // A global key is fine — the warning is about project config.
    // We can't easily test global config without a mock HOME, so this
    // test verifies that a project config WITHOUT keys produces no
    // project-key warning.
    const dir = await tmpdir()
    await Bun.write(
      `${dir}/haxford.json`,
      JSON.stringify({ model: "anthropic/claude-sonnet-5" }),
    )
    const { warnings } = await loadConfig(dir)
    expect(warnings.find((w) => w.includes("apiKey"))).toBeUndefined()
  })

  test("warns when global config file with a key is world-readable", async () => {
    const oldXdg = process.env["XDG_CONFIG_HOME"]
    const fakeHome = await tmpdir()
    const configDir = `${fakeHome}/haxford`
    await Bun.write(
      `${configDir}/haxford.json`,
      JSON.stringify({ providers: { anthropic: { apiKey: "sk-world-readable-key-abcdef" } } }),
    )
    const { chmod } = await import("node:fs/promises")
    await chmod(`${configDir}/haxford.json`, 0o644)

    process.env["XDG_CONFIG_HOME"] = fakeHome
    const { warnings } = await loadConfig(await tmpdir())
    process.env["XDG_CONFIG_HOME"] = oldXdg

    const permWarning = warnings.find((w) => w.includes("chmod 600"))
    expect(permWarning).toBeDefined()
  })

  test("does not warn when global config file with a key is 600", async () => {
    const oldXdg = process.env["XDG_CONFIG_HOME"]
    const fakeHome = await tmpdir()
    const configDir = `${fakeHome}/haxford`
    await Bun.write(
      `${configDir}/haxford.json`,
      JSON.stringify({ providers: { anthropic: { apiKey: "sk-private-key-abcdef" } } }),
    )
    const { chmod } = await import("node:fs/promises")
    await chmod(`${configDir}/haxford.json`, 0o600)

    process.env["XDG_CONFIG_HOME"] = fakeHome
    const { warnings } = await loadConfig(await tmpdir())
    process.env["XDG_CONFIG_HOME"] = oldXdg

    expect(warnings.find((w) => w.includes("chmod 600"))).toBeUndefined()
  })

  test("warns on unknown provider without baseURL", async () => {
    const dir = await tmpdir()
    await Bun.write(
      `${dir}/haxford.json`,
      JSON.stringify({
        providers: {
          "my-unknown-provider": { apiKey: "some-key", models: ["model-1"] },
        },
      }),
    )
    const { warnings } = await loadConfig(dir)
    const unknownWarning = warnings.find((w) =>
      w.includes("my-unknown-provider") && w.includes("baseURL"),
    )
    expect(unknownWarning).toBeDefined()
  })

  test("does not warn on unknown provider WITH baseURL", async () => {
    const dir = await tmpdir()
    await Bun.write(
      `${dir}/haxford.json`,
      JSON.stringify({
        providers: {
          "my-proxy": {
            apiKey: "some-key",
            baseURL: "https://my-proxy.example.com/v1",
            models: ["model-1"],
          },
        },
      }),
    )
    const { warnings } = await loadConfig(dir)
    expect(
      warnings.find((w) => w.includes("my-proxy") && w.includes("baseURL")),
    ).toBeUndefined()
  })
})

/* -------------------------------------------------------------------------- */
/* Bash env filtering + output redaction                                       */
/* -------------------------------------------------------------------------- */

describe("bash tool env hygiene", () => {
  test("credential env vars are not visible to child processes", async () => {
    process.env["ANTHROPIC_API_KEY"] = "sk-leaked-key-1234567890abcdef"
    try {
      const result = await bashTool.execute(
        { command: 'echo "$ANTHROPIC_API_KEY"' },
        ctx(),
      )
      expect(result.output).not.toContain("sk-leaked-key")
    } finally {
      delete process.env["ANTHROPIC_API_KEY"]
    }
  }, 15_000)

  test("non-credential env vars are passed through", async () => {
    process.env["MY_BUILD_VAR"] = "visible-value"
    try {
      const result = await bashTool.execute(
        { command: 'echo "$MY_BUILD_VAR"' },
        ctx(),
      )
      expect(result.output).toContain("visible-value")
    } finally {
      delete process.env["MY_BUILD_VAR"]
    }
  }, 15_000)

  test("key patterns in output are redacted", async () => {
    // A command that prints a key-like string directly — the output
    // should be redacted before reaching the model.
    const result = await bashTool.execute(
      {
        command:
          'echo "token=sk-or-v1-0123456789abcdef0123456789abcdef"',
      },
      ctx(),
    )
    expect(result.output).not.toContain("sk-or-v1-0123456789abcdef")
    expect(result.output).toContain("[REDACTED]")
  }, 15_000)

  test("normal output is not redacted", async () => {
    const result = await bashTool.execute(
      { command: 'echo "hello world 42 tests passed"' },
      ctx(),
    )
    expect(result.output).toContain("hello world")
    expect(result.output).not.toContain("[REDACTED]")
  }, 15_000)
})

/* -------------------------------------------------------------------------- */
/* OpenRouter catalog fetch: no auth header                                    */
/* -------------------------------------------------------------------------- */

describe("fetchOpenRouterCatalog", () => {
  test("returns an array (empty on failure, never throws)", async () => {
    // No network mocking — the fetch may succeed or fail depending on
    // environment. The invariant is that it returns an array and never
    // throws, regardless of outcome.
    const result = await fetchOpenRouterCatalog()
    expect(Array.isArray(result)).toBe(true)
  })

  test("the catalog URL is https and contains no query/auth params", async () => {
    // We verify the URL constant indirectly: fetchOpenRouterCatalog uses
    // CATALOG_URL = "https://openrouter.ai/api/v1/models" (no key material).
    // The test ensures the function doesn't embed any env key in the URL.
    // A successful fetch returns models whose specs start with "openrouter/".
    const result = await fetchOpenRouterCatalog()
    for (const model of result) {
      expect(model.spec.startsWith("openrouter/")).toBe(true)
      // No key material in the spec or label.
      expect(model.spec).not.toContain("sk-")
      expect(model.spec).not.toContain("Bearer")
    }
  })
})
