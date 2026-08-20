#!/usr/bin/env bun
import { render } from "ink"
import React from "react"

import type { AgentEvent } from "../types/events.ts"
import type { PermissionRequest } from "../types/tool.ts"
import type { Message } from "../types/message.ts"
import type { SessionInfo } from "../types/session.ts"
import { HaxfordApp } from "./app.tsx"
import { createApprovalBridge, type ApprovalBridge } from "./approval.ts"
import { createTuiStore, type TuiStore } from "./store.ts"

const MODEL = "mock/haxford-demo"
const MODE: "build" | "auto" | "plan" = "build"
const MODELS = [
  "mock/haxford-demo",
  "anthropic/claude-sonnet-4-20250514",
  "openai/gpt-4o",
  "google/gemini-2.0-flash",
]

/** A gated bash action that suspends the playback until the bridge resolves. */
interface ApprovalStep {
  __approval: PermissionRequest
}

function isApprovalStep(ev: AgentEvent): ev is AgentEvent & ApprovalStep {
  return (ev as AgentEvent & Partial<ApprovalStep>).__approval !== undefined
}

/** Scripted mock event sequence that visibly animates the TUI. */
function scriptedEvents(userText: string): AgentEvent[] {
  const userMsgID = crypto.randomUUID()
  const userPartID = `${userMsgID}-p`
  const asstMsgID = crypto.randomUUID()
  const textPartID = `${asstMsgID}-t`
  const toolPartID = `${asstMsgID}-tool`
  const now = Date.now()

  const events: AgentEvent[] = [
    { type: "turn.start", turn: 1 },
    {
      type: "message.updated",
      message: {
        id: userMsgID,
        sessionID: "demo",
        role: "user",
        parts: [{ id: userPartID, type: "text", text: userText }],
        time: { created: now },
      },
    },
    { type: "message.updated", message: {
      id: asstMsgID, sessionID: "demo", role: "assistant", model: MODEL,
      parts: [{ id: textPartID, type: "text", text: "" }],
      time: { created: now },
    } },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "Let me " },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "check that " },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "for you.\n\n" },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "I'll need to reinstall deps." },
    // A system notice (dimmed) to exercise the new event.
    { type: "notice", message: "context window at 42%" },
  ]

  // Gated bash action: a part.updated carrying an approval sentinel. The
  // playback loop calls bridge.askPermission and suspends until resolved.
  const gatedBase: Extract<AgentEvent, { type: "part.updated" }> = {
    type: "part.updated",
    messageID: asstMsgID,
    part: {
      id: toolPartID, type: "tool", tool: "bash", callID: "call_1",
      state: { status: "running", input: { command: "rm -rf node_modules && npm install" }, time: { start: now } },
    },
  }
  const gated: AgentEvent & ApprovalStep = {
    ...gatedBase,
    __approval: {
      tool: "bash",
      title: "rm -rf node_modules && npm install",
      args: { command: "rm -rf node_modules && npm install" },
      sessionID: "demo",
    },
  }
  events.push(gated)

  events.push(
    // tool completes after approval
    { type: "part.updated", messageID: asstMsgID, part: {
      id: toolPartID, type: "tool", tool: "bash", callID: "call_1",
      state: {
        status: "completed",
        input: { command: "rm -rf node_modules && npm install" },
        output: "removed node_modules\ninstalled 312 packages",
        title: "rm -rf node_modules && npm install",
        metadata: {},
        time: { start: now, end: now + 4200 },
      },
    } },
    { type: "part.updated", messageID: asstMsgID, part: {
      id: `${asstMsgID}-r`, type: "reasoning", text: "deps reinstalled, ready to proceed…",
    } },
    { type: "usage", messageID: asstMsgID, usage: { input: 128, output: 64, reasoning: 12 } },
    { type: "turn.end", turn: 1 },
    { type: "loop.end", reason: "end_turn" },
  )

  return events
}

