import type { ModelMessage } from "ai"

const DEFAULT_LIMIT = 200_000

/**
 * Context window size for a "provider/model" spec.
 *
 * A small static table — the providers do not expose this over the wire, and
 * being wrong low just compacts a little early. Unknown models get the
 * conservative default.
 */
export function contextLimit(modelSpec: string): number {
  const slash = modelSpec.indexOf("/")
  const provider = slash === -1 ? "" : modelSpec.slice(0, slash)
  const model = slash === -1 ? modelSpec : modelSpec.slice(slash + 1)

  if (provider === "anthropic") {
    if (model.startsWith("claude-")) return 200_000
    return DEFAULT_LIMIT
  }

  if (provider === "openai") {
    if (model.startsWith("gpt-4o") || model.startsWith("gpt-5")) return 128_000
    // o-series reasoning models: o1, o3, o4-mini, and the o-* spelling.
    if (model.startsWith("o-") || /^o\d/.test(model)) return 200_000
    return DEFAULT_LIMIT
  }

  return DEFAULT_LIMIT
}

/**
 * Rough token estimate used only when no real usage figure is available yet.
 * Four characters per token is close enough to decide whether to compact.
 */
export function estimateTokens(messages: ModelMessage[]): number {
  let chars = 0
  for (const message of messages) {
    chars +=
      typeof message.content === "string"
        ? message.content.length
        : JSON.stringify(message.content).length
  }
  return Math.ceil(chars / 4)
}

/** Prefix that marks a synthetic summary message in a compacted history. */
export const COMPACTION_MARKER = "[compacted summary of earlier conversation]"

/**
 * Instruction used to summarize a conversation that is about to overflow the
 * context window. Sent as a final user turn on top of the existing history.
 */
export const COMPACTION_PROMPT = `You are compacting a coding session that is about to exceed its context window.

Summarize it so you can continue the work seamlessly. Cover:
1. Goals — what the user asked for, in their own words where wording matters.
2. Decisions — choices made and why, including rejected alternatives.
3. Files — every file created, read, or modified, with absolute paths.
4. State — what is finished, verified, or known broken.
5. Next steps — the immediate next action.

Preserve exact identifiers: paths, symbol names, commands, error text. Drop
filler and stale tool output. Use plain prose under short headings. Do not
address the user — this is a handoff note to your future self.`
