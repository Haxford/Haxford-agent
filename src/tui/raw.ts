/**
 * Synchronized terminal output (DEC private mode 2026).
 *
 * A terminal that supports it holds the screen still between `BEGIN_SYNC` and
 * `END_SYNC` and presents the result as one atomic update. Without it a redraw
 * is visible mid-flight: the erase lands, the terminal paints an empty region,
 * and the new frame lands a moment later. At streaming rates that reads as
 * flicker in the live region — the one part of the UI that redraws constantly.
 *
 * Ink offers no hook around its own writes, and bracketing them from a React
 * effect is unsafe: Ink throttles renders, so the escape pair would fence off
 * the wrong moment, and an unmatched `BEGIN_SYNC` freezes the display until
 * the terminal's own timeout fires. Instead the stream Ink writes *to* is
 * wrapped, so every frame Ink emits — however it schedules them — leaves as a
 * single already-bracketed write. There is no ordering hazard because there is
 * no second writer.
 */

/** Begin Synchronized Update (BSU). */
export const BEGIN_SYNC = "\u001B[?2026h"

/** End Synchronized Update (ESU). */
export const END_SYNC = "\u001B[?2026l"

/** The subset of a writable stream this module touches. */
export interface StreamLike {
  write(chunk: string, ...rest: unknown[]): boolean
  isTTY?: boolean | undefined
}

/**
 * Whether to bracket frames on this stream.
 *
 * Terminals that do not implement mode 2026 ignore it — an unrecognized DEC
 * private mode is discarded by the parser, not printed — so the check is about
 * the two cases where emitting it would be actively wrong:
 *
 *   - not a TTY: the output is a pipe or a file, and escapes are corruption
 *   - `TERM=dumb`: the caller has said the receiver parses nothing
 *
 * `HAXFORD_NO_SYNC=1` is the escape hatch for a terminal that mishandles it.
 */
export function synchronizedOutputEnabled(
  env: Record<string, string | undefined>,
  stream: Pick<StreamLike, "isTTY">,
): boolean {
  const off = env["HAXFORD_NO_SYNC"]
  if (off !== undefined && off !== "" && off !== "0") return false
  if (env["TERM"] === "dumb") return false
  return stream.isTTY === true
}

/** Bracket one frame. An empty frame is left alone — there is nothing to tear. */
export function wrapFrame(frame: string): string {
  if (frame.length === 0) return frame
  return BEGIN_SYNC + frame + END_SYNC
}

/**
 * A view of `stream` whose `write` emits synchronized frames.
 *
 * Returns the stream unchanged when synchronization is disabled, so callers
 * can wrap unconditionally. The result is a Proxy rather than a copy: Ink also
 * reads `columns`, `rows`, and subscribes to `resize`, and a stream's methods
 * only work when invoked on the stream itself — hence the explicit bind.
 */
export function synchronizedStdout<T extends StreamLike>(
  stream: T,
  env: Record<string, string | undefined> = process.env,
): T {
  if (!synchronizedOutputEnabled(env, stream)) return stream

  const write = (chunk: string, ...rest: unknown[]): boolean =>
    // Only text frames are bracketed. Anything else (a Buffer from an
    // unrelated writer) is passed through untouched rather than coerced.
    typeof chunk === "string"
      ? stream.write(wrapFrame(chunk), ...rest)
      : stream.write(chunk, ...rest)

  return new Proxy(stream, {
    get(target, prop, _receiver) {
      if (prop === "write") return write
      const value = Reflect.get(target, prop, target) as unknown
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value
    },
  })
}
