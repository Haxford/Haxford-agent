import { describe, expect, test } from "bun:test"
import { render } from "ink-testing-library"
import React from "react"

import type { SessionInfo } from "../src/types/session.ts"
import { HaxfordApp, RESUME_TIMEOUT_MS } from "../src/tui/app.tsx"
import { createApprovalBridge } from "../src/tui/approval.ts"
import { SessionPicker } from "../src/tui/components/SessionPicker.tsx"
import { createTuiStore, type TuiStore } from "../src/tui/store.ts"

/**
 * End-to-end /sessions coverage, driven headlessly through stdin.
 *
 * Contrary to the note at the top of tui-app.test.ts, @inkjs/ui's TextInput
 * *does* receive stdin under ink-testing-library: it is built on plain
 * `useInput`, and the harness renders with `exitOnCtrlC: false`, so nothing
 * intercepts the stream. The whole command path — type "/sessions", Enter,
 * navigate the picker, Enter to resume, Esc to close — is therefore testable
 * here, which is what let the two silent failure modes below be pinned down.
 */

/** Flush pending microtasks + timers so state and re-renders settle. */
function flush(ms = 40): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function session(id: string, title: string, updated: number): SessionInfo {
  return {
    id,
    title,
    directory: "/work/haxford",
    time: { created: updated - 1000, updated },
  }
}

const FAKE: SessionInfo[] = [
  session("aaaaaaaa-1111-4444-8888-aaaaaaaaaaaa", "wire up the status bar", Date.now() - 60_000),
  session("bbbbbbbb-2222-4444-8888-bbbbbbbbbbbb", "chase the resume bug", Date.now() - 7_200_000),
]

interface Harness {
  store: TuiStore
  inst: ReturnType<typeof render>
  resumed: string[]
}

function mount(
  overrides: {
    sessions?: SessionInfo[]
    listSessions?: () => Promise<SessionInfo[]>
    cwd?: string
    /** Simulate a host that resumes for real (store.reset), the default. */
    resumeLands?: boolean
  } = {},
): Harness {
  const store = createTuiStore([])
  const bridge = createApprovalBridge()
  const resumed: string[] = []
  const sessions = overrides.sessions ?? FAKE
  const resumeLands = overrides.resumeLands ?? true
  const inst = render(
    React.createElement(HaxfordApp, {
      store,
      bridge,
      model: "mock/demo",
      mode: "build",
      models: ["mock/demo"],
      ...(overrides.cwd !== undefined ? { cwd: overrides.cwd } : {}),
      onPrompt: () => {},
      onAbort: () => {},
      onModelChange: () => {},
      onModeChange: () => {},
      onExit: () => {},
      onNewSession: () => {},
      listSessions: overrides.listSessions ?? (async () => sessions),
      onResumeSession: (id: string) => {
        resumed.push(id)
        // A host that honours the resume always ends at store.reset(history).
        if (resumeLands) store.reset([])
      },
    }),
  )
  return { store, inst, resumed }
}

/** Type "/sessions" and submit, leaving the picker open. */
async function openPicker(inst: Harness["inst"]): Promise<void> {
  inst.stdin.write("/sessions")
  await flush()
  inst.stdin.write("\r")
  await flush(80)
}

