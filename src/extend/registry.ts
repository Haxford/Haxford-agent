/**
 * The extension registry: what an extension may add, and where it lands.
 *
 * Every registration is tagged with the file that made it, because the only
 * thing worse than an extension that misbehaves is one you cannot identify.
 * Nothing in here throws at the caller: a bad registration is recorded as a
 * string and skipped, matching the rule that failures reaching the model (or
 * the user) are messages rather than exceptions.
 *
 * This module is a leaf — it imports types and zod only. `src/tools/index.ts`
 * reaches *in* here to merge extension tools into the tool list, so anything
 * imported here that imports tools back would be a cycle.
 */

import { z } from "zod"

import type { Message } from "../types/message.ts"
import type { Tool } from "../types/tool.ts"

/* -------------------------------------------------------------------------- */
/* Public shapes                                                               */
/* -------------------------------------------------------------------------- */

/** What a slash command handler is given when the user runs it. */
export interface CommandContext {
  /** Everything the user typed after the command name; "" when nothing. */
  args: string
  cwd: string
  /** The session the command was run in, when the host knows it. */
  sessionID?: string
}

/**
 * A command handler. Returning a string asks the host to show it to the user
 * (as a transcript notice); returning nothing means the command handled its
 * own output. Throwing is caught and reported — it never reaches the UI.
 */
export type CommandHandler = (
  ctx: CommandContext,
) => string | void | Promise<string | void>

export interface ExtensionCommand {
  /** Normalized: lowercase, no leading slash. */
  name: string
  description: string
  handler: CommandHandler
  /** Basename of the extension file that registered it. */
  source: string
}

export interface StartContext {
  cwd: string
  sessionID: string
}

export interface ToolCallInfo {
  tool: string
  args: Record<string, unknown>
  sessionID: string
  agent: string
}

export type StartHook = (ctx: StartContext) => void | Promise<void>
export type MessageHook = (message: Message) => void | Promise<void>
export type ToolCallHook = (call: ToolCallInfo) => void | Promise<void>

/** The object handed to an extension's default export. */
export interface HaxfordExtensionAPI {
  registerCommand(
    name: string,
    description: string,
    handler: CommandHandler,
  ): void
  registerTool(tool: Tool): void
  onStart(fn: StartHook): void
  onMessage(fn: MessageHook): void
  onToolCall(fn: ToolCallHook): void
}

/** The signature an extension file's default export must have. */
export type ExtensionModule = (
  haxford: HaxfordExtensionAPI,
) => void | Promise<void>

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Duck-type a zod schema.
 *
 * `Tool.parameters` is typed `ZodType`, but an extension is untyped JavaScript
 * at the moment it hands us one, so the check has to be a runtime one.
 * Testing for `safeParse` rather than `instanceof` keeps it working when the
 * extension bundles its own copy of zod — a realistic case, and one where
 * `instanceof` silently fails.
 */
function isZodSchema(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { safeParse?: unknown }).safeParse === "function"
  )
}

/**
 * Runtime shape of `Tool`.
 *
 * NOTE: `src/types/tool.ts` is types only — there is no pre-existing zod
 * schema for `Tool` anywhere in the tree, so this is it. It validates the
 * envelope, not the argument schema: what a tool's parameters *mean* is the
 * tool's business, but a registry that accepts `{id: 42}` produces a failure
 * three layers away at request time.
 */
export const ToolShape = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-z][a-z0-9_]*$/, "must be lowercase letters, digits and underscores"),
  description: z.string().trim().min(1),
  parameters: z.custom<Tool["parameters"]>(isZodSchema, {
    message: "must be a zod schema",
  }),
  execute: z.custom<Tool["execute"]>((v) => typeof v === "function", {
    message: "must be a function",
  }),
})

/**
 * Slash commands the TUI owns. An extension that registered one of these
 * would shadow a built-in and be very hard to diagnose.
 *
 * Kept in step by hand with `COMMANDS` in `src/tui/components/HelpPanel.tsx`
 * (plus `/reload`); importing a .tsx into the data layer to derive it would
 * drag React into every consumer of this module.
 */
export const RESERVED_COMMANDS: readonly string[] = Object.freeze([
  "help", "model", "connect", "sessions", "compact",
  "init", "mode", "clear", "exit", "reload",
])

/** Normalize a command name as typed by an extension author. */
export function normalizeCommandName(name: string): string {
  return name.trim().replace(/^\/+/, "").toLowerCase()
}

/* -------------------------------------------------------------------------- */
/* Registry                                                                    */
/* -------------------------------------------------------------------------- */

interface Hook<F> {
  fn: F
  source: string
}

export interface ExtensionRegistry {
  /** The API object for one extension file. Registrations are tagged with it. */
  apiFor(source: string): HaxfordExtensionAPI

  /** Reserve names extensions may not take. Call before loading. */
  reserve(what: { commands?: Iterable<string>; toolIds?: Iterable<string> }): void

  commands(): ExtensionCommand[]
  findCommand(name: string): ExtensionCommand | undefined
  tools(): Tool[]

  /** Registration- and hook-time problems, oldest first. */
  errors(): string[]
  report(message: string): void

  /**
   * Fire the start hooks for a session. Idempotent per session id: the loop
   * calls this on every prompt, but "start" means once.
   */
  fireStart(ctx: StartContext): Promise<void>
  fireMessage(message: Message): Promise<void>
  fireToolCall(call: ToolCallInfo): Promise<void>

  /** Drop every registration, hook, error and start-marker. */
  clear(): void
}

