import { extensionTools } from "../extend/registry.ts"
import type { Tool } from "../types/tool.ts"
import { bashTool } from "./bash.ts"
import { editTool } from "./edit.ts"
import { globTool } from "./glob.ts"
import { grepTool } from "./grep.ts"
import { readTool } from "./read.ts"
import { taskTool } from "./task.ts"
import { todoReadTool, todoWriteTool } from "./todo.ts"
import { webfetchTool } from "./webfetch.ts"
import { writeTool } from "./write.ts"

export { bashTool } from "./bash.ts"
export { editTool } from "./edit.ts"
export { globTool } from "./glob.ts"
export { grepTool } from "./grep.ts"
export { readTool } from "./read.ts"
export { taskTool } from "./task.ts"
export { todoReadTool, todoWriteTool, getTodos, forgetTodos, loadTodos } from "./todo.ts"
export type { Todo, TodoStatus } from "./todo.ts"
export { webfetchTool } from "./webfetch.ts"
export { writeTool } from "./write.ts"
export { forgetReads, hasRead, recordRead } from "./shared.ts"

/**
 * Every built-in tool, in a stable order.
 *
 * Order matters for prompt caching: the tool list is rendered ahead of the
 * system prompt, so it must not vary between requests.
 */
export function builtinTools(): Tool[] {
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
    webfetchTool,
  ]
}

/** Ids of the built-in tools. Reserved: an extension may not shadow one. */
export function builtinToolIds(): string[] {
  return builtinTools().map((tool) => tool.id)
}

/**
 * The built-ins followed by every tool contributed by an extension.
 *
 * Built-ins come first and win any id collision, so the cached prefix of the
 * tool list is identical whether or not the user has extensions installed,
 * and no plugin can quietly replace `bash` with its own. Extension tools keep
 * registration order, which is filename order — stable across runs, so the
 * suffix caches too.
 *
 * The registry is empty until `loadExtensibility()` has run, which makes this
 * exactly `builtinTools()` for anyone who never loaded extensions (every test
 * that does not opt in, included).
 */
export function allTools(): Tool[] {
  const tools = builtinTools()
  const seen = new Set(tools.map((tool) => tool.id))
  for (const tool of extensionTools()) {
    if (seen.has(tool.id)) continue
    seen.add(tool.id)
    tools.push(tool)
  }
  return tools
}
