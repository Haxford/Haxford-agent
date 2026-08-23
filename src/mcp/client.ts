/**
 * Minimal MCP client over the stdio transport.
 *
 * Framing: newline-delimited JSON-RPC 2.0. Per the MCP spec's stdio
 * transport ("Messages are delimited by newlines, and MUST NOT contain
 * embedded newlines") — NOT the Content-Length/LSP framing some other
 * stdio protocols use. Verified against
 * https://modelcontextprotocol.io/specification/2024-11-05/basic/transports
 * before implementing.
 *
 * Implements exactly what haxford needs: `initialize` +
 * `notifications/initialized`, `tools/list` (paginated), `tools/call`. No
 * resources, prompts, sampling, or server->client requests — a server that
 * sends any of those is simply not answered, which is within spec (a client
 * need not support every capability).
 */

import { filteredEnv } from "../config/secrets.ts"
import { APP_VERSION } from "../providers/attribution.ts"
import { errorText } from "../tools/shared.ts"
import type { McpServerConfig } from "./config.ts"

export const MCP_PROTOCOL_VERSION = "2024-11-05"
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
/** Hard cap on tools/list pagination so a misbehaving server cannot loop forever. */
const MAX_LIST_PAGES = 100
/**
 * Ceiling on one newline-delimited message. The spec forbids embedded
 * newlines, so a "line" that never ends is a server that has stopped speaking
 * MCP — not a large legitimate message we should keep buffering.
 */
const MAX_MESSAGE_BYTES = 8 * 1024 * 1024

export interface McpToolSchema {
  name: string
  description?: string
  inputSchema?: unknown
}

export interface McpServerInfo {
  name: string
  version: string
}

export type McpConnectionStatus = "connecting" | "connected" | "disconnected"

export type McpResult<T> = ({ ok: true } & T) | { ok: false; error: string }

export interface McpClient {
  readonly name: string
  status(): McpConnectionStatus
  serverInfo(): McpServerInfo | undefined
  listTools(): Promise<McpResult<{ tools: McpToolSchema[] }>>
  callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpResult<{ content: unknown[]; isError: boolean }>>
  /** Kill the subprocess and settle any in-flight requests as failed. */
  close(): Promise<void>
  /** Fires once, the first time the connection is lost (crash, EOF, close()). */
  onDisconnect(fn: (reason: string) => void): void
}

interface JsonRpcSuccess {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
}
interface JsonRpcFailure {
  jsonrpc: "2.0"
  id: number | string
  error: { code: number; message: string; data?: unknown }
}
type JsonRpcReply = JsonRpcSuccess | JsonRpcFailure

function isFailure(reply: JsonRpcReply): reply is JsonRpcFailure {
  return "error" in reply && reply.error !== undefined
}

export interface LineFramer {
  /** Feed a decoded chunk; complete lines are handed to the sink in order. */
  push(chunk: string): void
  /** Bytes currently held for the line still being assembled. */
  pending(): number
  /** How many oversized lines have been discarded. */
  dropped(): number
}

/**
 * Split a stream into newline-delimited lines, bounded.
 *
 * Extracted from the read loop so the bound is testable without having to
 * exhaust memory to prove it. The MCP stdio framing forbids embedded
 * newlines, so a "line" that keeps growing is a server that has stopped
 * speaking MCP — a naive `buffer += chunk` grows until the process dies.
 * Past the cap the partial line is dropped and the framer resynchronises on
 * the next newline, which costs one message and bounds the memory.
 */
export function createLineFramer(
  onLine: (line: string) => void,
  maxBytes: number = MAX_MESSAGE_BYTES,
): LineFramer {
  let buffer = ""
  let skipping = false
  let dropped = 0

  return {
    push(chunk: string): void {
      buffer += chunk
      for (;;) {
        const nl = buffer.indexOf("\n")
        if (nl === -1) break
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (skipping) {
          // This newline closes the oversized line; resume normally.
          skipping = false
        } else if (line.length > 0) {
          onLine(line)
        }
      }
      if (buffer.length > maxBytes) {
        if (!skipping) {
          skipping = true
          dropped++
        }
        buffer = ""
      } else if (skipping) {
        buffer = ""
      }
    },
    pending: () => buffer.length,
    dropped: () => dropped,
  }
}

function spawnServer(config: McpServerConfig, cwd: string) {
  return Bun.spawn([config.command, ...(config.args ?? [])], {
    cwd,
    env: { ...filteredEnv(), ...(config.env ?? {}) },
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  })
}

/**
 * Spawn one MCP server over stdio and complete the initialize handshake.
 *
 * Returns an error result rather than throwing for every failure mode this
 * function can hit itself (spawn failure, handshake timeout/error) — the
 * caller (startup, or a future /mcp reconnect) surfaces these as warnings,
 * never a crash.
 */