describe("/sessions end to end", () => {
  test("typing /sessions opens the picker and lists the host's sessions", async () => {
    const { inst } = mount()
    await openPicker(inst)
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("resume session")
    expect(frame).toContain("wire up the status bar")
    expect(frame).toContain("chase the resume bug")
    // Relative time and a short id, so two same-titled sessions stay tellable apart.
    expect(frame).toContain("1m ago")
    expect(frame).toContain("2h ago")
    expect(frame).toContain("aaaaaaaa")
    // First row selected.
    expect(frame).toContain("▸")
    inst.unmount()
  })

  test("Enter on the picker resumes the highlighted session", async () => {
    const { inst, resumed } = mount()
    await openPicker(inst)
    inst.stdin.write("\r")
    await flush(60)
    expect(resumed).toEqual([FAKE[0]!.id])
    // The picker closes behind the selection.
    expect(inst.lastFrame() ?? "").not.toContain("resume session")
    inst.unmount()
  })

  test("down-arrow then Enter resumes the second session", async () => {
    const { inst, resumed } = mount()
    await openPicker(inst)
    inst.stdin.write("[B") // down
    await flush()
    inst.stdin.write("\r")
    await flush(60)
    expect(resumed).toEqual([FAKE[1]!.id])
    inst.unmount()
  })

  test("Esc closes the picker without resuming anything", async () => {
    const { inst, resumed } = mount()
    await openPicker(inst)
    expect(inst.lastFrame() ?? "").toContain("resume session")
    inst.stdin.write("") // esc
    await flush(60)
    const frame = inst.lastFrame() ?? ""
    expect(frame).not.toContain("resume session")
    expect(resumed).toEqual([])
    // And the composer is live again.
    expect(frame).toContain("ask anything")
    inst.unmount()
  })

  test("the composer never claims the agent is running while the picker is up", async () => {
    // Regression: `composerDisabled` covers overlays as well as runs, and the
    // placeholder read "agent running…" for both — so an idle picker looked
    // like a wedged agent.
    const { inst } = mount()
    await openPicker(inst)
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("resume session")
    expect(frame).not.toContain("agent running")
    expect(frame).toContain("esc to close")
    inst.unmount()
  })

  test("a listSessions failure is reported, not swallowed", async () => {
    const { inst } = mount({ listSessions: async () => { throw new Error("EACCES sessions dir") } })
    await openPicker(inst)
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("failed to list sessions")
    expect(frame).toContain("EACCES sessions dir")
    inst.unmount()
  })
})

describe("/sessions empty state explains the project scoping", () => {
  test("an empty list names the directory and why it is empty", async () => {
    const { inst } = mount({ sessions: [], cwd: "~/work/haxford" })
    await openPicker(inst)
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("no sessions found in ~/work/haxford")
    expect(frame).toContain("scoped to the project directory")
    inst.unmount()
  })

  test("without a wired cwd the explanation still stands", () => {
    const inst = render(
      React.createElement(SessionPicker, {
        sessions: [],
        onSelect: () => {},
        onCancel: () => {},
      }),
    )
    const frame = inst.lastFrame() ?? ""
    expect(frame).toContain("no sessions found here")
    expect(frame).toContain("scoped to the project directory")
    inst.unmount()
  })

  test("Esc still closes an empty picker", async () => {
    const { inst } = mount({ sessions: [] })
    await openPicker(inst)
    expect(inst.lastFrame() ?? "").toContain("no sessions found")
    inst.stdin.write("")
    await flush(60)
    expect(inst.lastFrame() ?? "").not.toContain("no sessions found")
    inst.unmount()
  })
})

describe("a resume the host declines is reported", () => {
  test("a swallowed resume queues a notice instead of vanishing", async () => {
    // Mirrors the host guard: `onResumeSession(id) { if (running) return }`,
    // and its sibling `if (!session) return`. Both leave the UI unchanged.
    const { store, inst, resumed } = mount({ resumeLands: false })
    await openPicker(inst)
    inst.stdin.write("\r")
    await flush(60)
    // The host was asked, and did nothing.
    expect(resumed).toHaveLength(1)
    expect(store.getState().notices).toEqual([])
    // After the grace period the app says so.
    await flush(RESUME_TIMEOUT_MS + 120)
    const notices = store.getState().notices
    expect(notices).toHaveLength(1)
    expect(notices[0]).toContain("could not resume aaaaaaaa")
    expect(notices[0]).toContain("esc to interrupt")
    expect(inst.lastFrame() ?? "").toContain("could not resume")
    inst.unmount()
  })

  test("a resume that lands stays silent", async () => {
    const { store, inst } = mount({ resumeLands: true })
    await openPicker(inst)
    inst.stdin.write("\r")
    await flush(RESUME_TIMEOUT_MS + 120)
    // store.reset bumped the epoch, so the watchdog stands down.
    expect(store.getState().epoch).toBe(1)
    expect(store.getState().notices).toEqual([])
    inst.unmount()
  })
})
