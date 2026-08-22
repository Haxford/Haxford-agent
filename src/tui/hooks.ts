import { useEffect, useRef, useState } from "react"

/**
 * Repeatedly invoke `callback` every `delay` ms. Pass `null` to pause.
 * The latest callback is always used without resetting the timer, so it is
 * safe to close over changing state.
 */
export function useInterval(callback: () => void, delay: number | null): void {
  const saved = useRef(callback)

  useEffect(() => {
    saved.current = callback
  }, [callback])

  useEffect(() => {
    if (delay === null) return
    const id = setInterval(() => saved.current(), delay)
    return () => clearInterval(id)
  }, [delay])
}

/** Terminal dimensions in character cells. */
export interface TerminalSize {
  columns: number
  rows: number
}

/**
 * Fallbacks for a stream that reports no size.
 *
 * ink-testing-library's stdout stub declares `columns` but no `rows`, and a
 * piped stdout has neither. 80x24 is the historical default and the only
 * defensible guess; the layout that consumes this clamps, so a wrong guess
 * costs padding, never correctness.
 */
export const DEFAULT_SIZE: TerminalSize = { columns: 80, rows: 24 }

/** A stream that may report a size and may announce changes to it. */
export interface SizedStream {
  columns?: number | undefined
  rows?: number | undefined
  on?: (event: "resize", listener: () => void) => unknown
  off?: (event: "resize", listener: () => void) => unknown
  removeListener?: (event: "resize", listener: () => void) => unknown
}

/** Read a stream's size, substituting defaults for anything missing. */
export function readSize(stream: SizedStream | undefined): TerminalSize {
  return {
    columns: stream?.columns !== undefined && stream.columns > 0 ? stream.columns : DEFAULT_SIZE.columns,
    rows: stream?.rows !== undefined && stream.rows > 0 ? stream.rows : DEFAULT_SIZE.rows,
  }
}

/**
 * Current terminal size, kept live across resizes.
 *
 * Bottom-pinning has to recompute on resize or the padding it chose for the
 * old viewport strands the composer in the middle of the new one.
 */
export function useTerminalSize(stream: SizedStream | undefined): TerminalSize {
  const [size, setSize] = useState(() => readSize(stream))

  useEffect(() => {
    if (stream?.on === undefined) return
    const onResize = (): void => setSize(readSize(stream))
    stream.on("resize", onResize)
    return () => {
      const off = stream.off ?? stream.removeListener
      off?.call(stream, "resize", onResize)
    }
  }, [stream])

  return size
}
