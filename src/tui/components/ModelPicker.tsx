import { Box, Text, useInput } from "ink"
import React, { useState } from "react"

export interface ModelPickerProps {
  models: string[]
  current: string
  onSelect: (spec: string) => void
  onCancel: () => void
}

/**
 * Model picker in the SessionPicker style: arrow-key navigate, Enter select,
 * Esc cancel. The current model is marked. Empty list still renders a frame
 * with a "no models configured" hint and Esc cancels.
 */
export function ModelPicker({
  models,
  current,
  onSelect,
  onCancel,
}: ModelPickerProps): React.ReactElement {
  const [cursor, setCursor] = useState(() => {
    // Start the cursor on the current model when present.
    const idx = models.indexOf(current)
    return idx >= 0 ? idx : 0
  })

  const safeCursor = models.length === 0 ? 0 : Math.min(cursor, models.length - 1)

  useInput((_, key) => {
    if (models.length === 0) {
      if (key.escape) onCancel()
      return
    }
    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? models.length - 1 : c - 1))
    } else if (key.downArrow) {
      setCursor((c) => (c >= models.length - 1 ? 0 : c + 1))
    } else if (key.return) {
      const sel = models[safeCursor]
      if (sel !== undefined) onSelect(sel)
    } else if (key.escape) {
      onCancel()
    }
  })

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={1}>
      <Box gap={2}>
        <Text bold color="magenta">{"switch model"}</Text>
        <Text dimColor>{"↑/↓ navigate · enter select · esc cancel"}</Text>
      </Box>
      {models.length === 0 ? (
        <Text dimColor>{"no models configured"}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {models.map((spec, i) => {
            const selected = i === safeCursor
            const isCurrent = spec === current
            return (
              <Box key={`${i}:${spec}`} gap={1}>
                <Text color={selected ? "magenta" : "gray"}>
                  {selected ? "▸" : " "}
                </Text>
                <Text bold={selected} color={selected ? "white" : undefined}>
                  {spec}
                </Text>
                {isCurrent ? <Text color="green">{"(current)"}</Text> : null}
              </Box>
            )
          })}
        </Box>
      )}
    </Box>
  )
}
