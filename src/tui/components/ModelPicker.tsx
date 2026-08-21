import { Box, Text, useInput } from "ink"
import React, { useMemo, useState } from "react"

/** A single selectable model entry. */
export interface ModelOption {
  /** "provider/model" (model id may itself contain slashes). */
  spec: string
  available: boolean
  /** Display label shown instead of the raw spec tail when present. */
  label?: string
  /** Context window size in tokens, for the metadata line. */
  contextLength?: number
  /** Prompt price per million tokens. */
  promptPricePerMtok?: number
  /** Completion price per million tokens. */
  completionPricePerMtok?: number
}

/** Accept either the rich entry shape or plain string[] until host wiring lands. */
export type ModelPickerModels = ModelOption[] | string[]

/** Normalize the union input to rich entries (strings default to available). */
export function normalizeModels(input: ModelPickerModels): ModelOption[] {
  if (input.length === 0) return []
  // Duck-type: a ModelOption entry is an object with a `spec` string field.
  if (typeof input[0] === "string") {
    return (input as string[]).map((spec) => ({ spec, available: true }))
  }
  return input as ModelOption[]
}

/** Provider portion of a spec (everything before the first slash). */
export function providerOf(spec: string): string {
  const slash = spec.indexOf("/")
  return slash <= 0 ? spec : spec.slice(0, slash)
}

/** Model portion of a spec (everything after the first slash). */
export function modelOf(spec: string): string {
  const slash = spec.indexOf("/")
  return slash <= 0 ? spec : spec.slice(slash + 1)
}

export interface ProviderGroup {
  provider: string
  entries: ModelOption[]
}

/**
 * Group entries by provider. Providers alphabetical; within a provider,
 * available entries first, then by spec. Exported for unit testing.
 */
export function groupModels(models: ModelOption[]): ProviderGroup[] {
  const byProvider = new Map<string, ModelOption[]>()
  for (const m of models) {
    const p = providerOf(m.spec)
    const list = byProvider.get(p)
    if (list) list.push(m)
    else byProvider.set(p, [m])
  }
  const groups = [...byProvider.entries()].map(([provider, entries]) => ({
    provider,
    entries: entries.sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      return a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0
    }),
  }))
  groups.sort((a, b) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : 0))
  return groups
}

/** Format a token count compactly: 200000 -> "200k", 1000000 -> "1M". */
export function formatCtx(n: number): string {
  if (n >= 1_000_000) {
    const whole = n % 1_000_000 === 0
    return `${whole ? n / 1_000_000 : (n / 1_000_000).toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** Format a per-million-token price: 0.15 -> "$0.15/M". */
export function formatPrice(p: number): string {
  return `$${p.toFixed(2)}/M`
}

/**
 * Right-aligned metadata string for an entry: "200k ctx · $0.15/M · $0.60/M",
 * or a ":free" badge when both prices are present and zero. Empty when no
 * metadata is available. Exported for unit testing.
 */
export function formatModelMeta(opt: ModelOption): string {
  const parts: string[] = []
  if (typeof opt.contextLength === "number" && opt.contextLength > 0) {
    parts.push(`${formatCtx(opt.contextLength)} ctx`)
  }
  const hasPrompt = typeof opt.promptPricePerMtok === "number"
  const hasCompletion = typeof opt.completionPricePerMtok === "number"
  if (hasPrompt && hasCompletion) {
    const p = opt.promptPricePerMtok!
    const c = opt.completionPricePerMtok!
    if (p === 0 && c === 0) {
      parts.push(":free")
    } else {
      parts.push(`${formatPrice(p)} · ${formatPrice(c)}`)
    }
  } else if (hasPrompt && opt.promptPricePerMtok === 0) {
    // Only prompt price known and it is free; surface the free badge.
    parts.push(":free")
  }
  return parts.join(" · ")
}

/** Display label for an entry: the rich label if present, else the spec tail. */
export function displayLabel(opt: ModelOption): string {
  if (opt.label !== undefined && opt.label.trim().length > 0) return opt.label
  return modelOf(opt.spec)
}

export interface ModelPickerProps {
  models: ModelPickerModels
  current: string
  onSelect: (spec: string) => void
  onCancel: () => void
}

/**
 * Model picker grouped by provider with headers. Available entries come first
 * within each provider; unavailable entries are greyed with a "needs setup"
 * suffix. Rich entries show a label (or spec tail) plus right-aligned dim
 * metadata. Plain string[] input is accepted and treated as all-available.
 */
export function ModelPicker({
  models,
  current,
  onSelect,
  onCancel,
}: ModelPickerProps): React.ReactElement {
  const groups = useMemo(() => groupModels(normalizeModels(models)), [models])
  // Flat list of selectable entries (headers are not selectable) for cursor math.
  const flat = useMemo(
    () => groups.flatMap((g) => g.entries),
    [groups],
  )

  const [cursor, setCursor] = useState(() => {
    const idx = flat.findIndex((m) => m.spec === current)
    return idx >= 0 ? idx : 0
  })
  const safeCursor = flat.length === 0 ? 0 : Math.min(cursor, flat.length - 1)

  useInput((_, key) => {
    if (flat.length === 0) {
      if (key.escape) onCancel()
      return
    }
    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? flat.length - 1 : c - 1))
    } else if (key.downArrow) {
      setCursor((c) => (c >= flat.length - 1 ? 0 : c + 1))
    } else if (key.return) {
      const sel = flat[safeCursor]
      if (sel !== undefined && sel.available) onSelect(sel.spec)
    } else if (key.escape) {
      onCancel()
    }
  })

  let entryIdx = 0

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={2} paddingY={1}>
      <Box gap={2}>
        <Text bold color="magenta">{"switch model"}</Text>
        <Text dimColor>{"↑/↓ navigate · enter select · esc cancel"}</Text>
      </Box>
      {flat.length === 0 ? (
        <Text dimColor>{"no models configured"}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {groups.map((g) => (
            <Box key={g.provider} flexDirection="column">
              <Text dimColor bold>{g.provider}</Text>
              {g.entries.map((opt) => {
                const i = entryIdx++
                const selected = i === safeCursor
                const isCurrent = opt.spec === current
                const meta = formatModelMeta(opt)
                const label = displayLabel(opt)
                return (
                  <Box key={opt.spec} flexDirection="row" gap={1}>
                    <Text color={selected ? "magenta" : "gray"}>
                      {selected ? "▸" : " "}
                    </Text>
                    <Text
                      bold={selected}
                      color={opt.available ? (selected ? "white" : undefined) : "gray"}
                    >
                      {label}
                    </Text>
                    {isCurrent ? <Text color="green">{"(current)"}</Text> : null}
                    {!opt.available ? <Text color="gray">{"needs setup"}</Text> : null}
                    {meta.length > 0 ? (
                      <Box flexGrow={1}>
                        <Text dimColor color={opt.available ? undefined : "gray"}> {meta}</Text>
                      </Box>
                    ) : null}
                  </Box>
                )
              })}
            </Box>
          ))}
        </Box>
      )}
    </Box>
  )
}
