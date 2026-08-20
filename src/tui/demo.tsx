#!/usr/bin/env bun
import { render } from "ink"
import React from "react"

import type { AgentEvent } from "../types/events.ts"
import { App, type DispatchHandle } from "./app.tsx"

const MODEL = "mock/haxford-demo"

/** Scripted mock event sequence that visibly animates the TUI. */
function scriptedEvents(userText: string): AgentEvent[] {
  const userMsgID = crypto.randomUUID()
  const userPartID = `${userMsgID}-p`
  const asstMsgID = crypto.randomUUID()
  const textPartID = `${asstMsgID}-t`
  const toolPartID = `${asstMsgID}-tool`
  const now = Date.now()

  return [
    // --- turn 1: user echo ---
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

    // --- assistant begins ---
    { type: "message.updated", message: {
      id: asstMsgID, sessionID: "demo", role: "assistant", model: MODEL,
      parts: [{ id: textPartID, type: "text", text: "" }],
      time: { created: now },
    } },

    // streaming deltas (word by word)
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "Let me " },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "check that " },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "for you.\n\n" },
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "Running a quick command." },

    // a bash tool call running -> completed
    { type: "part.updated", messageID: asstMsgID, part: {
      id: toolPartID, type: "tool", tool: "bash", callID: "call_1",
      state: { status: "running", input: { command: "ls -la" }, time: { start: now } },
    } },
    { type: "part.updated", messageID: asstMsgID, part: {
      id: toolPartID, type: "tool", tool: "bash", callID: "call_1",
      state: {
        status: "completed",
        input: { command: "ls -la" },
        output: "total 0\ndrwxr-xr-x 2 harry harry 6 Aug 20 21:46 src\n-rw-r--r-- 1 harry harry 0 Aug 20 21:46 README.md\nREADME.md",
        title: "ls -la",
        metadata: {},
        time: { start: now, end: now + 120 },
      },
    } },

    // reasoning part (dimmed)
    { type: "part.updated", messageID: asstMsgID, part: {
      id: `${asstMsgID}-r`, type: "reasoning", text: "considering the listing…",
    } },

    // usage + loop end
    { type: "usage", messageID: asstMsgID, usage: { input: 128, output: 64, reasoning: 12 } },
    { type: "turn.end", turn: 1 },
    { type: "loop.end", reason: "end_turn" },
  ]
}

/** Play an event sequence on a timer so the UI animates. */
function playback(handle: DispatchHandle, events: AgentEvent[], delayMs = 250): void {
  let i = 0
  const id = setInterval(() => {
    if (i >= events.length) {
      clearInterval(id)
      return
    }
    handle.dispatch(events[i]!)
    i++
  }, delayMs)
}

function main(): void {
  const handle: DispatchHandle = { dispatch: () => {} }

  const onPrompt = (value: string): void => {
    // Replay the mock sequence seeded with the user's text.
    playback(handle, scriptedEvents(value))
  }

  const { rerender, unmount } = render(
    React.createElement(App, {
      model: MODEL,
      notice: "haxford demo — type a prompt, /help for commands, /exit to quit",
      handle,
      onPrompt,
    }) as React.ReactElement,
  )

  // Kick off an initial scripted run so the UI shows motion immediately.
  setTimeout(() => playback(handle, scriptedEvents("What files are in this project?")), 300)

  // Keep refs alive (Bun + ink); exit cleanly on Ctrl-C.
  process.on("SIGINT", () => {
    unmount()
    process.exit(0)
  })

  // Touch rerender so the linter doesn't complain if unused downstream.
  void rerender
}

main()