/** Play an event sequence on a timer. Approval sentinels suspend playback. */
function playback(
  store: TuiStore,
  bridge: ApprovalBridge,
  events: AgentEvent[],
  delayMs = 350,
): void {
  let i = 0
  const timer = setInterval(() => {
    if (i >= events.length) {
      clearInterval(timer)
      return
    }
    const ev = events[i]!
    i++

    if (isApprovalStep(ev)) {
      clearInterval(timer)
      const req = ev.__approval
      void bridge.askPermission(req).then(() => {
        store.dispatch(ev) // dispatch the part.updated (tool running) after approval
        playback(store, bridge, events.slice(i), delayMs)
      })
      // Safety net: auto-allow after 8s so the demo never hangs.
      setTimeout(() => bridge.resolve("allow"), 8000)
      return
    }

    store.dispatch(ev)
  }, delayMs)
}

/** A fake user message the demo host "creates" on prompt (host owns this). */
function userMessage(text: string): Message {
  const id = crypto.randomUUID()
  return {
    id,
    sessionID: "demo",
    role: "user",
    parts: [{ id: `${id}-p`, type: "text", text }],
    time: { created: Date.now() },
  }
}

function main(): void {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  let currentModel = MODEL

  // Seed a welcome notice so the new event path is visible immediately.
  store.dispatch({ type: "notice", message: "haxford demo — type a prompt, /help for commands, /exit to quit" })

  const onPrompt = (text: string): void => {
    // Host owns creating + emitting the user message (app.tsx must NOT).
    store.dispatch({ type: "message.updated", message: userMessage(text) })
    // Replay the scripted mock events through the store.
    playback(store, bridge, scriptedEvents(text))
  }

  const onExit = (): void => {
    process.exit(0)
  }
  const onNewSession = (): void => {
    store.reset([])
    store.dispatch({ type: "notice", message: "started a fresh session" })
  }
  const onAbort = (): void => {
    // Host owns the AbortController; the demo just surfaces a notice and ends
    // the current run so the UI doesn't stay stuck on "running".
    store.dispatch({ type: "notice", message: "abort requested" })
    store.dispatch({ type: "loop.end", reason: "aborted" })
  }
  const onModelChange = (spec: string): void => {
    currentModel = spec
    store.dispatch({ type: "notice", message: `model switched to ${spec}` })
    rerender(createApp())
  }
  const listSessions = async (): Promise<SessionInfo[]> => {
    // Fake a couple of historical sessions so the picker has content.
    await new Promise((r) => setTimeout(r, 200))
    const now = Date.now()
    return [
      { id: "aaa11111-2222-3333-4444-555566667777", title: "debug build error", directory: "/demo", time: { created: now - 3600_000, updated: now - 3500_000 }, tokens: { input: 1200, output: 800 } },
      { id: "bbb22222-3333-4444-5555-666677778888", title: "refactor utils", directory: "/demo", time: { created: now - 86_400_000, updated: now - 86_000_000 } },
    ]
  }
  const onResumeSession = (id: string): void => {
    // Fake: load history (here, empty) and reset the store.
    store.reset([])
    store.dispatch({ type: "notice", message: `resumed session ${id.slice(0, 8)}` })
  }

  const createApp = (): React.ReactElement =>
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: currentModel,
      mode: MODE,
      models: MODELS,
      onPrompt,
      onAbort,
      onModelChange,
      onExit,
      onNewSession,
      listSessions,
      onResumeSession,
    })

  const { rerender, unmount } = render(createApp())

  // Kick off an initial scripted run so the UI shows motion immediately.
  setTimeout(() => {
    store.dispatch({ type: "message.updated", message: userMessage("Reinstall my deps, please.") })
    playback(store, bridge, scriptedEvents("Reinstall my deps, please."))
  }, 400)

  process.on("SIGINT", () => {
    unmount()
    process.exit(0)
  })
}

main()