/** Cap on retained error strings, so a hook failing every turn cannot grow without bound. */
const MAX_ERRORS = 100

export function createRegistry(): ExtensionRegistry {
  let commands: ExtensionCommand[] = []
  let tools: Tool[] = []
  let startHooks: Hook<StartHook>[] = []
  let messageHooks: Hook<MessageHook>[] = []
  let toolCallHooks: Hook<ToolCallHook>[] = []
  let errors: string[] = []
  let started = new Set<string>()
  let reservedCommands = new Set<string>(RESERVED_COMMANDS)
  let reservedToolIds = new Set<string>()

  const report = (message: string): void => {
    if (errors.length >= MAX_ERRORS) return
    errors.push(message)
  }

  const text = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

  /** Run one hook list in registration order, surviving any failure. */
  const fire = async <A>(hooks: Hook<(arg: A) => unknown>[], arg: A, label: string): Promise<void> => {
    for (const hook of hooks) {
      try {
        await hook.fn(arg)
      } catch (error) {
        report(`${hook.source}: ${label} hook failed: ${text(error)}`)
      }
    }
  }

  return {
    apiFor(source: string): HaxfordExtensionAPI {
      return {
        registerCommand(name, description, handler) {
          const id = normalizeCommandName(name)
          if (id.length === 0) {
            report(`${source}: registerCommand needs a name`)
            return
          }
          if (!/^[a-z][a-z0-9-]*$/.test(id)) {
            report(
              `${source}: command ${JSON.stringify(name)} must be lowercase letters, digits and dashes`,
            )
            return
          }
          if (reservedCommands.has(id)) {
            report(`${source}: /${id} is a built-in command and cannot be replaced`)
            return
          }
          if (typeof handler !== "function") {
            report(`${source}: handler for /${id} must be a function`)
            return
          }
          const clash = commands.find((c) => c.name === id)
          if (clash !== undefined) {
            report(`${source}: /${id} is already registered by ${clash.source}`)
            return
          }
          commands.push({
            name: id,
            description: String(description ?? "").trim(),
            handler,
            source,
          })
        },

        registerTool(tool) {
          const parsed = ToolShape.safeParse(tool)
          if (!parsed.success) {
            const detail = parsed.error.issues
              .map((i) => `${i.path.join(".") || "tool"}: ${i.message}`)
              .join("; ")
            report(`${source}: registerTool rejected: ${detail}`)
            return
          }
          const id = tool.id.trim()
          if (reservedToolIds.has(id)) {
            report(`${source}: tool ${JSON.stringify(id)} is a built-in and cannot be replaced`)
            return
          }
          const clash = tools.find((t) => t.id === id)
          if (clash !== undefined) {
            report(`${source}: tool ${JSON.stringify(id)} is already registered`)
            return
          }
          // Store the caller's object, not the parsed one: zod strips unknown
          // keys, and a tool may legitimately carry extras we do not model.
          tools.push(tool)
        },

        onStart(fn) {
          if (typeof fn !== "function") {
            report(`${source}: onStart needs a function`)
            return
          }
          startHooks.push({ fn, source })
        },
        onMessage(fn) {
          if (typeof fn !== "function") {
            report(`${source}: onMessage needs a function`)
            return
          }
          messageHooks.push({ fn, source })
        },
        onToolCall(fn) {
          if (typeof fn !== "function") {
            report(`${source}: onToolCall needs a function`)
            return
          }
          toolCallHooks.push({ fn, source })
        },
      }
    },

    reserve(what) {
      if (what.commands !== undefined) {
        for (const name of what.commands) {
          reservedCommands.add(normalizeCommandName(name))
        }
      }
      if (what.toolIds !== undefined) {
        for (const id of what.toolIds) reservedToolIds.add(id.trim())
      }
    },

    commands: () => [...commands],
    findCommand: (name) => {
      const id = normalizeCommandName(name)
      return commands.find((c) => c.name === id)
    },
    tools: () => [...tools],
    errors: () => [...errors],
    report,

    async fireStart(ctx) {
      if (started.has(ctx.sessionID)) return
      started.add(ctx.sessionID)
      await fire(startHooks, ctx, "onStart")
    },
    fireMessage: (message) => fire(messageHooks, message, "onMessage"),
    fireToolCall: (call) => fire(toolCallHooks, call, "onToolCall"),

    clear() {
      commands = []
      tools = []
      startHooks = []
      messageHooks = []
      toolCallHooks = []
      errors = []
      started = new Set()
      // Reserved names survive a clear: they describe the host, not the
      // extensions, and re-deriving them on every reload is the caller's job
      // it should not have to remember.
      reservedCommands = new Set([...reservedCommands])
      reservedToolIds = new Set([...reservedToolIds])
    },
  }
}

/* -------------------------------------------------------------------------- */
/* The process-wide registry                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Lives here rather than in `index.ts` because `src/tools/index.ts` needs to
 * read `extensionTools()` and importing the barrel from there would close a
 * cycle (barrel -> tools -> barrel).
 */
const registry = createRegistry()

/** The process-wide registry. */
export function extensionRegistry(): ExtensionRegistry {
  return registry
}

/** Tools contributed by extensions, in registration order. */
export function extensionTools(): Tool[] {
  return registry.tools()
}

/** Slash commands contributed by extensions, in registration order. */
export function extensionCommands(): ExtensionCommand[] {
  return registry.commands()
}

/** Registration- and hook-time problems accumulated so far. */
export function extensionErrors(): string[] {
  return registry.errors()
}
