import { Box, Text } from "ink"
import React from "react"

import { modeColor, theme, type ThemeMode } from "../theme.ts"

/**
 * The one thin line above the input: which mode, which model, and how to
 * change the model.
 *
 * It exists so the two facts you need before pressing Enter are adjacent to
 * where you press it. Both are slow-moving — a mode switch and a model switch
 * are deliberate acts, minutes apart — so this line is memoized on exactly
 * those two values and does not re-render for anything else, including every
 * token of a streaming reply.
 */

/**
 * The short form of a model spec: the model, without the provider that serves
 * it.
 *
 * The provider is in the banner and the picker; repeating it here would spend
 * a third of a one-line breadcrumb restating something that has not changed
 * since the session opened. Specs that carry a nested path
 * (`openrouter/z-ai/glm-5.2`) keep only the final segment, which is the part
 * that names the model.
 */
export function shortModel(spec: string): string {
  const trimmed = spec.trim()
  if (trimmed.length === 0) return trimmed
  const slash = trimmed.lastIndexOf("/")
  return slash === -1 ? trimmed : trimmed.slice(slash + 1)
}

export interface BreadcrumbProps {
  mode: ThemeMode
  /** Full model spec; rendered short. */
  model: string
}

/**
 * Renders of the breadcrumb body.
 *
 * A counter rather than a callback prop: "this line redraws only when what it
 * says changes" is the requirement, and the only way to assert it is to count.
 * Keeping the counter here instead of in the props keeps the component's
 * public shape honest — nothing about its interface exists for the tests.
 */
export const breadcrumbRenders = { count: 0 }

function BreadcrumbInner({ mode, model }: BreadcrumbProps): React.ReactElement {
  breadcrumbRenders.count++
  return (
    <Box paddingLeft={2} gap={1}>
      <Text color={modeColor(mode)}>{mode}</Text>
      <Text dimColor>·</Text>
      <Text color={theme.model}>{shortModel(model)}</Text>
      <Text dimColor>·</Text>
      <Text dimColor>{"/model to change"}</Text>
    </Box>
  )
}

/**
 * Memoized on mode and model.
 *
 * React.memo is the whole feature, not an optimization detail: the spec asks
 * for a line that redraws only when what it says changes, and this is what
 * that means inside a tree that re-renders on every streamed token.
 */
export const Breadcrumb = React.memo(BreadcrumbInner)
Breadcrumb.displayName = "Breadcrumb"
