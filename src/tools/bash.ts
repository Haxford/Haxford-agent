import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { errorText, truncateText } from "./shared.ts"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT_CHARS = 50_000

const parameters = z.object({
  command: z.string().describe("The shell command to run."),
  timeout: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      `Timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT}, maximum ${MAX_TIMEOUT}.`,
    ),
  description: z
    .string()
    .optional()
    .describe("5-10 word description of what the command does, shown to the user."),
})

type Args = z.infer<typeof parameters>

export const bashTool: Tool<Args> = {
  id: "bash",
  description: `Run a shell command and return its combined output.

Usage:
- The command runs with bash in the session's working directory. Use absolute
  paths rather than cd where you can; the working directory does not persist
  between calls.
- Quote paths containing spaces: cd "/a/b c".
- timeout is in milliseconds (default ${DEFAULT_TIMEOUT}, max ${MAX_TIMEOUT}). A command
  that exceeds it is killed and reported as timed out.
- stdout and stderr are combined. Output longer than ${MAX_OUTPUT_CHARS} characters is
  truncated, and the output says so — pipe through head/tail/grep to narrow
  large output instead of dumping it.
- A non-zero exit status is reported to you, not thrown. Read the output and
  decide what to do.
- Prefer the dedicated read, glob, and grep tools over cat, find, and grep
  here: they are faster and their output is formatted for you.
- Run independent commands in parallel rather than chaining them with &&.
- Never run an interactive command — it will hang until it times out. Use the
  non-interactive form instead (git rebase --continue, not git rebase -i; npm
  ci, not a prompt-driven install), and pass flags like --yes or --no-pager
  where a command would otherwise wait for input or open a pager.
- The user is asked to approve the command before it runs, and may decline.
- Never run commands that are destructive or far-reaching without being asked
  to, and do not use this tool to work around a declined action.`,
  parameters,
  async execute(args, ctx): Promise<ToolResult> {
    const command = args.command.trim()
    if (!command) {
      return { title: "bash", output: "Error: command is empty." }
    }

    const timeout = Math.min(args.timeout ?? DEFAULT_TIMEOUT, MAX_TIMEOUT)
    const title = args.description?.trim() || command

    const decision = await ctx.askPermission({
      tool: "bash",
      args: { command, timeout },
      title: command,
      sessionID: ctx.sessionID,
    })
    if (decision === "deny") {
      return {
        title,
        output: `The user declined to run this command. It was not executed. Do not retry it without new instructions.`,
      }
    }

    const started = Date.now()
    let timedOut = false

    try {
      const proc = Bun.spawn(["bash", "-c", command], {
        cwd: ctx.cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })

      const kill = () => {
        try {
          proc.kill()
        } catch {
          // Already exited — nothing to kill.
        }
      }
      const timer = setTimeout(() => {
        timedOut = true
        kill()
      }, timeout)
      // An aborted turn must not leave a child process running.
      ctx.abort.addEventListener("abort", kill, { once: true })

      let stdout: string
      let stderr: string
      let exitCode: number
      try {
        ;[stdout, stderr, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
      } finally {
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", kill)
      }

      const duration = Date.now() - started
      const combined = [stdout, stderr].filter((part) => part !== "").join("\n")
      const { text, truncated } = truncateText(combined, MAX_OUTPUT_CHARS)

      const notes: string[] = []
      if (truncated) {
        notes.push(
          `[Output truncated to ${MAX_OUTPUT_CHARS} of ${combined.length} characters. ` +
            `Re-run filtered through grep/head/tail to see the rest.]`,
        )
      }
      if (timedOut) {
        notes.push(`[Command timed out after ${timeout}ms and was killed.]`)
      } else if (exitCode !== 0) {
        notes.push(`[Exit code ${exitCode}]`)
      }

      const body = text === "" ? "(no output)" : text
      return {
        title,
        output: notes.length ? `${body}\n\n${notes.join("\n")}` : body,
        metadata: {
          command,
          exitCode,
          timedOut,
          truncated,
          durationMs: duration,
        },
      }
    } catch (error) {
      return {
        title,
        output: `Error running command: ${errorText(error)}`,
        metadata: { command, exitCode: null },
      }
    }
  },
}
