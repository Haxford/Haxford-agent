import { describe, expect, test } from "bun:test"

import { todoWriteTool, todoReadTool, getTodos, forgetTodos, loadTodos } from "../src/tools/todo.ts"
import { todosFile } from "../src/session/paths.ts"
import type { ToolContext } from "../src/types/tool.ts"

function ctx(cwd = process.cwd()): ToolContext {
  return {
    sessionID: `s-${crypto.randomUUID()}`,
    agent: "test",
    cwd,
    abort: new AbortController().signal,
    askPermission: async () => "allow",
  }
}

async function tmpdir(): Promise<string> {
  const dir = `${process.env["TMPDIR"] ?? "/tmp"}/haxford-todo-${crypto.randomUUID()}`
  await Bun.write(`${dir}/.keep`, "")
  return dir
}

describe("todo persistence", () => {
  test("todowrite persists to <sessionsDir>/<id>.todos.json", async () => {
    const dir = await tmpdir()
    const c = ctx(dir)
    await todoWriteTool.execute(
      {
        todos: [
          { content: "task one", status: "in_progress" },
          { content: "task two", status: "pending" },
        ],
      },
      c,
    )
    const file = Bun.file(todosFile(dir, c.sessionID))
    expect(await file.exists()).toBe(true)
    const parsed = (await file.json()) as { todos: { content: string; status: string }[] }
    expect(parsed.todos.length).toBe(2)
    expect(parsed.todos[0]!.content).toBe("task one")
    expect(parsed.todos[0]!.status).toBe("in_progress")
    forgetTodos(c.sessionID)
  })

  test("loadTodos reads back a persisted list", async () => {
    const dir = await tmpdir()
    const c = ctx(dir)
    await todoWriteTool.execute(
      {
        todos: [
          { content: "persisted task", status: "completed" },
        ],
      },
      c,
    )
    // Simulate a restart: drop in-memory state and reload from disk.
    forgetTodos(c.sessionID)
    const loaded = await loadTodos(dir, c.sessionID)
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.content).toBe("persisted task")
    expect(loaded[0]!.status).toBe("completed")
    forgetTodos(c.sessionID)
  })

  test("todoread lazily loads from disk after a resume", async () => {
    const dir = await tmpdir()
    const c = ctx(dir)
    await todoWriteTool.execute(
      {
        todos: [{ content: "lazy task", status: "pending" }],
      },
      c,
    )
    forgetTodos(c.sessionID)
    // todoread should trigger a lazy load.
    const result = await todoReadTool.execute({}, c)
    expect(result.output).toContain("lazy task")
    expect(getTodos(c.sessionID).length).toBe(1)
    forgetTodos(c.sessionID)
  })

  test("loadTodos returns empty when no file exists", async () => {
    const dir = await tmpdir()
    const c = ctx(dir)
    const loaded = await loadTodos(dir, c.sessionID)
    expect(loaded).toEqual([])
  })

  test("loadTodos returns empty for a corrupt file", async () => {
    const dir = await tmpdir()
    const c = ctx(dir)
    // Write a corrupt todos file.
    const { ensureDir, sessionsDir } = await import("../src/session/paths.ts")
    ensureDir(sessionsDir(dir))
    await Bun.write(todosFile(dir, c.sessionID), "not json{")
    const loaded = await loadTodos(dir, c.sessionID)
    expect(loaded).toEqual([])
  })

  test("loadTodos skips entries with invalid status", async () => {
    const dir = await tmpdir()
    const c = ctx(dir)
    const file = todosFile(dir, c.sessionID)
    const { ensureDir, sessionsDir } = await import("../src/session/paths.ts")
    ensureDir(sessionsDir(dir))
    await Bun.write(
      file,
      JSON.stringify({
        todos: [
          { id: "1", content: "valid", status: "pending" },
          { id: "2", content: "invalid", status: "bogus" },
        ],
      }),
    )
    const loaded = await loadTodos(dir, c.sessionID)
    expect(loaded.length).toBe(1)
    expect(loaded[0]!.content).toBe("valid")
    forgetTodos(c.sessionID)
  })
})
