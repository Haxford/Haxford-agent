#!/usr/bin/env bun
import { render } from "ink"
import React from "react"

import type { AgentEvent } from "../types/events.ts"
import type { PermissionRequest } from "../types/tool.ts"
import { App, type DispatchHandle } from "./app.tsx"
import { createApprovalBridge, type ApprovalBridge } from "./approval.ts"

const MODEL = "mock/haxford-demo"

/** A bash action that needs approval; the demo resolves it after a pause. */
function approvalRequest(): PermissionRequest {
  return {
    tool: "bash",
    title: "rm -rf node_modules && npm install",
    args: { command: "rm -rf node_modules && npm install" },
    sessionID: "demo",
  }
}

/** Scripted mock event sequence that visibly animates the TUI. */
function scriptedEvents(userText: string, bridge: ApprovalBridge): AgentEvent[] {
  const userMsgID = crypto.randomUUID()
  const userPartID = `${userMsgID}-p`
  const asstMsgID = crypto.randomUUID()
  const textPartID = `${asstMsgID}-t`
  const toolPartID = `${asstMsgID}-tool`
  const now = Date.now()

  const events: AgentEvent[] = [
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
    { type: "part.delta", messageID: asstMsgID, partID: textPartID, delta: "I'll need to reinstall deps." },
  ]

  // Mid-stream, emit a gated bash action: askPermission suspends, the dialog
  // appears, and the demo auto-resolves it as "allow" after a short pause so
  // the run continues even if the user doesn't press a key. The user can still
  // press a/l/d themselves — resolve() is idempotent for the first caller.
  events.push({
    type: "part.updated",
    messageID: asstMsgID,
    part: {
      id: toolPartID, type: "tool", tool: "bash", callID: "call_1",
      state: { status: "running", input: { command: "rm -rf node_modules && npm install" }, time: { start: now } },
    },
  })

  // We insert a sentinel: the playback loop detects this index and, instead of
  // dispatching immediately, calls bridge.askPermission (which renders the
  // dialog) and awaits resolution before continuing.
  ;(events[events.length - 1] as AgentEvent & { __approval?: PermissionRequest }).__approval =
    approvalRequest()

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

    // reasoning part (dimmed)
    { type: "part.updated", messageID: asstMsgID, part: {
      id: `${asstMsgID}-r`, type: "reasoning", text: "deps reinstalled, ready to proceed…",
    } },

    // usage + loop end
    { type: "usage", messageID: asstMsgID, usage: { input: 128, output: 64, reasoning: 12 } },
    { type: "turn.end", turn: 1 },
    { type: "loop.end", reason: "end_turn" },
  )

  return events
}

/** Play an event sequence on a timer so the UI animates. Approval sentinels
 *  suspend playback until the bridge is resolved. */
function playback(
  handle: DispatchHandle,
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
    const sentinel = ev as AgentEvent & { __approval?: PermissionRequest }
    if (sentinel.__approval !== undefined) {
      // Suspend the timer; the dialog appears via bridge subscription. When
      // the user (or the auto-resolve safety net) resolves, resume playback.
      clearInterval(timer)
      const req = sentinel.__approval
      void bridge.askPermission(req).then(() => {
        handle.dispatch(ev)
        // Resume the remaining events.
        playback(handle, bridge, events.slice(i), delayMs)
      })
      // Safety net: if the user doesn't press a key within 8s, auto-allow so
      // the demo doesn't hang. resolve() is a no-op if already resolved.
      setTimeout(() => bridge.resolve("allow"), 8000)
      return
    }
    handle.dispatch(ev)
  }, delayMs)
}

function main(): void {
  const handle: DispatchHandle = { dispatch: () => {} }
  const bridge = createApprovalBridge()

  const onPrompt = (value: string): void => {
    playback(handle, bridge, scriptedEvents(value, bridge))
  }

  const { rerender, unmount } = render(
    React.createElement(App, {
      model: MODEL,
      notice: "haxford demo — type a prompt, /help for commands, /exit to quit",
      handle,
      bridge,
      onPrompt,
    }) as React.ReactElement,
  )

  // Kick off an initial scripted run so the UI shows motion immediately.
  setTimeout(() => playback(handle, bridge, scriptedEvents("Reinstall my deps, please.", bridge)), 400)

  process.on("SIGINT", () => {
    unmount()
    process.exit(0)
  })

  void rerender
}

main()
