import { Box } from "ink"
import React from "react"

import { ruleProps } from "../theme.ts"

export interface RuleProps {
  /** Rule colour; defaults to the structural dim grey. */
  color?: string
}

/**
 * A full-width horizontal rule.
 *
 * Implemented as a Box drawing only its bottom edge, so Yoga measures the
 * width and the line spans the terminal exactly at any size — no column count
 * to read, no resize listener to keep in sync, no `"─".repeat(n)` that is one
 * cell wrong on a wide glyph.
 */
export function Rule({ color }: RuleProps): React.ReactElement {
  return <Box {...ruleProps(color)} />
}
