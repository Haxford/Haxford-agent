import {
  streamText,
  tool as aiTool,
  type ModelMessage,
  type ToolSet,
} from "ai"
import { resolveModel } from "../providers/index.ts"
import type { HaxfordConfig } from "../types/config.ts"
import type { AgentEvent, LoopEndReason } from "../types/events.ts"
import type {
  Message,
  Part,
  TextPart,
  TokenUsage,
  ToolPart,
} from "../types/message.ts"
import type {
  PermissionDecision,
  PermissionRequest,
  Tool,
  ToolContext,
  ToolResult,
} from "../types/tool.ts"
import {
  COMPACTION_MARKER,
  COMPACTION_PROMPT,
  contextLimit,
  estimateTokens,
} from "./context.ts"
import { assembleSystemPrompt } from "./prompt.ts"

const DEFAULT_MAX_TURNS = 100
const DEFAULT_COMPACT_AT = 0.9
/** Messages kept verbatim after the summary. */
const COMPACT_TAIL = 2

export interface AgentLoopInput {
  sessionID: string
  agent: string
  cwd: string
  userText: string
  history: Message[]
  /** "provider/model" spec, resolved via src/providers. */
  model: string
  /** Tools the model may call. Omit for a text-only turn. */
  tools?: Tool[]
  config?: HaxfordConfig
  abort?: AbortSignal
  /** Project instructions (e.g. AGENTS.md) appended to the system prompt. */
  projectInstructions?: string
  /** Gate for tool actions. Defaults to allowing everything. */
  askPermission?: (request: PermissionRequest) => Promise<PermissionDecision>
}

/* -------------------------------------------------------------------------- */
/* History conversion                                                          */
/* -------------------------------------------------------------------------- */

/** A tool part can only be replayed once it has a result the model can read. */
function isSettled(
  part: ToolPart,
): part is ToolPart & {
  state: Extract<ToolPart["state"], { status: "completed" | "error" }>
} {
  return part.state.status === "completed" || part.state.status === "error"
}

/**
 * Convert our Message/Part model back into AI SDK model messages.
 *
 * Reasoning parts are dropped — they cannot be replayed without their provider
 * signatures. Tool parts become an assistant `tool-call` block plus a matching
 * `tool` message carrying the result; unsettled tool parts (still pending or
 * running, e.g. from an aborted turn) are dropped entirely, because a tool
 * call with no matching result is rejected by the provider. Messages left with
 * no content are skipped so we never send an empty turn.
 */
export function toModelMessages(history: Message[]): ModelMessage[] {
  const messages: ModelMessage[] = []

  for (const message of history) {
    if (message.role === "user") {
      const text = message.parts
        .filter((part): part is TextPart => part.type === "text")
        .map((part) => part.text)
        .join("")
        .trim()
      if (text) messages.push({ role: "user", content: text })
      continue
    }

    const content: Extract<ModelMessage, { role: "assistant" }>["content"] = []
    const settled: Array<ToolPart & { state: { status: "completed" | "error" } }> =
      []

    for (const part of message.parts) {
      if (part.type === "text") {
        if (part.text) content.push({ type: "text", text: part.text })
        continue
      }
      if (part.type === "tool" && isSettled(part)) {
        content.push({
          type: "tool-call",
          toolCallId: part.callID,
          toolName: part.tool,
          input: part.state.input,
        })
        settled.push(part)
      }
    }

    if (content.length === 0) continue
    messages.push({ role: "assistant", content })

    if (settled.length > 0) {
      messages.push({
        role: "tool",
        content: settled.map((part) => ({
          type: "tool-result" as const,
          toolCallId: part.callID,
          toolName: part.tool,
          output:
            part.state.status === "completed"
              ? { type: "text" as const, value: part.state.output }
              : { type: "error-text" as const, value: part.state.error },
        })),
      })
    }
  }

  return messages
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function toTokenUsage(usage: {
  inputTokens?: number | undefined
  outputTokens?: number | undefined
  reasoningTokens?: number | undefined
}): TokenUsage {
  const result: TokenUsage = {
    input: usage.inputTokens ?? 0,
    output: usage.outputTokens ?? 0,
  }
  if (usage.reasoningTokens !== undefined) {
    result.reasoning = usage.reasoningTokens
  }
  return result
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "string") return error
  try {
    return JSON.stringify(error)
  } catch {
    return String(error)
  }
}

