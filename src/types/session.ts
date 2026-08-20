export interface SessionInfo {
  id: string
  title: string
  /** Project directory this session belongs to. */
  directory: string
  time: { created: number; updated: number }
  tokens?: { input: number; output: number }
  cost?: number
}
