import {
  streamText,
  tool as aiTool,
  type ModelMessage,
  type ToolSet,
} from "ai"
import type { Mode } from "../permission/engine.ts"
import { resolveModel } from "../providers/index.ts"
import type { HaxfordConfig } from "../types/config.ts"
import type { AgentEvent, LoopEndReason } from "../types/events.ts"
import type {
  Message,
  Part,
  ReasoningPart,
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
import {
  DEFAULT_RETRY_POLICY,
  planRetry,
  retryNoticeText,
  sleepWithAbort,
  withRetry,
  type RetryPolicy,
} from "./retry.ts"

const DEFAULT_MAX_TURNS = 100
/**
 * The AI SDK retries "retryable" API errors itself by default. We turn that
 * off so our own classifier owns the decision: it distinguishes throttling
 * from an exhausted account, surfaces each wait as a notice instead of
 * stalling silently, and honours the run's abort signal while waiting.
 */
const SDK_RETRIES = 0
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
  /**
   * The permission posture this run was started with. Only used to give
   * subagents the same posture as their parent — the loop itself gates
   * through `askPermission`. Defaults to the safest interactive mode, so an
   * unattended subagent cannot act more freely than its parent by accident.
   */
  mode?: Mode
  /** Transient-failure policy for model calls. Defaults to 3 attempts. */
  retry?: RetryPolicy
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
  /**
   * The parent's permission mode, so a subagent is bound by the same rules.
   * A subagent must never be able to do what its parent would have had to ask
   * the user about.
   */
  mode: Mode
  /** The parent's retry policy, inherited so subagents are as resilient. */
  retry?: RetryPolicy
}

/** ToolContext as the loop actually builds it. */
export type ToolContextWithSubagent = ToolContext & {
  subagent?: SubagentContext
}

/* -------------------------------------------------------------------------- */
/* Compaction                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Stable id for a session's compaction summary message. Deterministic so a
 * store that dedupes by id keeps only the newest summary — each one already
 * subsumes the previous.
 */
export function compactionMessageID(sessionID: string): string {
  return `compaction-${sessionID}`
}

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
    maxRetries: SDK_RETRIES,
    onError: () => {},
  })
  return (await result.text).trim()
}

/**
 * Summarize with the shared transient-failure policy. Compaction is a plain
 * request/response call, so unlike a streamed turn it can be retried wholesale
 * without any risk of showing the user duplicated output.
 */
async function summarizeWithRetry(
  model: Parameters<typeof streamText>[0]["model"],
  system: string,
  messages: ModelMessage[],
  abort: AbortSignal | undefined,
  policy: RetryPolicy | undefined,
  onRetry?: (message: string) => void,
): Promise<string> {
  return withRetry(() => summarize(model, system, messages, abort), {
    ...(policy ? { policy } : {}),
    ...(abort ? { signal: abort } : {}),
    ...(onRetry
      ? { onRetry: (notice) => onRetry(retryNoticeText(notice)) }
      : {}),
  })
}

/**
 * Wrap a summary in the synthetic user message that stands in for the
 * conversation it replaces. Single source of the marker convention — both
 * auto-compaction and `compactConversation` build their message here.
 */
function buildSummaryMessage(
  sessionID: string,
  summary: string,
  id: string,
): Message {
  return {
    id,
    sessionID,
    role: "user",
    parts: [
      {
        id: `${id}-text`,
        type: "text",
        text: `${COMPACTION_MARKER}\n\n${summary}`,
      },
    ],
    time: { created: Date.now() },
  }
}

/**
 * Summarize a conversation on demand (the TUI's /compact command), using the
 * same prompt and model-call path as automatic compaction.
 *
 * Returns the synthetic summary message only — `history` is never mutated and
 * nothing is persisted; the host decides what to store and what to drop.
 * Throws on an unresolvable model, a failed model call, or an empty summary,
 * which the host surfaces as an error event.
 */
