import { useEffect, useRef } from "react"

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
