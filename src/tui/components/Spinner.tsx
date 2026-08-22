import { Text } from "ink"
import React, { createContext, useContext, useState } from "react"

import { useInterval } from "../hooks.ts"
import { theme } from "../theme.ts"

/**
 * One shared spinner ticker for the whole app.
 *
 * Previously the status bar and every running tool row each owned a private
 * `useInterval(…, 90)`. With N running tools that is N+1 independent timers,
 * each firing a `setState` that re-rendered the entire transcript ~11 times a
 * second per timer. This module hoists the tick to a single interval whose one
 * state update serves every spinner on screen.
 */

/** Braille spinner frames. */
export const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const

/** Milliseconds per frame. */
const TICK_MS = 100

/**
 * Current frame index. Defaults to 0 so components render a stable glyph when
 * mounted outside a provider (as they are in unit tests).
 */
const SpinnerContext = createContext(0)

export interface SpinnerProviderProps {
  /** Advance the ticker only while true; idle sessions burn no timer. */
  active: boolean
  children: React.ReactNode
}

/** Drives the shared tick. Mount once, near the root. */
export function SpinnerProvider({ active, children }: SpinnerProviderProps): React.ReactElement {
  const [i, setI] = useState(0)
  useInterval(() => setI((n) => (n + 1) % FRAMES.length), active ? TICK_MS : null)
  // Park on frame 0 while inactive so a stopped spinner is deterministic
  // (and so the frame does not jump when a run starts).
  return <SpinnerContext.Provider value={active ? i : 0}>{children}</SpinnerContext.Provider>
}

/** The current spinner glyph. */
export function useSpinnerFrame(): string {
  const i = useContext(SpinnerContext)
  return FRAMES[i % FRAMES.length] ?? FRAMES[0]
}

export interface SpinnerProps {
  /** Glyph colour; defaults to the theme accent. */
  color?: string
}

/** A single animated glyph reading the shared tick. */
export function Spinner({ color }: SpinnerProps): React.ReactElement {
  return <Text color={color ?? theme.accent}>{useSpinnerFrame()}</Text>
}
