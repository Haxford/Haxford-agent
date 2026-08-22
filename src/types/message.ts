export type Role = "user" | "assistant"

export interface TextPart {
  id: string
  type: "text"
  text: string
}

/**
 * Image attached to a user message. `data` is raw base64 (no data: prefix);
 * `mime` is the image MIME type. Additive contract change (coordinator,
 * user-approved): older sessions never contain these parts, and consumers
 * that ignore unknown part kinds keep working unchanged.
 */
export interface ImagePart {
  id: string
  type: "image"
  mime: "image/png" | "image/jpeg" | "image/webp" | "image/gif"
  data: string
  /** Optional source path when the image came from disk (@file or paste). */
  source?: string
}

export interface ReasoningPart {
  id: string
  type: "reasoning"
  text: string
}

export type ToolState =
  | { status: "pending" }
  | { status: "running"; input: Record<string, unknown>; time: { start: number } }
  | {
      status: "completed"
      input: Record<string, unknown>
      output: string
      title: string
      metadata?: Record<string, unknown>
      time: { start: number; end: number }
    }
  | {
      status: "error"
      input: Record<string, unknown>
      error: string
      time: { start: number; end: number }
    }

export interface ToolPart {
  id: string
  type: "tool"
  tool: string
  callID: string
  state: ToolState
}

export type Part = TextPart | ImagePart | ReasoningPart | ToolPart

export interface TokenUsage {
  input: number
  output: number
  reasoning?: number
}

export interface Message {
  id: string
  sessionID: string
  role: Role
  /** Agent that produced this message (e.g. "build" or a subagent name). */
  agent?: string
  /** "provider/model" that produced this message. */
  model?: string
  parts: Part[]
  usage?: TokenUsage
  error?: string
  time: { created: number; completed?: number }
}
