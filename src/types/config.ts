export type PermissionAction = "allow" | "ask" | "deny"

/**
 * Per-tool permission rules. A tool maps either to a blanket action or to
 * pattern rules (glob-style) matched against a tool-specific subject
 * (bash: the command string; read/write/edit: the file path).
 */
export interface PermissionRules {
  [tool: string]: PermissionAction | Record<string, PermissionAction>
}

export interface HaxfordConfig {
  /** "provider/model", e.g. "anthropic/claude-sonnet-4-20250514". */
  model?: string
  providers?: Record<
    string,
    { apiKey?: string; baseURL?: string; models?: string[] }
  >
  permission?: PermissionRules
  /** Max loop turns per prompt before stopping. Default 100. */
  maxTurns?: number
  /** Auto-compact when context usage exceeds this fraction (0-1). Default 0.9. */
  autoCompactAt?: number
}