export async function connectMcpServer(
  name: string,
  config: McpServerConfig,
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<McpResult<{ client: McpClient }>> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS

  let proc: ReturnType<typeof spawnServer>
  try {
    proc = spawnServer(config, opts.cwd ?? process.cwd())
  } catch (error) {
    return {
      ok: false,
      error: `failed to spawn ${JSON.stringify(config.command)}: ${errorText(error)}`,
    }
  }

  let status: McpConnectionStatus = "connecting"
  let info: McpServerInfo | undefined
  const pending = new Map<
    number,
    { resolve: (v: JsonRpcReply) => void; timer: ReturnType<typeof setTimeout> }
  >()
  let nextID = 1
  const disconnectHandlers: Array<(reason: string) => void> = []
  let disconnected = false

  const fireDisconnect = (reason: string): void => {
    if (disconnected) return
    disconnected = true
    status = "disconnected"
    for (const entry of pending.values()) {
      clearTimeout(entry.timer)
      entry.resolve({
        jsonrpc: "2.0",
        id: 0,
        error: { code: -32000, message: reason },
      })
    }
    pending.clear()
    for (const fn of disconnectHandlers) {
      try {
        fn(reason)
      } catch {
        // A listener must not be able to break shutdown.
      }
    }
  }

  function handleInbound(raw: unknown): void {
    if (!isRecord(raw)) return
    if (raw["id"] === undefined || raw["id"] === null) return // server notification; nothing to correlate
    if (!("result" in raw) && !("error" in raw)) return
    const rawID = raw["id"]
    const id = typeof rawID === "number" ? rawID : Number(rawID)
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(raw as unknown as JsonRpcReply)
  }

  // Drain stderr so a chatty server cannot stall on a full pipe buffer. The
  // spec allows arbitrary logging there; haxford has nowhere useful to put
  // it today, so it is discarded rather than buffered without bound.
  void (async () => {
    const reader = proc.stderr.getReader()
    try {
      for (;;) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      // ignore
    } finally {
      reader.releaseLock()
    }
  })()

  // Newline-delimited JSON-RPC message reader.
  void (async () => {
    const reader = proc.stdout.getReader()
    const decoder = new TextDecoder()
    const framer = createLineFramer((line) => {
      try {
        handleInbound(JSON.parse(line))
      } catch {
        // Not a valid MCP message — ignore rather than tear down the
        // connection over one malformed line.
      }
    })
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        framer.push(decoder.decode(value, { stream: true }))
      }
    } catch {
      // Stream error — falls through to the disconnect below.
    } finally {
      reader.releaseLock()
      fireDisconnect("server closed its stdout")
    }
  })()

  void proc.exited.then((code) => {
    fireDisconnect(`server process exited (code ${code})`)
  })

  async function send(method: string, params?: unknown): Promise<JsonRpcReply> {
    const id = nextID++
    const promise = new Promise<JsonRpcReply>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        resolve({
          jsonrpc: "2.0",
          id,
          error: { code: -32001, message: `timed out after ${timeoutMs}ms waiting for ${method}` },
        })
      }, timeoutMs)
      pending.set(id, { resolve, timer })
    })

    const line = JSON.stringify({ jsonrpc: "2.0", id, method, ...(params !== undefined ? { params } : {}) })
    try {
      proc.stdin.write(`${line}\n`)
      await proc.stdin.flush()
    } catch (error) {
      const entry = pending.get(id)
      if (entry) {
        clearTimeout(entry.timer)
        pending.delete(id)
      }
      return { jsonrpc: "2.0", id, error: { code: -32002, message: `write failed: ${errorText(error)}` } }
    }
    return promise
  }

  async function notify(method: string, params?: unknown): Promise<void> {
    const line = JSON.stringify({ jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) })
    try {
      proc.stdin.write(`${line}\n`)
      await proc.stdin.flush()
    } catch {
      // Best-effort: a notification has no reply to fail.
    }
  }

  /* ---- handshake ---- */
  const initReply = await send("initialize", {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "Haxford-Agent", version: APP_VERSION },
  })
  if (isFailure(initReply)) {
    const message = initReply.error.message
    try {
      proc.kill()
    } catch {
      // already gone
    }
    fireDisconnect(message)
    return { ok: false, error: `initialize failed: ${message}` }
  }
  const initResult = initReply.result
  const serverInfo = isRecord(initResult) ? initResult["serverInfo"] : undefined
  info = {
    name: (isRecord(serverInfo) && typeof serverInfo["name"] === "string" ? serverInfo["name"] : undefined) ?? name,
    version:
      (isRecord(serverInfo) && typeof serverInfo["version"] === "string" ? serverInfo["version"] : undefined) ??
      "unknown",
  }
  await notify("notifications/initialized")
  status = "connected"

  const client: McpClient = {
    name,
    status: () => status,
    serverInfo: () => info,

    async listTools() {
      if (status !== "connected") return { ok: false, error: "not connected" }
      const tools: McpToolSchema[] = []
      let cursor: string | undefined
      for (let page = 0; page < MAX_LIST_PAGES; page++) {
        const reply = await send("tools/list", cursor !== undefined ? { cursor } : {})
        if (isFailure(reply)) return { ok: false, error: reply.error.message }
        const result = reply.result
        const rawTools = isRecord(result) && Array.isArray(result["tools"]) ? result["tools"] : []
        for (const t of rawTools) {
          if (isRecord(t) && typeof t["name"] === "string") {
            tools.push({
              name: t["name"],
              ...(typeof t["description"] === "string" ? { description: t["description"] } : {}),
              ...(t["inputSchema"] !== undefined ? { inputSchema: t["inputSchema"] } : {}),
            })
          }
        }
        const nextCursor = isRecord(result) ? result["nextCursor"] : undefined
        cursor = typeof nextCursor === "string" ? nextCursor : undefined
        if (cursor === undefined) break
      }
      return { ok: true, tools }
    },

    async callTool(toolName, args) {
      if (status !== "connected") return { ok: false, error: "not connected" }
      const reply = await send("tools/call", { name: toolName, arguments: args })
      if (isFailure(reply)) return { ok: false, error: reply.error.message }
      const result = reply.result
      const content = isRecord(result) && Array.isArray(result["content"]) ? result["content"] : []
      const isError = isRecord(result) && result["isError"] === true
      return { ok: true, content, isError }
    },

    async close() {
      if (status === "disconnected") return
      fireDisconnect("closed by client")
      try {
        await proc.stdin.end()
      } catch {
        // already gone
      }
      try {
        proc.kill()
      } catch {
        // already gone
      }
    },

    onDisconnect(fn) {
      disconnectHandlers.push(fn)
    },
  }

  return { ok: true, client }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
