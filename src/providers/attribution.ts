/**
 * Who we say we are on the wire.
 *
 * Every outbound provider request — model calls, key verification, catalog
 * fetches, daemon probes — identifies this client. Two shapes, because two
 * conventions:
 *
 *  - OpenRouter reads `HTTP-Referer` and `X-Title` and uses them for the
 *    per-app attribution on the user's dashboard, so requests routed through
 *    it are attributed to haxford rather than showing up anonymous.
 *  - Everyone else gets a conventional `User-Agent` carrying the same name,
 *    the version, and a URL a provider can follow when they want to know what
 *    is calling them.
 *
 * These are the single source of truth: nothing else should spell the name,
 * the URL, or the version out by hand.
 */

/** Product name, as it should appear to a provider. */
export const APP_NAME = "Haxford-Agent"

/** Where a provider (or a curious human) can find out what this is. */
export const APP_URL = "https://haxford.dev/haxford-agent"

/**
 * The released version.
 *
 * Kept in step with `package.json` and the TUI banner by a test — if you bump
 * one, bump all of them or the suite says so.
 */
export const APP_VERSION = "0.4.0"

/** `Haxford-Agent/0.4.0 (+https://haxford.dev/haxford-agent)` */
export const USER_AGENT = `${APP_NAME}/${APP_VERSION} (+${APP_URL})`

/** The attribution pair OpenRouter surfaces on the account's usage page. */
export const OPENROUTER_ATTRIBUTION: Readonly<Record<string, string>> = {
  "HTTP-Referer": APP_URL,
  "X-Title": APP_NAME,
}

/** Providers that read attribution from `HTTP-Referer`/`X-Title` instead. */
const ATTRIBUTION_BY_REFERER = new Set(["openrouter"])

/**
 * The identifying headers for one provider, keyed by its *canonical* name
 * (resolve aliases before calling — `kimi` is `moonshot`).
 *
 * A fresh object every call: callers spread it into request headers and some
 * of them mutate what they build.
 */
export function attributionHeaders(canonical: string): Record<string, string> {
  return ATTRIBUTION_BY_REFERER.has(canonical)
    ? { ...OPENROUTER_ATTRIBUTION }
    : { "User-Agent": USER_AGENT }
}
