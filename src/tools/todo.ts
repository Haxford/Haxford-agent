import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { todosFile } from "../session/paths.ts"

export type TodoStatus = "pending" | "in_progress" | "completed"

export interface Todo {
  id: string
  content: string
  status: TodoStatus
}

/** Todo lists per session. Replaced wholesale by todowrite. */
const lists = new Map<string, Todo[]>()

export function getTodos(sessionID: string): Todo[] {
  return lists.get(sessionID) ?? []
}

/**
 * Drop a session's todos (session end / fork).
 * Also removes the persisted file so a forked session starts clean.
 */
export function forgetTodos(sessionID: string): void {
  lists.delete(sessionID)
}

/**
 * Persist a session's todo list to disk so it survives a resume.
 * Best-effort: never throws — a write failure means todos are not
 * remembered, not that the session dies.
 */
async function persistTodos(directory: string, sessionID: string, todos: Todo[]): Promise<void> {
  const file = todosFile(directory, sessionID)
  try {
    await Bun.write(file, `${JSON.stringify({ todos }, null, 2)}\n`)
  } catch {
    // directory may not exist yet; ignore
  }
}

/**
 * Lazily load a session's todo list from disk on first access after a resume.
 * If the file does not exist or is corrupt, returns an empty list. Never
 * throws.
 */
export async function loadTodos(directory: string, sessionID: string): Promise<Todo[]> {
  // Already in memory — nothing to load.
  if (lists.has(sessionID)) return lists.get(sessionID) ?? []
  const file = Bun.file(todosFile(directory, sessionID))
  if (!(await file.exists())) return []
  try {
    const parsed = (await file.json()) as { todos?: unknown }
    const todos = parsed.todos
    if (!Array.isArray(todos)) return []
    const valid: Todo[] = []
    for (const item of todos) {
      if (typeof item !== "object" || item === null) continue
      const t = item as { id?: unknown; content?: unknown; status?: unknown }
      if (typeof t.id !== "string" || typeof t.content !== "string") continue
      if (t.status !== "pending" && t.status !== "in_progress" && t.status !== "completed") continue
      valid.push({ id: t.id, content: t.content, status: t.status })
    }
    lists.set(sessionID, valid)
    return valid
  } catch {
    return []
  }
}

const STATUS_MARK: Record<TodoStatus, string> = {
  pending: "[ ]",
  in_progress: "[~]",
  completed: "[x]",
}

function render(todos: Todo[]): string {
  if (todos.length === 0) return "(no todos)"
  return todos
    .map((todo) => `${STATUS_MARK[todo.status]} ${todo.content}`)
    .join("\n")
}

function summarize(todos: Todo[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length
  const active = todos.filter((todo) => todo.status === "in_progress").length
  return `${todos.length} todos (${done} completed, ${active} in progress)`
}

const writeParameters = z.object({
  todos: z
    .array(
      z.object({
        id: z.string().optional().describe("Stable id. Generated when omitted."),
        content: z.string().describe("What needs to be done."),
        status: z
          .enum(["pending", "in_progress", "completed"])
          .describe("Current state of this item."),
      }),
    )
    .describe("The complete todo list, replacing any previous one."),
})

type WriteArgs = z.infer<typeof writeParameters>

export const todoWriteTool: Tool<WriteArgs> = {
  id: "todowrite",
  description: `Record the task list for the current session.

Usage:
- Use this for multi-step or non-trivial work so the user can see the plan and
  your progress. Skip it for single-step tasks — it is noise there.
- The list you pass REPLACES the previous list entirely. Always send every
  item, including ones already completed, not just the changed ones.
- Exactly one item should be in_progress at a time. Mark an item completed as
  soon as it is done, before starting the next one — do not batch completions.
- Only mark an item completed when it actually succeeded. If it failed or is
  blocked, leave it in progress and add a new item describing what is needed.
- Keep content short and concrete, phrased as the work to do.
- Write the list BEFORE starting the work, then update it as you go. A list
  sent only at the end of a task tells the user nothing while it matters.
- The list is persisted to disk and survives a session resume.`,
  parameters: writeParameters,
  async execute(args, ctx): Promise<ToolResult> {
    const todos: Todo[] = args.todos.map((todo, index) => ({
      id: todo.id ?? `${index + 1}`,
      content: todo.content,
      status: todo.status,
    }))

    lists.set(ctx.sessionID, todos)
    await persistTodos(ctx.cwd, ctx.sessionID, todos)

    const active = todos.filter((todo) => todo.status === "in_progress").length
    const warning =
      active > 1
        ? `\n\n[Warning: ${active} items are in_progress. Keep exactly one active at a time.]`
        : ""

    return {
      title: summarize(todos),
      output: `Todo list updated.\n\n${render(todos)}${warning}`,
      metadata: { todos },
    }
  },
}

const readParameters = z.object({})

type ReadArgs = z.infer<typeof readParameters>

export const todoReadTool: Tool<ReadArgs> = {
  id: "todoread",
  description: `Read the current session's task list.

Usage:
- Takes no arguments.
- Use it to re-orient after a long stretch of work, or when you are unsure
  what is still outstanding. It returns the same list todowrite last stored.
- On a resumed session it loads the persisted list from disk on first call.`,
  parameters: readParameters,
  async execute(_args, ctx): Promise<ToolResult> {
    // Lazily load from disk if not already in memory (e.g. after a resume).
    if (!lists.has(ctx.sessionID)) {
      await loadTodos(ctx.cwd, ctx.sessionID)
    }
    const todos = getTodos(ctx.sessionID)
    return {
      title: summarize(todos),
      output: render(todos),
      metadata: { todos },
    }
  },
}
