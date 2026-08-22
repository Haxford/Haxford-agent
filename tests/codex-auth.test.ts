import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { chmodSync, statSync } from "node:fs"

import {
  codexAccessToken,
  codexAuthPath,
  ensureCodexAuth,
  readCodexAuth,
} from "../src/providers/auth.ts"

/* -------------------------------------------------------------------------- */
/* Harness                                                                     */
/* -------------------------------------------------------------------------- */

const STUB_TOKEN_URL = "https://oauth.invalid/token"

const realFetch = globalThis.fetch
let home: string
let restoreEnv: Array<[string, string | undefined]> = []

function setEnv(key: string, value: string | undefined): void {
  restoreEnv.push([key, process.env[key]])
  if (value === undefined) delete process.env[key]
  else process.env[key] = value
}

/** A JWT-shaped token whose `exp` claim sits `seconds` from now. */
function jwt(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url")
  return `header.${payload}.signature`
}

/** Write an auth.json, including fields haxford does not model. */
async function writeAuth(tokens: Record<string, unknown>): Promise<void> {
  await Bun.write(
    codexAuthPath(),
    JSON.stringify(
      {
        OPENAI_API_KEY: null,
        unknown_root_field: "keep me",
        tokens: { id_token: "id-token-value", ...tokens },
      },
      null,
      2,
    ),
  )
}

async function readAuthFile(): Promise<Record<string, any>> {
  return (await Bun.file(codexAuthPath()).json()) as Record<string, any>
}

interface FetchCall {
  url: string
  body: Record<string, unknown>
}

/** Replace global fetch with a recording stub. */
function stubFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): FetchCall[] {
  const calls: FetchCall[] = []
  globalThis.fetch = (async (input: any, init?: any) => {
    const call: FetchCall = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    }
    calls.push(call)
    return respond(call)
  }) as unknown as typeof fetch
  return calls
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