function isAbort(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true
  return error instanceof Error && error.name === "AbortError"
}

function isToolResult(value: unknown): value is ToolResult {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ToolResult).output === "string"
  )
}

/**
 * Wrap our tools as AI SDK tools. The SDK executes them inside the step; we
 * observe the resulting stream chunks to drive the ToolPart lifecycle.
 */
function buildToolSet(tools: Tool[], ctx: ToolContext): ToolSet {
  const set: ToolSet = {}
  for (const entry of tools) {
    set[entry.id] = aiTool({
      description: entry.description,
      inputSchema: entry.parameters,
      execute: async (args: unknown) => entry.execute(args, ctx),
      // Keep the provider's view of the result identical to the model-facing
      // output we replay from history.
      toModelOutput: (result: unknown) => ({
        type: "text",
        value: isToolResult(result) ? result.output : String(result),
      }),
    })
  }
  return set
}

/* -------------------------------------------------------------------------- */
/* Subagent plumbing                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Extra context the loop hands to tools that spawn a nested loop (task).
 *
 * Deliberately passed on the ToolContext rather than held in a module-scoped
 * variable: subagent loops run *nested* inside the parent's tool execution,
 * so a global set at loop start would be clobbered by the child and leave the
 * parent reading the child's value. Per-context data has no such problem, and
 * parallel task calls each get the right one.
 */
export interface SubagentContext {
  /** "provider/model" the parent loop is running. */
  model: string
  config?: HaxfordConfig
  /** The parent's tool list; task removes itself from it to prevent nesting. */
  tools: Tool[]
}

/** ToolContext as the loop actually builds it. */
export type ToolContextWithSubagent = ToolContext & {
  subagent?: SubagentContext
}

/* -------------------------------------------------------------------------- */
/* Compaction                                                                  */
/* -------------------------------------------------------------------------- */

/** The most recent real input-token count, if any turn has reported one. */
function latestUsageInput(history: Message[]): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const input = history[i]?.usage?.input
    if (typeof input === "number" && input > 0) return input
  }
  return undefined
}

/**
 * Ask the model to summarize the conversation so far. Runs without tools —
 * we only want prose back. Rejects if the stream fails.
 */
async function summarize(
  model: Parameters<typeof streamText>[0]["model"],
  system: string,
  messages: ModelMessage[],
  abort: AbortSignal | undefined,
): Promise<string> {
  const result = streamText({
    model,
    system,
    messages: [...messages, { role: "user", content: COMPACTION_PROMPT }],
    ...(abort ? { abortSignal: abort } : {}),
    onError: () => {},
  })
  return (await result.text).trim()
}

/* -------------------------------------------------------------------------- */
/* Loop                                                                        */
/* -------------------------------------------------------------------------- */

/** How a single streamed turn finished. */
type TurnOutcome = "tool_calls" | "end_turn" | "aborted" | "error"

/**
 * Run the agent loop, emitting AgentEvents as the model streams and tools run.
 *
 * One `streamText` call per turn. After a turn whose steps included tool
 * calls, the results are appended to the conversation and another turn runs.
 * The generator returns the reason the loop ended; a matching `loop.end` event
 * is emitted first.
 */
