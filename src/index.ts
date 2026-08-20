#!/usr/bin/env bun
// haxford — entrypoint and wiring (coordinator-owned).
//
// Owns: CLI args, config loading, session lifecycle, user-message creation,
// loop invocation, and event plumbing into the TUI store or stdout.

// The AI SDK writes provider warnings to console.error, which corrupts the
// Ink render. Silence them before anything imports the SDK.
process.env["AI_SDK_LOG_WARNINGS"] ??= "0"

import { render } from "ink"
import React from "react"

import { runAgentLoop } from "./agent/loop.ts"
import { loadConfig } from "./config/index.ts"
import { createAskHandler, type Mode } from "./permission/engine.ts"
import { defaultModelSpec } from "./providers/index.ts"
import {
  appendMessage,
  createSession,
  getSession,
  listSessions,
  loadHistory,
  updateSessionInfo,
} from "./session/store.ts"
import { allTools } from "./tools/index.ts"
import { createApprovalBridge } from "./tui/approval.ts"
import { HaxfordApp } from "./tui/app.tsx"
import { createTuiStore } from "./tui/store.ts"
import type { HaxfordConfig } from "./types/config.ts"
import type { AgentEvent, LoopEndReason } from "./types/events.ts"
import type { Message } from "./types/message.ts"
import type { SessionInfo } from "./types/session.ts"

const HELP = `haxford — terminal AI agent harness

Usage:
  haxford [prompt...]          Start a session, optionally with an initial prompt
  haxford -c                   Resume the most recent session for this directory
  haxford -s <session-id>      Resume a specific session
  haxford -p "<prompt>"        Print mode: non-interactive, streams to stdout

Options:
  -m, --model <spec>           provider/model (default: config or anthropic/claude-sonnet-5)
      --mode <mode>            build | auto | plan  (default: build)
  -p, --print                  Non-interactive print mode
  -c, --continue               Resume latest session
  -s, --session <id>           Resume session by id
  -h, --help                   Show this help
`

interface CliArgs {
  prompt: string
  model?: string
  mode: Mode
  print: boolean
  cont: boolean
  session?: string
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    prompt: "",
    mode: "build",
    print: false,
    cont: false,
    help: false,
  }
  const words: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === "-h" || a === "--help") args.help = true
    else if (a === "-p" || a === "--print") args.print = true
    else if (a === "-c" || a === "--continue") args.cont = true
    else if (a === "-m" || a === "--model") args.model = argv[++i]
    else if (a === "-s" || a === "--session") args.session = argv[++i]
    else if (a === "--mode") {
      const m = argv[++i]
      if (m === "build" || m === "auto" || m === "plan") args.mode = m
    } else words.push(a)
  }
  args.prompt = words.join(" ")
  return args
}

/** Resolve which session to open: explicit id, latest, or fresh. */
async function openSession(
  cwd: string,
  args: CliArgs,
): Promise<{ session: SessionInfo; history: Message[] }> {
  if (args.session) {
    const session = await getSession(cwd, args.session)
    if (!session) throw new Error(`session ${args.session} not found`)
    return { session, history: await loadHistory(cwd, session.id) }
  }
  if (args.cont) {
    const [latest] = await listSessions(cwd)
    if (latest) return { session: latest, history: await loadHistory(cwd, latest.id) }
  }
  const session = await createSession(cwd)
  return { session, history: [] }
}

function userMessage(sessionID: string, text: string): Message {
  return {
    id: crypto.randomUUID(),
    sessionID,
    role: "user",
    parts: [{ id: crypto.randomUUID(), type: "text", text }],
    time: { created: Date.now() },
  }
}

/* -------------------------------------------------------------------------- */
/* Print (non-interactive) mode                                                */
/* -------------------------------------------------------------------------- */