export async function compactConversation(input: {
  sessionID: string
  history: Message[]
  model: string
  cwd: string
  config?: HaxfordConfig
  projectInstructions?: string
  /** Transient-failure policy for the summarization call. */
  retry?: RetryPolicy
}): Promise<{ summary: Message }> {
  const messages = toModelMessages(input.history)
  if (messages.length === 0) throw new Error("nothing to compact")

  const model = resolveModel(input.model, input.config)
  const system = assembleSystemPrompt(input.cwd, input.projectInstructions)

  const summary = await summarizeWithRetry(
    model,
    system,
    messages,
    undefined,
    input.retry,
  )
  if (!summary) throw new Error("the model returned an empty summary")

  return {
    summary: buildSummaryMessage(input.sessionID, summary, crypto.randomUUID()),
  }
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
  const retryPolicy = input.retry ?? DEFAULT_RETRY_POLICY
  // Default to the strictest interactive posture: a caller that forgets to
  // say what mode it is in must not thereby grant subagents free rein.
  const mode: Mode = input.mode ?? "build"

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
      mode,
      retry: retryPolicy,
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
      const pending: string[] = []
      const summary = await summarizeWithRetry(
        model,
        system,
        modelMessages,
        abort,
        retryPolicy,
        (text) => pending.push(text),
      )
      for (const text of pending) {
        yield { type: "notice", message: `compaction ${text}` }
      }
      if (!summary) throw new Error("model returned an empty summary")

      const tail = conversation.slice(-COMPACT_TAIL)
      // The request that started this run must survive compaction.
      if (finalUserMessage && !tail.includes(finalUserMessage)) {
        tail.unshift(finalUserMessage)
      }

      // Deterministic id: a later compaction in the same session replaces this
      // message rather than stacking another summary beside it, in any store
      // that dedupes by message id.
      const synthetic = buildSummaryMessage(
        sessionID,
        summary,
        compactionMessageID(sessionID),
      )

      conversation.length = 0
      conversation.push(synthetic, ...tail)
      // Re-baseline so the next turn does not immediately re-compact.
      lastInput = estimateTokens(toModelMessages(conversation))

      // Emit the summary so the host can persist it. Without this the summary
      // lives only in this loop's local copy and the next prompt re-compacts
      // from scratch, paying for another summarization every turn.
      //
      // HOST CONTRACT: on seeing a message whose text starts with
      // COMPACTION_MARKER, persist it AND stop replaying the messages it
      // summarizes — otherwise a resumed session reloads the full
      // pre-compaction history plus the summary and nothing is saved. The
      // frozen Part/Message contract has no field to mark this structurally,
      // so the marker text and the stable id are the only signals available.
      yield { type: "message.updated", message: { ...synthetic, parts: [...synthetic.parts] } }

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
    // Set whenever anything derived from the model's output has been handed
    // to the consumer. Once that happens the turn can no longer be retried:
    // a second attempt would stream a second copy of the same answer.
    let emitted = false
    const partEvent = (part: Part): AgentEvent => {
      emitted = true
      return { type: "part.updated", messageID: message.id, part: { ...part } }
    }

    yield { type: "message.updated", message: snapshot() }

    const openText = new Map<string, TextPart>()
    const openReasoning = new Map<string, ReasoningPart>()
    const openTool = new Map<string, ToolPart>()
    const openText_ = (streamID: string): TextPart => {
      const existing = openText.get(streamID)
      if (existing) return existing
      const part: TextPart = { id: crypto.randomUUID(), type: "text", text: "" }
      openText.set(streamID, part)
      message.parts.push(part)
      return part
    }
    const openReasoning_ = (streamID: string): ReasoningPart => {
      const existing = openReasoning.get(streamID)
      if (existing) return existing
      const part: ReasoningPart = {
        id: crypto.randomUUID(),
        type: "reasoning",
        text: "",
      }
      openReasoning.set(streamID, part)
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
    /** The raw error behind `outcome === "error"`, for retry classification. */
    let failure: unknown

    /**
     * Attempt loop. A turn that fails transiently *before* producing any
     * visible output is retried with backoff; once the user has seen part of
     * the answer we stop, because there is no way to un-show it.
     */
    for (let attempt = 1; ; attempt++) {
    try {
      const result = streamText({
        model,
        system,
        messages: toModelMessages(conversation),
        ...(toolSet ? { tools: toolSet } : {}),
        ...(abort ? { abortSignal: abort } : {}),
        maxRetries: SDK_RETRIES,
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
            emitted = true
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

          // Reasoning mirrors the text lifecycle so thinking-capable models
          // stream into a ReasoningPart the TUI can render distinctly.
          case "reasoning-start": {
            openReasoning_(chunk.id)
            break
          }
          case "reasoning-delta": {
            if (!chunk.text) break
            const part = openReasoning_(chunk.id)
            part.text += chunk.text
            emitted = true
            yield {
              type: "part.delta",
              messageID: message.id,
              partID: part.id,
              delta: chunk.text,
            }
            break
          }
          case "reasoning-end": {
            const part = openReasoning.get(chunk.id)
            if (part) {
              openReasoning.delete(chunk.id)
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
            // A provider can report failure purely through finishReason,
            // with no preceding error chunk. Without this the turn would be
            // reported as a normal end_turn and the failure swallowed.
            if (chunk.finishReason === "error") {
              failure = failure ?? new Error(message.error ?? "provider reported an error")
              message.error =
                message.error ??
                "The model stream finished with an error (finishReason: error) " +
                  "and no further detail from the provider."
              outcome = "error"
            } else if (
              chunk.finishReason === "unknown" &&
              message.parts.length === 0
            ) {
              // A connection reset mid-stream surfaces as finishReason
              // "unknown" with no error chunk and nothing decoded. Reporting
              // end_turn there would show an empty assistant reply as success.
              // Only treat it as failure when nothing at all was produced —
              // "unknown" with real content is a truncated but usable turn.
              message.error =
                "The model stream ended before returning any content " +
                "(the connection was likely interrupted)."
              failure = new Error(message.error)
              outcome = "error"
            }
            break
          }
          case "abort": {
            outcome = "aborted"
            break
          }
          case "error": {
            // An abort surfaces here as an AbortError on some providers;
            // reporting it as a loop error would misattribute a user action.
            if (isAbort(chunk.error, abort)) {
              outcome = "aborted"
              break
            }
            failure = chunk.error
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
        failure = error
        message.error = errorMessage(error)
        outcome = "error"
      }
    }

      if (outcome !== "error" || emitted) break

      const plan = planRetry(failure, attempt, retryPolicy, abort)
      if (!plan) break

      yield { type: "notice", message: retryNoticeText(plan) }
      await sleepWithAbort(plan.delayMs, abort)
      if (abort?.aborted) {
        outcome = "aborted"
        break
      }

      // Discard everything the failed attempt built. Safe precisely because
      // none of it was emitted — the consumer never saw this message have
      // any content, so rebuilding it from scratch is invisible.
      message.parts.length = 0
      delete message.error
      openText.clear()
      openReasoning.clear()
      openTool.clear()
      startedAt.clear()
      usage = undefined
      failure = undefined
      outcome = "end_turn"
    }

    // Flush anything the provider left open (error or abort mid-stream).
    for (const part of openText.values()) yield partEvent(part)
    openText.clear()
    for (const part of openReasoning.values()) yield partEvent(part)
    openReasoning.clear()

    // A tool call that never produced a result would otherwise stay pending or
    // running forever — a stuck spinner in the UI, and an unsettled part that
    // history conversion has to drop. Settle each one as an error instead.
    for (const [callID, part] of openTool) {
      const start = startedAt.get(callID) ?? Date.now()
      part.state = {
        status: "error",
        input:
          part.state.status === "running" ? part.state.input : {},
        error:
          outcome === "aborted"
            ? "Aborted before the tool call completed."
            : `Tool call did not complete: ${message.error ?? "stream error"}`,
        time: { start, end: Date.now() },
      }
      yield partEvent(part)
    }
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
