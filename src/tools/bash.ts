import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { Tool, ToolResult } from "../types/tool.ts"
import { filteredEnv, redactSecrets } from "../config/secrets.ts"
import { errorText, truncateTail } from "./shared.ts"

const DEFAULT_TIMEOUT = 120_000
const MAX_TIMEOUT = 600_000
const MAX_OUTPUT_CHARS = 50_000
const MAX_OUTPUT_LINES = 2_000

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

/**
 * Read a piped stream into a shared sink.
 *
 * stdout and stderr are drained concurrently into ONE array, so chunks land
 * in arrival order and interleaved output keeps its shape — a warning printed
 * between two progress lines reads where it happened rather than being
 * relocated to a stderr block at the end.
 */
async function drain(
  stream: ReadableStream<Uint8Array>,
  sink: string[],
): Promise<void> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value !== undefined) sink.push(decoder.decode(value, { stream: true }))
    }
  } finally {
    reader.releaseLock()
  }
  const tail = decoder.decode()
  if (tail.length > 0) sink.push(tail)
}

/**
 * Write the full output somewhere the model can go back for it.
 *
 * Returns the path, or null when the spill failed — a truncation notice
 * without a working path is worse than one that just says it truncated, so
 * callers fall back rather than surfacing a filesystem error the model
 * cannot act on.
 */
async function spill(text: string): Promise<string | null> {
  const path = join(
    tmpdir(),
    `haxford-bash-${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}.log`,
  )
  try {
    await Bun.write(path, text)
    return path
  } catch {
    return null
  }
}

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
- stdout and stderr are combined in the order they were written.
- Output is capped at the LAST ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_CHARS} characters,
  whichever bites first — the end of a run is where the failure and the exit
  summary are. When output is truncated the full text is written to a temp
  file and the path is given to you: read or grep that file for the rest
  instead of re-running the command.
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
  Each part of a chained command is approved separately, so a rule covering
  the first part does not cover what follows it.
- Never run commands that are destructive or far-reaching without being asked
  to, and do not use this tool to work around a declined action.
- Haxford's own provider API keys are stripped from the child process
  environment so they cannot be echoed or exfiltrated. User-defined tokens
  (NPM_TOKEN, GH_TOKEN, …) are passed through. Any credential patterns that
  appear in captured output are redacted before the result reaches you.`,
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
        env: filteredEnv(),
      })

      const kill = () => {
        // Orphaned grandchildren (e.g. `sleep` under `bash -c`) keep the
        // stdio pipes open and would hang the drains below — reap them
        // BEFORE the shell exits, then kill the shell itself.
        try {
          Bun.spawnSync(["pkill", "-9", "-P", String(proc.pid)])
        } catch {
          // Best-effort only.
        }
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

      const chunks: string[] = []
      let exitCode: number
      try {
        ;[, , exitCode] = await Promise.all([
          drain(proc.stdout, chunks),
          drain(proc.stderr, chunks),
          proc.exited,
        ])
      } finally {
        clearTimeout(timer)
        ctx.abort.removeEventListener("abort", kill)
      }

      const duration = Date.now() - started
      // A trailing newline ends the last line rather than opening a new one,
      // so stripping trailing newlines keeps line counts honest while giving
      // the model clean output instead of a dangling blank line.
      const raw = chunks.join("").replace(/[\r\n]+$/, "")
      // Redact any credential values that slipped into the output before
      // truncation, spill, or model-visible text — defense-in-depth even
      // though filteredEnv already strips haxford's own key vars.
      const combined = redactSecrets(raw)
      const tail = truncateTail(combined, {
        maxChars: MAX_OUTPUT_CHARS,
        maxLines: MAX_OUTPUT_LINES,
      })

      const notes: string[] = []
      let fullOutputPath: string | null = null
      if (tail.truncated) {
        fullOutputPath = await spill(combined)
        const scope =
          tail.truncatedBy === "lines"
            ? `Showing the last ${tail.shownLines} of ${tail.totalLines} lines`
            : `Showing the last ${tail.text.length} of ${tail.totalChars} characters`
        notes.push(
          fullOutputPath
            ? `[${scope}. Full output: ${fullOutputPath} — read or grep that file for the rest.]`
            : `[${scope}. Re-run filtered through grep/head/tail to see the rest.]`,
        )
      }
      if (timedOut) {
        notes.push(`[Command timed out after ${timeout}ms and was killed.]`)
      } else if (exitCode !== 0) {
        notes.push(`[Exit code ${exitCode}]`)
      }

      const body = tail.text === "" ? "(no output)" : tail.text
      return {
        title,
        output: notes.length ? `${body}\n\n${notes.join("\n")}` : body,
        metadata: {
          command,
          exitCode,
          timedOut,
          truncated: tail.truncated,
          truncatedBy: tail.truncatedBy,
          totalLines: tail.totalLines,
          totalChars: tail.totalChars,
          ...(fullOutputPath ? { fullOutputPath } : {}),
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
