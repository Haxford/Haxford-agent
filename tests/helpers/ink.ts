import { EventEmitter } from "node:events"
import { render as inkRender, type Instance } from "ink"
import type React from "react"

/**
 * Deterministic Ink test rendering: pin BOTH `columns` and `rows` ourselves,
 * rather than trusting `ink-testing-library`'s own `render()`.
 *
 * `ink-testing-library`'s `Stdout` shim hardcodes `get columns() { return 100
 * }` — real, but NOT settable from a test, and NOT documented — and declares
 * no `rows` property at all, so `useTerminalSize` (src/tui/hooks.ts) falls
 * back to its own `DEFAULT_SIZE.rows` (24). That happens to be
 * width-deterministic already, which is why "the CI pty is 80 cols" was never
 * the actual mechanism behind tests/tui-regions.test.ts's CI-only failures —
 * see the fix there for the real cause — but it is an accident of one
 * library's internals, not something this test suite states or controls, and
 * a future bump of that dependency could silently start reading the real
 * `process.stdout` again. This module makes both dimensions explicit, local,
 * and mutable instead of leaving them to be rediscovered by source-reading.
 */

class FixedStdout extends EventEmitter {
  columns: number
  rows: number
  frames: string[] = []
  private lastFrameValue: string | undefined

  constructor(columns: number, rows: number) {
    super()
    this.columns = columns
    this.rows = rows
  }

  write = (frame: string): boolean => {
    this.frames.push(frame)
    this.lastFrameValue = frame
    return true
  }

  lastFrame = (): string | undefined => this.lastFrameValue
}

class FixedStderr extends EventEmitter {
  frames: string[] = []
  private lastFrameValue: string | undefined

  write = (frame: string): boolean => {
    this.frames.push(frame)
    this.lastFrameValue = frame
    return true
  }

  lastFrame = (): string | undefined => this.lastFrameValue
}

/** Mirrors ink-testing-library's Stdin shim exactly — same event/method shape Ink's useInput expects. */
class FixedStdin extends EventEmitter {
  isTTY: boolean
  private data: string | null = null

  constructor(options: { isTTY?: boolean } = {}) {
    super()
    this.isTTY = options.isTTY ?? true
  }

  write = (data: string): void => {
    this.data = data
    this.emit("readable")
    this.emit("data", data)
  }

  setEncoding(): void {}
  setRawMode(): void {}
  resume(): void {}
  pause(): void {}
  ref(): void {}
  unref(): void {}

  read = (): string | null => {
    const { data } = this
    this.data = null
    return data
  }
}

export interface FixedRenderOptions {
  /** @default 100 */
  columns?: number
  /** @default 40 */
  rows?: number
}

export interface FixedRenderResult {
  rerender: Instance["rerender"]
  unmount: Instance["unmount"]
  cleanup: Instance["cleanup"]
  stdout: FixedStdout
  stderr: FixedStderr
  stdin: FixedStdin
  frames: string[]
  lastFrame: () => string | undefined
}

/**
 * Render an Ink element against a fully-deterministic 100x40 terminal (or
 * whatever `columns`/`rows` are passed) — never the real `process.stdout`,
 * never a library-internal default. Same call shape as `ink-testing-library`'s
 * `render()` (same `stdin`/`stdout`/`lastFrame`/`unmount` surface), so it is a
 * drop-in swap wherever a test needs actual control over the viewport instead
 * of whatever a dependency happens to hardcode today.
 */
export function renderFixed(
  tree: React.ReactElement,
  opts: FixedRenderOptions = {},
): FixedRenderResult {
  const stdout = new FixedStdout(opts.columns ?? 100, opts.rows ?? 40)
  const stderr = new FixedStderr()
  const stdin = new FixedStdin()

  const instance = inkRender(tree, {
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    stdin: stdin as unknown as NodeJS.ReadStream,
    debug: true,
    exitOnCtrlC: false,
    patchConsole: false,
  })

  return {
    rerender: instance.rerender,
    unmount: instance.unmount,
    cleanup: instance.cleanup,
    stdout,
    stderr,
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
  }
}
