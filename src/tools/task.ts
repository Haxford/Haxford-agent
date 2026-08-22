import { z } from "zod"
import { resolveAgent, type NamedAgent } from "../agent/agents.ts"
import { runAgentLoop, type ToolContextWithSubagent } from "../agent/loop.ts"
import { clampMode, createAskHandler } from "../permission/engine.ts"
import type { Message, TextPart } from "../types/message.ts"
import type { Tool, ToolResult } from "../types/tool.ts"
import { truncateText } from "./shared.ts"

const MAX_OUTPUT_CHARS = 10_000
/** Subagents get a hard turn budget of their own, whatever the parent allows. */
const SUBAGENT_MAX_TURNS = 30

const parameters = z.object({
  description: z
    .string()
    .describe("3-5 word description of the subtask, shown to the user."),
  prompt: z
    .string()
    .describe("The detailed, self-contained instruction for the subagent."),
  agent: z
    .string()
    .optional()
    .describe(
      "Name of a user-defined agent to run this subtask as (see the agents " +
        "listed in your instructions, e.g. \"reviewer\"). Omit for a default " +
        "subagent.",
    ),
})

type Args = z.infer<typeof parameters>

/** Concatenate the visible text of an assistant message. */
function textOf(message: Message | undefined): string {
  if (!message) return ""
  return message.parts
    .filter((part): part is TextPart => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim()
}

export const taskTool: Tool<Args> = {
  id: "task",
  description: `Spawn a subagent to autonomously carry out a subtask and report back.

Use it for work that is self-contained and either parallelizable or
context-heavy — searching a large codebase for where something is handled,
researching how a library is used across many files, or any exploration whose
intermediate output you do not need to see. The subagent reads the files so
your own context does not fill up with them.

How it works:
- The subagent starts with FRESH context. It sees ONLY the prompt you pass —
  not this conversation, the files you have read, or what you are working on.
  So the prompt must be completely self-contained: state the goal, the
  relevant paths, any constraints, and exactly what to report back.
- It runs with the same tools as you EXCEPT task itself, so subagents cannot
  spawn subagents.
- It has the SAME permissions as you but CANNOT ask the user anything, so any
  action that would prompt you for approval is refused outright. In practice a
  subagent can read, search and list freely; treat writing, editing and
  running commands as unavailable to it. Ask it to investigate and report,
  not to change things.
- It returns ONLY its final message as a plain-text summary. Nothing else
  survives, so say what you want reported — "list the file:line of each call
  site" beats "look into the call sites".
- You cannot send follow-up messages. One prompt, one answer.
- Pass 'agent' to run the subtask as a user-defined agent (e.g. "reviewer")
  instead of a default one; its model, permissions, tools and instructions
  then apply.

Launch several in parallel in a single step when the subtasks are
independent — that is the main reason to use this tool.

Prefer read/glob/grep directly when you already know what you are looking for;
a subagent costs a whole extra model run. Do not use it for trivial lookups or
for work that depends on context only you have.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const description = args.description.trim() || "subagent"
    const prompt = args.prompt.trim()

    if (!prompt) {
      return {
        title: description,
        output: "Error: prompt is empty. Give the subagent a self-contained instruction.",
      }
    }

    const sub = (ctx as ToolContextWithSubagent).subagent
    if (!sub) {
      return {
        title: description,
        output:
          "Error: the task tool is unavailable here — no subagent context was provided by the agent loop.",
      }
    }

    // A named agent reshapes the subagent: its own model, permission
    // posture, tool allowlist and prompt addendum. Unknown names are an
    // error the model can act on, not a throw.
    let named: NamedAgent | undefined
    if (args.agent !== undefined && args.agent.trim().length > 0) {
      const resolved = await resolveAgent(ctx.cwd, args.agent)
      if (resolved.agent === undefined) {
        return {
          title: description,
          output:
            `Error: no agent named ${JSON.stringify(args.agent.trim())} is defined. ` +
            resolved.warnings.join(" "),
        }
      }
      named = resolved.agent
    }

    // No nesting: a subagent never gets the task tool. The allowlist filters
    // whatever remains.
    let tools = sub.tools.filter((tool) => tool.id !== "task")
    if (named?.tools !== undefined) {
      const allowed = new Set(named.tools.map((id) => id.toLowerCase()))
      tools = tools.filter((tool) => allowed.has(tool.id))
    }

    /**
     * A subagent runs under its parent's permission mode, never a laxer one.
     * Anything the parent would have had to ask the user about is refused
     * here rather than silently allowed: the model chooses when to spawn a
     * subagent, so a blanket allow would let it route around the approval
     * the user expects for writes, edits and shell commands.
     *
     * Subagents are also unattended, so nothing may block on the user. `onAsk`
     * refuses instead of suspending on a UI bridge that the parent's own tool
     * call is currently occupying (which would deadlock).
     */
    /**
     * A named agent may only make the posture STRICTER, never laxer. Opting
     * into plan mode for a read-only reviewer is the feature; a checked-in
     * `mode: auto` promoting a plan-mode session into unattended writes is
     * the hole it would otherwise open, since `<cwd>/.haxford/agents` ships
     * with the repository and the model chooses which agent to spawn.
     */
    const subMode = clampMode(named?.mode, sub.mode)

    const askPermission = createAskHandler({
      ...(sub.config?.permission ? { rules: sub.config.permission } : {}),
      mode: subMode,
      onAsk: () => "deny",
    })

    let turns = 0
    let input = 0
    let output = 0
    let reasoning = 0
    let lastAssistant: Message | undefined
    const errors: string[] = []

    try {
      const events = runAgentLoop({
        sessionID: `${ctx.sessionID}:sub:${crypto.randomUUID()}`,
        agent: named?.name ?? description,
        cwd: ctx.cwd,
        userText: prompt,
        history: [],
        model: named?.model ?? sub.model,
        tools,
        config: { ...(sub.config ?? {}), maxTurns: SUBAGENT_MAX_TURNS },
        abort: ctx.abort,
        askPermission,
        mode: subMode,
        ...(named?.instructions ? { agentInstructions: named.instructions } : {}),
        ...(sub.retry ? { retry: sub.retry } : {}),
      })

      // Drain the subagent's stream — its events are internal, not the
      // parent UI's. Only the final text comes back.
      let step = await events.next()
      while (!step.done) {
        const event = step.value
        switch (event.type) {
          case "turn.start":
            turns++
            break
          case "usage":
            input += event.usage.input
            output += event.usage.output
            reasoning += event.usage.reasoning ?? 0
            break
          case "message.updated":
            if (event.message.role === "assistant") {
              lastAssistant = event.message
            }
            break
          case "error":
            errors.push(event.message)
            break
        }
        step = await events.next()
      }

      const reason = step.value
      const usage = {
        input,
        output,
        ...(reasoning > 0 ? { reasoning } : {}),
      }
      const metadata = { description, turns, usage, reason }
      const summary = textOf(lastAssistant)

      if (reason === "error") {
        const detail = errors.at(-1) ?? lastAssistant?.error ?? "unknown error"
        return {
          title: `${description} (failed)`,
          output:
            `The subagent failed after ${turns} turn(s): ${detail}\n\n` +
            (summary
              ? `Partial result before the failure:\n\n${summary}`
              : "It produced no usable result. Consider doing the work directly."),
          metadata,
        }
      }

      if (reason === "aborted") {
        return {
          title: `${description} (aborted)`,
          output: `The subagent was cancelled after ${turns} turn(s) and did not finish.`,
          metadata,
        }
      }

      if (!summary) {
        return {
          title: `${description} (no result)`,
          output:
            `The subagent finished after ${turns} turn(s) without returning any text. ` +
            `Re-run with a prompt that states exactly what to report back.`,
          metadata,
        }
      }

      const { text, truncated } = truncateText(summary, MAX_OUTPUT_CHARS)
      const notes: string[] = []
      if (truncated) {
        notes.push(
          `[Subagent report truncated to ${MAX_OUTPUT_CHARS} of ${summary.length} characters.]`,
        )
      }
      if (reason === "max_turns") {
        notes.push(
          `[The subagent hit its ${SUBAGENT_MAX_TURNS}-turn limit, so this result may be incomplete.]`,
        )
      }

      return {
        title: description,
        output: notes.length ? `${text}\n\n${notes.join("\n")}` : text,
        metadata,
      }
    } catch (error) {
      // Programmer errors in a subagent must not take down the parent turn.
      const detail = error instanceof Error ? error.message : String(error)
      return {
        title: `${description} (failed)`,
        output: `The subagent could not be run: ${detail}`,
        metadata: { description, turns },
      }
    }
  },
}
