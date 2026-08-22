import { Box, Text, useInput, useStdout } from "ink"
import React, { useMemo, useState } from "react"

import { formatCtx } from "../format.ts"
import { railProps, theme } from "../theme.ts"

/** Default rows per page when terminal height is unknown. */
const DEFAULT_PAGE_SIZE = 20

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

/**
 * Filter entries by a case-insensitive substring across spec + label. Returns
 * entries (not groups) in the same available-first, alphabetical order the
 * grouping would produce. Exported for unit testing.
 */
export function filterModels(models: ModelOption[], query: string): ModelOption[] {
  const q = query.trim().toLowerCase()
  if (q.length === 0) {
    // Unfiltered: available-first, alphabetical by spec.
    return [...models].sort((a, b) => {
      if (a.available !== b.available) return a.available ? -1 : 1
      return a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0
    })
  }
  const matches = models.filter((m) => {
    const hay = `${m.spec} ${m.label ?? ""}`.toLowerCase()
    return hay.includes(q)
  })
  return matches.sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1
    return a.spec < b.spec ? -1 : a.spec > b.spec ? 1 : 0
  })
}

/** Number of pages for a list of size `n` at `pageSize` rows per page (min 1). */
export function pageCount(n: number, pageSize: number): number {
  if (pageSize <= 0) return 1
  return Math.max(1, Math.ceil(n / pageSize))
}

/** The slice of a flat list for page `page` (0-based) at `pageSize`. */
export function paginate<T>(list: T[], page: number, pageSize: number): T[] {
  const start = page * pageSize
  if (start < 0 || start >= list.length) return []
  return list.slice(start, start + pageSize)
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

/** Re-exported from `format.ts`, which Banner shares. */
export { formatCtx }

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
  const { stdout } = useStdout()
  // Reserve room for header + footer + border; never exceed 20.
  const pageSize = Math.min(DEFAULT_PAGE_SIZE, Math.max(5, (stdout?.rows ?? DEFAULT_PAGE_SIZE) - 6))

  const all = useMemo(() => normalizeModels(models), [models])

  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [cursor, setCursor] = useState(0)

  // Filtered flat list (available-first, alphabetical) for the current query.
  const filtered = useMemo(() => filterModels(all, query), [all, query])
  const pages = pageCount(filtered.length, pageSize)
  // Clamp page into range when the filter shrinks the list.
  const safePage = Math.min(page, pages - 1)
  const pageEntries = useMemo(
    () => paginate(filtered, safePage, pageSize),
    [filtered, safePage, pageSize],
  )
  const safeCursor = pageEntries.length === 0 ? 0 : Math.min(cursor, pageEntries.length - 1)

  useInput((input, key) => {
    if (key.escape) {
      onCancel()
      return
    }
    // Printable characters filter live. Backspace is handled by TextInput; we
    // only intercept navigation here.
    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? pageEntries.length - 1 : c - 1))
    } else if (key.downArrow) {
      setCursor((c) => (c >= pageEntries.length - 1 ? 0 : c + 1))
    } else if (key.leftArrow || key.pageUp) {
      setPage((p) => (p <= 0 ? pages - 1 : p - 1))
      setCursor(0)
    } else if (key.rightArrow || key.pageDown) {
      setPage((p) => (p >= pages - 1 ? 0 : p + 1))
      setCursor(0)
    } else if (key.return) {
      const sel = pageEntries[safeCursor]
      if (sel !== undefined && sel.available) onSelect(sel.spec)
    } else if (input && !key.ctrl && !key.meta && /^[a-zA-Z0-9 _./-]$/.test(input)) {
      // Live filter by substring; reset cursor + page.
      setQuery((q) => q + input)
      setPage(0)
      setCursor(0)
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setPage(0)
      setCursor(0)
    }
  })

  const footer =
    filtered.length === 0
      ? `no results${query ? ` for ${JSON.stringify(query)}` : ""} · type to filter`
      : `${filtered.length} result${filtered.length === 1 ? "" : "s"} · page ${safePage + 1}/${pages}${query ? ` · filter: ${query}` : ""} · type to filter`

  return (
    <Box flexDirection="column" {...railProps()} paddingLeft={1}>
      {/* Title left, the way out dim on the right — opencode's dialog header. */}
      <Box>
        <Text bold>{"switch model"}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>{"esc"}</Text>
        </Box>
      </Box>
      {all.length === 0 ? (
        <Text dimColor>{"no models configured"}</Text>
      ) : pageEntries.length === 0 ? (
        <Text dimColor>{"no matches"}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {/* Group the visible page by provider, preserving the flat cursor. */}
          {(() => {
            const groups = groupModels(pageEntries)
            let entryIdx = 0
            return groups.map((g) => (
              <Box key={g.provider} flexDirection="column">
                <Text bold color={theme.accent}>{g.provider}</Text>
                {g.entries.map((opt) => {
                  const i = entryIdx++
                  const selected = i === safeCursor
                  const isCurrent = opt.spec === current
                  const meta = formatModelMeta(opt)
                  const label = displayLabel(opt)
                  return (
                    <Box key={opt.spec} flexDirection="row" gap={1}>
                      <Text color={selected ? theme.accent : theme.muted}>
                        {selected ? "▸" : " "}
                      </Text>
                      {/* A gutter dot marks the model already in use — distinct
                          from the cursor, which marks what you are about to pick. */}
                      <Text color={isCurrent ? theme.accent : undefined}>{isCurrent ? "●" : " "}</Text>
                      <Text
                        bold={selected}
                        color={opt.available ? (selected ? theme.accent : undefined) : theme.muted}
                        dimColor={!opt.available}
                      >
                        {label}
                      </Text>
                      {!opt.available ? <Text dimColor>{"needs setup"}</Text> : null}
                      {meta.length > 0 ? (
                        <Box flexGrow={1} justifyContent="flex-end">
                          <Text dimColor>{meta}</Text>
                        </Box>
                      ) : null}
                    </Box>
                  )
                })}
              </Box>
            ))
          })()}
        </Box>
      )}
      <Text dimColor>{footer}</Text>
    </Box>
  )
}
