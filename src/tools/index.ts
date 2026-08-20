import type { Tool } from "../types/tool.ts"
import { bashTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { readTool } from "./read.ts"
import { taskTool } from "./task.ts"
import { todoReadTool, todoWriteTool } from "./todo.ts"
import { writeTool } from "./write.ts"

export { bashTool } from "./bash.ts"
export { editTool } from "./edit.ts"
export { globTool } from "./glob.ts"
export { grepTool } from "./grep.ts"
export { readTool } from "./read.ts"
export { taskTool } from "./task.ts"
export { todoReadTool, todoWriteTool, getTodos, forgetTodos } from "./todo.ts"
export type { Todo, TodoStatus } from "./todo.ts"
export { writeTool } from "./write.ts"
export { forgetReads, hasRead, recordRead } from "./shared.ts"

/**
 * Every built-in tool, in a stable order.
 *
 * Order matters for prompt caching: the tool list is rendered ahead of the
 * system prompt, so it must not vary between requests.
 */
export function allTools(): Tool[] {
  return [
    readTool,
    writeTool,
    editTool,
    bashTool,
    globTool,
    grepTool,
    todoWriteTool,
    todoReadTool,
    taskTool,
  ]
}
