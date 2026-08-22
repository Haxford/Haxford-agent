import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"

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

/** Drop a session's todos (session end / fork). */
export function forgetTodos(sessionID: string): void {
  lists.delete(sessionID)
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
  sent only at the end of a task tells the user nothing while it matters.`,
  parameters: writeParameters,
  async execute(args, ctx): Promise<ToolResult> {
    const todos: Todo[] = args.todos.map((todo, index) => ({
      id: todo.id ?? `${index + 1}`,
      content: todo.content,
      status: todo.status,
    }))

    lists.set(ctx.sessionID, todos)

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
  what is still outstanding. It returns the same list todowrite last stored.`,
  parameters: readParameters,
  async execute(_args, ctx): Promise<ToolResult> {
    const todos = getTodos(ctx.sessionID)
    return {
      title: summarize(todos),
      output: render(todos),
      metadata: { todos },
    }
  },
}
