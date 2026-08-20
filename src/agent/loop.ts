import { streamText, type ModelMessage } from "ai"
import { resolveModel } from "../providers/index.ts"
import type { HaxfordConfig } from "../types/config.ts"
import type { AgentEvent, LoopEndReason } from "../types/events.ts"
import type { Message, Part, TextPart, TokenUsage } from "../types/message.ts"
import type { Tool } from "../types/tool.ts"
import { assembleSystemPrompt } from "./prompt.ts"

export interface AgentLoopInput {
  sessionID: string
  agent: string
  cwd: string
  userText: string
  history: Message[]
  /** "provider/model" spec, resolved via src/providers. */
  model: string
  /** Phase 2. Ignored for now — no tool execution yet. */
  tools?: Tool[]
  config?: HaxfordConfig
  abort?: AbortSignal
  /** Project instructions (e.g. AGENTS.md) appended to the system prompt. */
  projectInstructions?: string
}

/** Concatenate the text a message contributes back to the model. */
function textOf(message: Message): string {
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

/**
 * Convert our Message/Part history into AI SDK model messages.
 *
 * Reasoning parts are dropped (they cannot be replayed without their provider
 * signatures) and so are tool parts — phase 2 owns the tool-call round trip.
 * Messages left with no content are skipped so we never send an empty turn.
 */
function toModelMessages(history: Message[], userText: string): ModelMessage[] {
  const messages: ModelMessage[] = []

  for (const message of history) {
    const text = textOf(message)
    if (!text) continue
    messages.push({ role: message.role, content: text })
  }

  const prompt = userText.trim()
  if (prompt) messages.push({ role: "user", content: prompt })

  return messages
}

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

/**
 * Run one turn of the agent loop, emitting AgentEvents as the model streams.
 *
 * Phase 1: no tool execution and no persistence — assemble the prompt, stream
 * text, and report usage. The generator's return value is the reason the loop
 * ended; a `loop.end` event carrying the same reason is emitted first.
 */
export async function* runAgentLoop(
  input: AgentLoopInput,
): AsyncGenerator<AgentEvent, LoopEndReason> {
  const { sessionID, agent, cwd, model: modelSpec, abort } = input

  const message: Message = {
    id: crypto.randomUUID(),
    sessionID,
    role: "assistant",
    agent,
    model: modelSpec,
    parts: [],
    time: { created: Date.now() },
  }

  /** Emit a defensive copy so consumers can hold onto what they receive. */
  const snapshot = (): Message => ({ ...message, parts: [...message.parts] })
  const partEvent = (part: Part): AgentEvent => ({
    type: "part.updated",
    messageID: message.id,
    part: { ...part },
  })

  const finish = function* (reason: LoopEndReason): Generator<AgentEvent> {
    message.time.completed = Date.now()
    yield { type: "message.updated", message: snapshot() }
    yield { type: "loop.end", reason }
  }

  yield { type: "message.updated", message: snapshot() }

  if (abort?.aborted) {
    yield* finish("aborted")
    return "aborted"
  }

  let model
  try {
    model = resolveModel(modelSpec, input.config)
  } catch (error) {
    const text = errorMessage(error)
    message.error = text
    yield { type: "error", message: text }
    yield* finish("error")
    return "error"
  }

  // Stream text part ids are provider-scoped; map them to our own part ids.
  const open = new Map<string, TextPart>()
  const openPart = (streamID: string): TextPart => {
    const existing = open.get(streamID)
    if (existing) return existing
    const part: TextPart = { id: crypto.randomUUID(), type: "text", text: "" }
    open.set(streamID, part)
    message.parts.push(part)
    return part
  }

  let usage: TokenUsage | undefined

  try {
    const result = streamText({
      model,
      system: assembleSystemPrompt(cwd, input.projectInstructions),
      messages: toModelMessages(input.history, input.userText),
      ...(abort ? { abortSignal: abort } : {}),
      // streamText's default onError writes to console.error, which would
      // corrupt the TUI render. Errors reach the caller as AgentEvents.
      onError: () => {},
    })

    for await (const chunk of result.fullStream) {
      switch (chunk.type) {
        case "text-start": {
          openPart(chunk.id)
          break
        }
        case "text-delta": {
          if (!chunk.text) break
          const part = openPart(chunk.id)
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
          const part = open.get(chunk.id)
          if (part) {
            open.delete(chunk.id)
            yield partEvent(part)
          }
          break
        }
        case "finish": {
          usage = toTokenUsage(chunk.totalUsage)
          break
        }
        case "abort": {
          yield* finish("aborted")
          return "aborted"
        }
        case "error": {
          const text = errorMessage(chunk.error)
          message.error = text
          yield { type: "error", message: text }
          yield* finish("error")
          return "error"
        }
      }
    }
  } catch (error) {
    if (isAbort(error, abort)) {
      yield* finish("aborted")
      return "aborted"
    }
    const text = errorMessage(error)
    message.error = text
    yield { type: "error", message: text }
    yield* finish("error")
    return "error"
  }

  // Flush any part the provider never closed.
  for (const part of open.values()) yield partEvent(part)
  open.clear()

  if (usage) {
    message.usage = usage
    yield { type: "usage", messageID: message.id, usage }
  }

  yield* finish("end_turn")
  return "end_turn"
}
