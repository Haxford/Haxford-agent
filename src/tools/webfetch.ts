import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { errorText, truncateText } from "./shared.ts"

const MAX_OUTPUT_CHARS = 50_000
const TIMEOUT_MS = 20_000
const MAX_BYTES = 1_000_000

const parameters = z.object({
  url: z.string().describe("The URL to fetch. Must use https:// unless localhost."),
})

type Args = z.infer<typeof parameters>

/**
 * Per-run cache: url → { text, at }. A URL fetched once in a session is
 * returned from cache for subsequent calls until the process exits. Keeps
 * the model from hammering the same endpoint in a loop.
 */
const cache = new Map<string, { text: string; at: number }>()
const CACHE_TTL_MS = 5 * 60_000

/**
 * Validate that a URL is https:, or http: to a local address.
 *
 * A non-HTTPS URL for a remote host is refused — the URL may contain auth
 * tokens in query strings or headers, and we will not send those in cleartext.
 */
function validateURL(raw: string): string | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return `Error: ${JSON.stringify(raw)} is not a valid URL.`
  }
  if (url.protocol === "https:") return null
  if (url.protocol === "http:") {
    const host = url.hostname
    if (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1"
    ) {
      return null
    }
    return `Error: ${JSON.stringify(raw)} uses HTTP for a non-local host. Use HTTPS.`
  }
  return `Error: ${JSON.stringify(raw)} must be an http(s) URL.`
}

/**
 * Strip HTML tags and produce a text/markdown-ish rendering.
 *
 * Hand-rolled — no heavy deps. Collapses whitespace, extracts block-level
 * structure (headings, lists, code, links), and drops script/style entirely.
 * Good enough for the model to read a web page's content.
 */
function htmlToText(html: string): string {
  // Drop script/style/noscript/svg content entirely.
  let s = html.replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, "")
  // HTML comments.
  s = s.replace(/<!--[\s\S]*?-->/g, "")
  // Block-level elements → newlines.
  s = s.replace(/<\/(p|div|section|article|header|footer|nav|aside|main|li|tr|h[1-6])>/gi, "\n")
  // Headings → markdown.
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, level: string, text: string) => {
    const hashes = "#".repeat(Number(level))
    return `\n${hashes} ${stripTags(text).trim()}\n`
  })
  // Code blocks → fenced.
  s = s.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_m, text: string) => {
    return `\n\`\`\`\n${stripTags(text).trim()}\n\`\`\`\n`
  })
  // Inline code.
  s = s.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, "`$1`")
  // Links → [text](href).
  s = s.replace(
    /<a\b[^>]*href=["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href: string, text: string) => `[${stripTags(text).trim()}](${href})`,
  )
  // List items.
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n")
  // Bold / italic.
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**")
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*")
  // Line breaks.
  s = s.replace(/<br\s*\/?>/gi, "\n")
  // Strip remaining tags.
  s = stripTags(s)
  // Decode common entities.
  s = decodeEntities(s)
  // Collapse runs of blank lines.
  s = s.replace(/\n{3,}/g, "\n\n")
  return s.trim()
}

/** Remove all remaining HTML tags, keeping inner text. */
function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, "")
}

function decodeEntities(s: string): string {
  const map: Record<string, string> = {
    "&amp;": "&",
    "&lt;": "<",
    "&gt;": ">",
    "&quot;": '"',
    "&#39;": "'",
    "&apos;": "'",
    "&nbsp;": " ",
  }
  return s.replace(/&(amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => map[m] ?? m)
}

export const webfetchTool: Tool<Args> = {
  id: "webfetch",
  description: `Fetch a URL and return its content as text.

Usage:
- url MUST use https:// unless it is a local address (localhost, 127.0.0.1).
  Non-HTTPS URLs are refused to avoid sending credentials in cleartext.
- HTML pages are stripped to a markdown-ish text representation (headings,
  links, lists, code blocks preserved). Non-HTML content is returned as-is
  up to the size cap.
- Output is capped at ${MAX_OUTPUT_CHARS} characters. When truncated the
  result says so — use a more specific URL or narrow what you need.
- A per-run cache means fetching the same URL twice in one session returns
  the cached result without a second request.
- The user is asked to approve each fetch; permission rules match the host
  part of the URL.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const url = args.url.trim()
    const urlError = validateURL(url)
    if (urlError) return { title: "webfetch failed", output: urlError }

    const decision = await ctx.askPermission({
      tool: "webfetch",
      args: { url },
      title: `Fetch ${url}`,
      sessionID: ctx.sessionID,
    })
    if (decision === "deny") {
      return {
        title: "webfetch",
        output: `The user declined to fetch ${url}. It was not requested.`,
      }
    }

    // Per-run cache.
    const cached = cache.get(url)
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return {
        title: `webfetch ${url} (cached)`,
        output: cached.text,
        metadata: { url, cached: true },
      }
    }

    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: "follow",
        headers: { "User-Agent": "haxford/webfetch" },
      })
      if (!response.ok) {
        return {
          title: `webfetch ${url}`,
          output: `Error: HTTP ${response.status} ${response.statusText} from ${url}.`,
        }
      }

      const contentType = response.headers.get("content-type") ?? ""
      // Read at most MAX_BYTES to avoid pulling a huge payload into memory.
      const buf = await response.arrayBuffer()
      const bytes = buf.byteLength > MAX_BYTES
        ? buf.slice(0, MAX_BYTES)
        : buf
      const body = new TextDecoder("utf-8", { fatal: false }).decode(bytes)
      const truncatedBytes = buf.byteLength > MAX_BYTES

      const text = contentType.includes("text/html")
        ? htmlToText(body)
        : body

      const { text: capped, truncated } = truncateText(text, MAX_OUTPUT_CHARS)
      const notes: string[] = []
      if (truncatedBytes) {
        notes.push(`[Response body exceeded ${MAX_BYTES} bytes; truncated before decoding.]`)
      }
      if (truncated) {
        notes.push(
          `[Output truncated to ${MAX_OUTPUT_CHARS} of ${text.length} characters. ` +
            `Use a more specific URL or grep the result.]`,
        )
      }

      const output = notes.length ? `${capped}\n\n${notes.join("\n")}` : capped
      cache.set(url, { text: output, at: Date.now() })

      return {
        title: `webfetch ${url}`,
        output,
        metadata: {
          url,
          status: response.status,
          contentType,
          truncated,
          cached: false,
        },
      }
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        return {
          title: `webfetch ${url}`,
          output: `Error: request to ${url} timed out after ${TIMEOUT_MS}ms.`,
        }
      }
      return {
        title: `webfetch ${url}`,
        output: `Error fetching ${url}: ${errorText(error)}`,
      }
    }
  },
}