async function runPrint(
  cwd: string,
  args: CliArgs,
  config: HaxfordConfig,
  projectInstructions: string | undefined,
): Promise<number> {
  const { session, history } = await openSession(cwd, args)
  const model = args.model ?? config.model ?? defaultModelSpec()

  // No UI to ask: gated actions are denied unless the mode allows them.
  const askPermission = createAskHandler({
    rules: config.permission,
    mode: args.mode,
    onAsk: () => "deny",
  })

  const user = userMessage(session.id, args.prompt)
  await appendMessage(cwd, session.id, user)

  const loop = runAgentLoop({
    sessionID: session.id,
    agent: "build",
    cwd,
    userText: args.prompt,
    history,
    model,
    tools: allTools(),
    config,
    projectInstructions,
    askPermission,
  })

  let reason: LoopEndReason = "end_turn"
  for await (const event of loop) {
    if (event.type === "part.delta") process.stdout.write(event.delta)
    else if (event.type === "message.updated" && event.message.role === "assistant")
      await appendMessage(cwd, session.id, event.message)
    else if (event.type === "part.updated" && event.part.type === "tool")
      process.stderr.write(`\n[tool:${event.part.tool}] ${event.part.state.status}\n`)
    else if (event.type === "notice") process.stderr.write(`[notice] ${event.message}\n`)
    else if (event.type === "error") process.stderr.write(`[error] ${event.message}\n`)
    else if (event.type === "loop.end") reason = event.reason
  }
  process.stdout.write("\n")
  return reason === "error" ? 1 : 0
}

/* -------------------------------------------------------------------------- */
/* Interactive TUI mode                                                        */
/* -------------------------------------------------------------------------- */

async function runTui(
  cwd: string,
  args: CliArgs,
  config: HaxfordConfig,
  projectInstructions: string | undefined,
): Promise<void> {
  let { session, history } = await openSession(cwd, args)
  const model = args.model ?? config.model ?? defaultModelSpec()

  const bridge = createApprovalBridge()
  const store = createTuiStore(history)
  const askPermission = createAskHandler({
    rules: config.permission,
    mode: args.mode,
    onAsk: (req) => bridge.askPermission(req),
  })

  let running = false

  const onPrompt = (text: string): void => {
    if (running) return
    running = true
    void (async () => {
      const user = userMessage(session.id, text)
      await appendMessage(cwd, session.id, user)
      store.dispatch({ type: "message.updated", message: user })
      history.push(user)

      if (session.title === "Untitled session") {
        session = { ...session, title: text.slice(0, 60) }
        await updateSessionInfo(cwd, session)
      }

      try {
        for await (const event of runAgentLoop({
          sessionID: session.id,
          agent: "build",
          cwd,
          userText: text,
          history: [...history],
          model,
          tools: allTools(),
          config,
          projectInstructions,
          askPermission,
        })) {
          store.dispatch(event)
          if (event.type === "message.updated" && event.message.role === "assistant") {
            await appendMessage(cwd, session.id, event.message)
            history = history.map((m) => (m.id === event.message.id ? event.message : m))
            if (!history.some((m) => m.id === event.message.id))
              history.push(event.message)
          }
        }
      } catch (error) {
        store.dispatch({
          type: "error",
          message: error instanceof Error ? error.message : String(error),
        })
      } finally {
        running = false
      }
    })()
  }

  const app = render(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model,
      mode: args.mode,
      onPrompt,
      onExit: () => {
        app.unmount()
        process.exit(0)
      },
      onNewSession: () => {
        void (async () => {
          session = await createSession(cwd)
          history = []
          store.reset([])
        })()
      },
      listSessions: () => listSessions(cwd),
      onResumeSession: (id: string) => {
        void (async () => {
          const s = await getSession(cwd, id)
          if (!s) return
          session = s
          history = await loadHistory(cwd, id)
          store.reset(history)
        })()
      },
    }),
  )

  if (args.prompt) onPrompt(args.prompt)
}

/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    process.stdout.write(HELP)
    return
  }

  const cwd = process.cwd()
  const { config, projectInstructions } = await loadConfig(cwd)

  if (args.print) {
    if (!args.prompt) {
      process.stderr.write("print mode requires a prompt\n")
      process.exit(2)
    }
    process.exit(await runPrint(cwd, args, config, projectInstructions))
  }

  if (!process.stdout.isTTY) {
    process.stderr.write("interactive mode requires a TTY; use -p for print mode\n")
    process.exit(2)
  }
  await runTui(cwd, args, config, projectInstructions)
}

main().catch((error) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : error}\n`)
  process.exit(1)
})
