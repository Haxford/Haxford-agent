import type { ZodType } from "zod"

/** Result of executing a tool. */
export interface ToolResult {
  /** Short human-readable summary shown in the TUI. */
  title: string
  /** Content returned to the model. Truncate aggressively — this enters context. */
  output: string
  /** Structured extras for the UI (diffs, paths, partial output, etc). */
  metadata?: Record<string, unknown>
}

/** A request for user approval before a gated tool action runs. */
export interface PermissionRequest {
  tool: string
  args: Record<string, unknown>
  /** Human-readable description, e.g. the bash command being run. */
  title: string
  sessionID: string
}

export type PermissionDecision = "allow" | "always" | "deny"

export interface ToolContext {
  sessionID: string
  /** Name of the invoking agent (e.g. "build", or a subagent type). */
  agent: string
  /** Project working directory — tools must confine effects here unless allowed. */
  cwd: string
  abort: AbortSignal
  /** Ask the permission layer/UI before executing a gated action. */
  askPermission(request: PermissionRequest): Promise<PermissionDecision>
  /** Stream structured metadata (e.g. partial bash output) to the UI. */
  onMetadata?: (metadata: Record<string, unknown>) => void | Promise<void>
}

export interface Tool<Args = any> {
  id: string
  /** Prompt-engineered instructions telling the model how/when to use this tool. */
  description: string
  parameters: ZodType<Args>
  execute(args: Args, ctx: ToolContext): Promise<ToolResult>
}