export async function* runAgentLoop(
  input: AgentLoopInput,
): AsyncGenerator<AgentEvent, LoopEndReason> {
  const { sessionID, agent, cwd, model: modelSpec, abort } = input
  const maxTurns = input.config?.maxTurns ?? DEFAULT_MAX_TURNS

  const finish = function* (reason: LoopEndReason): Generator<AgentEvent> {
    yield { type: "loop.end", reason }
  }

  let model
  try {
    model = resolveModel(modelSpec, input.config)
  } catch (error) {
    const text = errorMessage(error)
    yield { type: "error", message: text }
    yield* finish("error")
    return "error"
  }

  // Stable across turns, so the cached prefix survives the whole loop.
  const system = assembleSystemPrompt(cwd, input.projectInstructions)

  const toolCtx: ToolContextWithSubagent = {
    sessionID,
    agent,
    cwd,
    abort: abort ?? new AbortController().signal,
    askPermission: input.askPermission ?? (async () => "allow"),
    subagent: {
      model: modelSpec,
      ...(input.config ? { config: input.config } : {}),
      tools: input.tools ?? [],
    },
  }
  const toolSet =
    input.tools && input.tools.length > 0
      ? buildToolSet(input.tools, toolCtx)
      : undefined

  // Working conversation: prior history plus this prompt, then each turn's
  // assistant message as it completes. A local copy — the caller's history
  // array is never mutated, including by compaction.
  const conversation: Message[] = [...input.history]
  const prompt = input.userText.trim()
  let finalUserMessage: Message | undefined
  if (prompt) {
    finalUserMessage = {
      id: crypto.randomUUID(),
      sessionID,
      role: "user",
      parts: [{ id: crypto.randomUUID(), type: "text", text: prompt }],
      time: { created: Date.now() },
    }
    conversation.push(finalUserMessage)
  }

  /* ---- context pressure ---- */
  const limit = contextLimit(modelSpec)
  const compactAt = input.config?.autoCompactAt ?? DEFAULT_COMPACT_AT
  // Seed from the newest real usage figure in history; fall back to an
  // estimate over what we are about to send.
  let lastInput = latestUsageInput(input.history)
  let compactionDisabled = false

  /**
   * Compact when the conversation is close to filling the window: summarize
   * everything older than the tail, then keep [summary, …tail]. Failure is
   * never fatal — the run continues with the un-compacted history.
   */
  const maybeCompact = async function* (): AsyncGenerator<AgentEvent> {
    if (compactionDisabled) return

    const modelMessages = toModelMessages(conversation)
    const pressure = lastInput ?? estimateTokens(modelMessages)
    if (pressure <= limit * compactAt) return
    // Nothing older than the tail to summarize — compacting cannot help.
    if (conversation.length <= COMPACT_TAIL) return

    const percent = Math.round((pressure / limit) * 100)

    try {
      const summary = await summarize(model, system, modelMessages, abort)
      if (!summary) throw new Error("model returned an empty summary")

      const tail = conversation.slice(-COMPACT_TAIL)
      // The request that started this run must survive compaction.
      if (finalUserMessage && !tail.includes(finalUserMessage)) {
        tail.unshift(finalUserMessage)
      }

      const synthetic: Message = {
        id: crypto.randomUUID(),
        sessionID,
        role: "user",
        parts: [
          {
            id: crypto.randomUUID(),
            type: "text",
            text: `${COMPACTION_MARKER}\n\n${summary}`,
          },
        ],
        time: { created: Date.now() },
      }

      conversation.length = 0
      conversation.push(synthetic, ...tail)
      // Re-baseline so the next turn does not immediately re-compact.
      lastInput = estimateTokens(toModelMessages(conversation))

      yield {
        type: "notice",
        message: `context compacted (${percent}% of window)`,
      }
    } catch (error) {
      // Do not retry every turn on a persistent failure.
      compactionDisabled = true
      yield {
        type: "notice",
        message: `context compaction failed (${errorMessage(error)}); continuing without compacting`,
      }
    }
  }

  let turn = 0

  while (true) {
    if (abort?.aborted) {
      yield* finish("aborted")
      return "aborted"
    }

    turn++
    if (turn > maxTurns) {
      yield* finish("max_turns")
      return "max_turns"
    }

    // Before every request, including the first.
    yield* maybeCompact()

    yield { type: "turn.start", turn }

    /* ---- per-turn assistant message ---- */
    const message: Message = {
      id: crypto.randomUUID(),
      sessionID,
      role: "assistant",
      agent,
      model: modelSpec,
      parts: [],
      time: { created: Date.now() },
    }
    const snapshot = (): Message => ({ ...message, parts: [...message.parts] })
    const partEvent = (part: Part): AgentEvent => ({
      type: "part.updated",
      messageID: message.id,
      part: { ...part },
    })

    yield { type: "message.updated", message: snapshot() }

    const openText = new Map<string, TextPart>()
    const openTool = new Map<string, ToolPart>()
    const openText_ = (streamID: string): TextPart => {
      const existing = openText.get(streamID)
      if (existing) return existing
      const part: TextPart = { id: crypto.randomUUID(), type: "text", text: "" }
      openText.set(streamID, part)
      message.parts.push(part)
      return part
    }
    const openTool_ = (callID: string, toolName: string): ToolPart => {
      const existing = openTool.get(callID)
      if (existing) return existing
      const part: ToolPart = {
        id: crypto.randomUUID(),
        type: "tool",
        tool: toolName,
        callID,
        state: { status: "pending" },
      }
      openTool.set(callID, part)
      message.parts.push(part)
      return part
    }

    let usage: TokenUsage | undefined
    let outcome: TurnOutcome = "end_turn"
    const startedAt = new Map<string, number>()

    try {
      const result = streamText({
        model,
        system,
        messages: toModelMessages(conversation),
        ...(toolSet ? { tools: toolSet } : {}),
        ...(abort ? { abortSignal: abort } : {}),
        // streamText's default onError writes to console.error, which would
        // corrupt the TUI render. Errors reach the caller as AgentEvents.
        onError: () => {},
      })

      for await (const chunk of result.fullStream) {
        switch (chunk.type) {
          case "text-start": {
            openText_(chunk.id)
            break
          }
          case "text-delta": {
            if (!chunk.text) break
            const part = openText_(chunk.id)
            part.text += chunk.text
            yield {
              type: "part.delta",
              messageID: message.id,
              partID: part.id,
              delta: chunk.text,
            }
            break
          }
          case "text-end": {
            const part = openText.get(chunk.id)
            if (part) {
              openText.delete(chunk.id)
              yield partEvent(part)
            }
            break
          }

          case "tool-input-start": {
            const part = openTool_(chunk.id, chunk.toolName)
            yield partEvent(part)
            break
          }
          case "tool-call": {
            outcome = "tool_calls"
            const part = openTool_(chunk.toolCallId, chunk.toolName)
            const start = Date.now()
            startedAt.set(chunk.toolCallId, start)
            part.state = {
              status: "running",
              input: (chunk.input ?? {}) as Record<string, unknown>,
              time: { start },
            }
            yield partEvent(part)
            break
          }
          case "tool-result": {
            const part = openTool_(chunk.toolCallId, chunk.toolName)
            const start = startedAt.get(chunk.toolCallId) ?? Date.now()
            const value = chunk.output
            const input = (chunk.input ?? {}) as Record<string, unknown>
            part.state = isToolResult(value)
              ? {
                  status: "completed",
                  input,
                  output: value.output,
                  title: value.title,
                  ...(value.metadata ? { metadata: value.metadata } : {}),
                  time: { start, end: Date.now() },
                }
              : {
                  status: "completed",
                  input,
                  output: String(value),
                  title: chunk.toolName,
                  time: { start, end: Date.now() },
                }
            openTool.delete(chunk.toolCallId)
            yield partEvent(part)
            break
          }
          case "tool-error": {
            const part = openTool_(chunk.toolCallId, chunk.toolName)
            const start = startedAt.get(chunk.toolCallId) ?? Date.now()
            part.state = {
              status: "error",
              input: (chunk.input ?? {}) as Record<string, unknown>,
              error: errorMessage(chunk.error),
              time: { start, end: Date.now() },
            }
            openTool.delete(chunk.toolCallId)
            yield partEvent(part)
            break
          }

          case "finish": {
            usage = toTokenUsage(chunk.totalUsage)
            break
          }
          case "abort": {
            outcome = "aborted"
            break
          }
          case "error": {
            message.error = errorMessage(chunk.error)
            outcome = "error"
            break
          }
        }

        if (outcome === "aborted" || outcome === "error") break
      }
    } catch (error) {
      if (isAbort(error, abort)) {
        outcome = "aborted"
      } else {
        message.error = errorMessage(error)
        outcome = "error"
      }
    }

    // Flush anything the provider left open (error or abort mid-stream).
    for (const part of openText.values()) yield partEvent(part)
    openText.clear()
    openTool.clear()

    if (usage) {
      message.usage = usage
      // Real pressure reading for the next turn's compaction check.
      if (usage.input > 0) lastInput = usage.input
      yield { type: "usage", messageID: message.id, usage }
    }

    message.time.completed = Date.now()
    yield { type: "message.updated", message: snapshot() }
    conversation.push(message)

    yield { type: "turn.end", turn }

    if (outcome === "error") {
      yield { type: "error", message: message.error ?? "unknown error" }
      yield* finish("error")
      return "error"
    }
    if (outcome === "aborted") {
      yield* finish("aborted")
      return "aborted"
    }
    if (outcome === "end_turn") {
      yield* finish("end_turn")
      return "end_turn"
    }
    // outcome === "tool_calls" — results are in the conversation; loop again.
  }
}