beforeEach(async () => {
  home = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-codex-${crypto.randomUUID()}`
  await Bun.write(`${home}/.keep`, "")
  restoreEnv = []
  setEnv("CODEX_HOME", home)
  setEnv("CODEX_OAUTH_TOKEN_URL", STUB_TOKEN_URL)
  setEnv("CODEX_OAUTH_CLIENT_ID", "test-client-id")
})

afterEach(() => {
  globalThis.fetch = realFetch
  for (const [key, value] of restoreEnv.reverse()) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

/* -------------------------------------------------------------------------- */
/* Refresh on expiry                                                           */
/* -------------------------------------------------------------------------- */

describe("ensureCodexAuth", () => {
  test("an expired token is refreshed and written back", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      account_id: "acct-123",
      expires_at: Date.now() - 5_000,
    })

    const calls = stubFetch(() =>
      json({
        access_token: "fresh-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
    )

    const auth = await ensureCodexAuth()

    expect(auth.accessToken).toBe("fresh-access")
    expect(auth.accountId).toBe("acct-123")

    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(STUB_TOKEN_URL)
    expect(calls[0]?.body).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "stored-refresh",
      client_id: "test-client-id",
    })

    const file = await readAuthFile()
    expect(file["tokens"]["access_token"]).toBe("fresh-access")
    expect(file["tokens"]["refresh_token"]).toBe("rotated-refresh")
    expect(file["tokens"]["expires_at"]).toBeGreaterThan(Date.now() + 3_500_000)
    // The rotated token is what a later synchronous read sees.
    expect(readCodexAuth().accessToken).toBe("fresh-access")
  })

  test("write-back preserves fields haxford does not model", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      account_id: "acct-123",
      expires_at: Date.now() - 5_000,
    })
    stubFetch(() => json({ access_token: "fresh-access", expires_in: 60_000 }))

    await ensureCodexAuth()

    const file = await readAuthFile()
    expect(file["unknown_root_field"]).toBe("keep me")
    expect(file).toHaveProperty("OPENAI_API_KEY", null)
    expect(file["tokens"]["id_token"]).toBe("id-token-value")
    expect(file["tokens"]["account_id"]).toBe("acct-123")
    // Not rotated by the server: the stored refresh token stands.
    expect(file["tokens"]["refresh_token"]).toBe("stored-refresh")
  })

  test("the rewritten credential file is chmod 600", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      expires_at: Date.now() - 5_000,
    })
    chmodSync(codexAuthPath(), 0o644)
    stubFetch(() => json({ access_token: "fresh-access", expires_in: 3600 }))

    await ensureCodexAuth()

    expect(statSync(codexAuthPath()).mode & 0o777).toBe(0o600)
  })

  test("a token whose JWT exp has passed is refreshed", async () => {
    await writeAuth({
      access_token: jwt(Math.floor(Date.now() / 1000) - 10),
      refresh_token: "stored-refresh",
    })
    const calls = stubFetch(() => json({ access_token: "fresh-access" }))

    expect((await ensureCodexAuth()).accessToken).toBe("fresh-access")
    expect(calls).toHaveLength(1)
  })

  test("a token inside the 60s skew window is refreshed early", async () => {
    await writeAuth({
      access_token: "nearly-stale",
      refresh_token: "stored-refresh",
      expires_at: Date.now() + 30_000,
    })
    const calls = stubFetch(() => json({ access_token: "fresh-access" }))

    expect((await ensureCodexAuth()).accessToken).toBe("fresh-access")
    expect(calls).toHaveLength(1)
  })

  test("concurrent calls share one refresh", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      expires_at: Date.now() - 5_000,
    })
    const calls = stubFetch(async () => {
      await Bun.sleep(5)
      return json({ access_token: "fresh-access", expires_in: 3600 })
    })

    const results = await Promise.all([
      ensureCodexAuth(),
      ensureCodexAuth(),
      ensureCodexAuth(),
    ])

    expect(calls).toHaveLength(1)
    expect(results.map((r) => r.accessToken)).toEqual([
      "fresh-access",
      "fresh-access",
      "fresh-access",
    ])
  })

  /* ------------------------------------------------------------------------ */
  /* Fresh tokens are left alone                                               */
  /* ------------------------------------------------------------------------ */

  test("a fresh token is used as-is, with no exchange", async () => {
    await writeAuth({
      access_token: "fresh-enough",
      refresh_token: "stored-refresh",
      expires_at: Date.now() + 3_600_000,
    })
    const calls = stubFetch(() => {
      throw new Error("refresh must not be attempted for a fresh token")
    })

    expect((await ensureCodexAuth()).accessToken).toBe("fresh-enough")
    expect(calls).toHaveLength(0)
  })

  test("a token with no discoverable expiry is left alone", async () => {
    await writeAuth({
      access_token: "opaque-token",
      refresh_token: "stored-refresh",
    })
    const calls = stubFetch(() => json({ access_token: "fresh-access" }))

    expect((await ensureCodexAuth()).accessToken).toBe("opaque-token")
    expect(calls).toHaveLength(0)
  })

  test("an expired token with no refresh token is left alone", async () => {
    await writeAuth({
      access_token: "stale-access",
      expires_at: Date.now() - 5_000,
    })
    const calls = stubFetch(() => json({ access_token: "fresh-access" }))

    expect((await ensureCodexAuth()).accessToken).toBe("stale-access")
    expect(calls).toHaveLength(0)
  })

  /* ------------------------------------------------------------------------ */
  /* Failure falls back to the stored token (and the provider's 401)           */
  /* ------------------------------------------------------------------------ */

  test("a non-2xx response falls back to the stored token", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      expires_at: Date.now() - 5_000,
    })
    stubFetch(() => json({ error: "invalid_grant" }, 400))

    expect((await ensureCodexAuth()).accessToken).toBe("stale-access")

    const file = await readAuthFile()
    expect(file["tokens"]["access_token"]).toBe("stale-access")
    expect(file["tokens"]["refresh_token"]).toBe("stored-refresh")
  })

  test("a network failure falls back to the stored token", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      expires_at: Date.now() - 5_000,
    })
    stubFetch(() => {
      throw new Error("ECONNREFUSED")
    })

    expect((await ensureCodexAuth()).accessToken).toBe("stale-access")
    expect((await readAuthFile())["tokens"]["access_token"]).toBe("stale-access")
  })

  test("a 200 with no access_token falls back to the stored token", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      expires_at: Date.now() - 5_000,
    })
    stubFetch(() => json({ token_type: "Bearer" }))

    expect((await ensureCodexAuth()).accessToken).toBe("stale-access")
    expect((await readAuthFile())["tokens"]["access_token"]).toBe("stale-access")
  })

  test("a missing credential file still throws the login hint", async () => {
    stubFetch(() => json({ access_token: "fresh-access" }))
    await expect(ensureCodexAuth()).rejects.toThrow(/No codex credentials found/)
  })
})

/* -------------------------------------------------------------------------- */
/* Synchronous accessor                                                        */
/* -------------------------------------------------------------------------- */

describe("codexAccessToken", () => {
  test("returns the stored token immediately and refreshes behind it", async () => {
    await writeAuth({
      access_token: "stale-access",
      refresh_token: "stored-refresh",
      expires_at: Date.now() - 5_000,
    })
    const calls = stubFetch(() =>
      json({ access_token: "fresh-access", expires_in: 3600 }),
    )

    // This call takes the 401 it would have taken before refresh existed.
    expect(codexAccessToken()).toBe("stale-access")

    // The background refresh rotates the file for the next resolution.
    await Bun.sleep(20)
    expect(calls).toHaveLength(1)
    expect(codexAccessToken()).toBe("fresh-access")
  })

  test("a fresh token triggers no background exchange", async () => {
    await writeAuth({
      access_token: "fresh-enough",
      refresh_token: "stored-refresh",
      expires_at: Date.now() + 3_600_000,
    })
    const calls = stubFetch(() => json({ access_token: "fresh-access" }))

    expect(codexAccessToken()).toBe("fresh-enough")
    await Bun.sleep(10)
    expect(calls).toHaveLength(0)
  })
})
