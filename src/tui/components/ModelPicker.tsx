import { Box, Text, useInput, useStdout } from "ink"
import React, { useEffect, useMemo, useState } from "react"

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

/** One known provider, surfaced in the /connect flow and the model picker's level-1. */
export interface ProviderCatalogEntry {
  /** Canonical provider name, e.g. "anthropic" or "openrouter". */
  name: string
  /** Whether a credential is resolvable for this provider right now. */
  connected: boolean
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

/**
 * One row in the level-1 provider list. `connectable` means the host has a
 * `providerCatalog` entry for this provider; entries with no catalog row (e.g.
 * custom gateways) are still listed so the user can reach their models, just
 * without the "+ connect" affordance.
 */
export interface ProviderRow {
  /** Canonical provider name. */
  name: string
  /** Whether at least one of this provider's models is `available`. */
  connected: boolean
  /** Whether the provider is known to the host's catalog (has a connect flow). */
  connectable: boolean
  /** Count of models offered under this provider. */
  modelCount: number
}

/**
 * Whether a provider counts as "connected": it has at least one `available`
 * model in the list. Derived from the models prop so the picker never has to
 * trust a separate flag.
 */
export function providerConnected(
  provider: string,
  models: ModelOption[],
): boolean {
  return models.some(
    (m) => providerOf(m.spec) === provider && m.available,
  )
}

/**
 * Build the level-1 provider list from the flat model list plus an optional
 * host catalog. Connected providers come first (alphabetical); unconnected
 * catalog-known providers follow under the same alphabetical rule; the
 * trailing "+ connect a provider…" row is appended by the component, not here.
 *
 * Exported for unit testing.
 */
export function groupProviders(
  models: ModelOption[],
  catalog?: ProviderCatalogEntry[],
): ProviderRow[] {
  const names = new Set<string>()
  for (const m of models) names.add(providerOf(m.spec))
  if (catalog) for (const c of catalog) names.add(c.name)

  const catalogByName = new Map<string, ProviderCatalogEntry>()
  if (catalog) for (const c of catalog) catalogByName.set(c.name, c)

  const rows: ProviderRow[] = []
  for (const name of names) {
    const modelCount = models.filter((m) => providerOf(m.spec) === name).length
    rows.push({
      name,
      connected: providerConnected(name, models),
      connectable: catalogByName.has(name),
      modelCount,
    })
  }

  // Connected first (alphabetical), then unconnected (alphabetical).
  rows.sort((a, b) => {
    if (a.connected !== b.connected) return a.connected ? -1 : 1
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
  })
  return rows
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
  /** Optional host catalog of known providers, driving the level-1 connect rows. */
  providerCatalog?: ProviderCatalogEntry[]
  /**
   * Called when the user selects the "+ connect a provider…" row in level 1.
   * The host owns persistence and rerender. Optional so unwired hosts keep the
   * row hidden.
   */
  onProviderConnect?: (provider: string) => void
}

/** Title of the level-1 "+ connect" sentinel row. */
const CONNECT_ROW = "+ connect a provider…"

/**
 * Two-level model picker. Level 1 lists providers derived from the models
 * prop, showing connection status (connected = any available model). Only
 * connected providers are selectable normally; unconnected providers are
 * dimmed at the bottom. A trailing "+ connect a provider…" row, when a host
 * wired `onProviderConnect`, triggers the connect flow. Level 2 is the
 * existing per-provider model list with pagination, live filter, and metadata.
 *
 * Esc goes back one level from level 2, or closes the picker from level 1.
 */
export function ModelPicker({
  models,
  current,
  onSelect,
  onCancel,
  providerCatalog,
  onProviderConnect,
}: ModelPickerProps): React.ReactElement {
  const { stdout } = useStdout()
  // Reserve room for header + footer + border; never exceed 20.
  const pageSize = Math.min(DEFAULT_PAGE_SIZE, Math.max(5, (stdout?.rows ?? DEFAULT_PAGE_SIZE) - 6))

  const all = useMemo(() => normalizeModels(models), [models])

  // "level" tracks whether we are on the provider list (1) or a provider's
  // model list (2). "selectedProvider" names the provider whose models we show.
  const [level, setLevel] = useState<1 | 2>(1)
  const [selectedProvider, setSelectedProvider] = useState<string>("")
  const [query, setQuery] = useState("")
  const [page, setPage] = useState(0)
  const [cursor, setCursor] = useState(0)

  // --- Level 1: provider list --------------------------------------------
  const providerRows = useMemo(
    () => groupProviders(all, providerCatalog),
    [all, providerCatalog],
  )
  // Filter the provider list live (by name). Connected first regardless.
  const filteredProviders = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (q.length === 0) return providerRows
    return providerRows.filter((r) => r.name.toLowerCase().includes(q))
  }, [providerRows, query])
  const providerPages = pageCount(filteredProviders.length, pageSize)
  const safeProviderPage = Math.min(page, providerPages - 1)
  const pageProviders = useMemo(
    () => paginate(filteredProviders, safeProviderPage, pageSize),
    [filteredProviders, safeProviderPage, pageSize],
  )
  // The connect row lives at the bottom of the last page only, and only when a
  // host wired the callback.
  const showConnectRow = onProviderConnect !== undefined
  const rowCount = pageProviders.length + (showConnectRow ? 1 : 0)
  const safeProviderCursor = rowCount === 0 ? 0 : Math.min(cursor, rowCount - 1)

  // --- Level 2: a provider's models --------------------------------------
  const providerModels = useMemo(
    () => (selectedProvider.length > 0
      ? all.filter((m) => providerOf(m.spec) === selectedProvider)
      : []),
    [all, selectedProvider],
  )
  const filteredModels = useMemo(
    () => filterModels(providerModels, query),
    [providerModels, query],
  )
  const modelPages = pageCount(filteredModels.length, pageSize)
  const safeModelPage = Math.min(page, modelPages - 1)
  const pageModels = useMemo(
    () => paginate(filteredModels, safeModelPage, pageSize),
    [filteredModels, safeModelPage, pageSize],
  )
  const safeModelCursor = pageModels.length === 0 ? 0 : Math.min(cursor, pageModels.length - 1)

  // Reset cursor + page whenever the level or the visible slice changes scope.
  useEffect(() => {
    setCursor(0)
    setPage(0)
    setQuery("")
  }, [level, selectedProvider])

  useInput((input, key) => {
    if (key.escape) {
      if (level === 2) {
        // Esc goes back one level; the provider list is restored, query cleared.
        setLevel(1)
        setSelectedProvider("")
      } else {
        onCancel()
      }
      return
    }
    if (level === 1) {
      if (key.upArrow) {
        setCursor((c) => (c <= 0 ? rowCount - 1 : c - 1))
      } else if (key.downArrow) {
        setCursor((c) => (c >= rowCount - 1 ? 0 : c + 1))
      } else if (key.leftArrow || key.pageUp) {
        setPage((p) => (p <= 0 ? providerPages - 1 : p - 1))
        setCursor(0)
      } else if (key.rightArrow || key.pageDown) {
        setPage((p) => (p >= providerPages - 1 ? 0 : p + 1))
        setCursor(0)
      } else if (key.return) {
        // The connect row is the last index when present.
        if (showConnectRow && safeProviderCursor === rowCount - 1) {
          // The host owns the full flow; the picker closes so the dialog can
          // take over input without fighting the picker for keystrokes.
          onProviderConnect?.("__connect__")
          return
        }
        const row = pageProviders[safeProviderCursor]
        if (row === undefined) return
        if (row.connected) {
          setSelectedProvider(row.name)
          setLevel(2)
        }
      } else if (input && !key.ctrl && !key.meta && input.length > 0) {
        // Live filter by substring; reset cursor + page. Accept multi-char
        // input (paste) by filtering to printable chars and appending the lot.
        const printable = input.replace(/[^\x20-\x7e]/g, "")
        if (printable.length > 0) {
          setQuery((q) => q + printable)
          setPage(0)
          setCursor(0)
        }
      } else if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1))
        setPage(0)
        setCursor(0)
      }
      return
    }

    // --- level 2: model list ---
    if (key.upArrow) {
      setCursor((c) => (c <= 0 ? pageModels.length - 1 : c - 1))
    } else if (key.downArrow) {
      setCursor((c) => (c >= pageModels.length - 1 ? 0 : c + 1))
    } else if (key.leftArrow || key.pageUp) {
      setPage((p) => (p <= 0 ? modelPages - 1 : p - 1))
      setCursor(0)
    } else if (key.rightArrow || key.pageDown) {
      setPage((p) => (p >= modelPages - 1 ? 0 : p + 1))
      setCursor(0)
    } else if (key.return) {
      const sel = pageModels[safeModelCursor]
      if (sel !== undefined && sel.available) onSelect(sel.spec)
    } else if (input && !key.ctrl && !key.meta && /^[a-zA-Z0-9 _./-]$/.test(input)) {
      setQuery((q) => q + input)
      setPage(0)
      setCursor(0)
    } else if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1))
      setPage(0)
      setCursor(0)
    }
  })

  const footer = level === 1
    ? filteredProviders.length === 0
      ? `no providers${query ? ` for ${JSON.stringify(query)}` : ""} · type to filter`
      : `${filteredProviders.length} provider${filteredProviders.length === 1 ? "" : "s"} · page ${safeProviderPage + 1}/${providerPages} · enter select · esc back · type to filter`
    : filteredModels.length === 0
      ? `no results${query ? ` for ${JSON.stringify(query)}` : ""} · type to filter`
      : `${filteredModels.length} result${filteredModels.length === 1 ? "" : "s"} · page ${safeModelPage + 1}/${modelPages} · enter select · esc back · type to filter`

  return (
    <Box flexDirection="column" {...railProps()} paddingLeft={1}>
      {/* Title left, the way out dim on the right — opencode's dialog header. */}
      <Box>
        <Text bold>{level === 1 ? "switch model" : `${selectedProvider} · models`}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>{"esc"}</Text>
        </Box>
      </Box>
      {level === 1 ? (
        pageProviders.length === 0 ? (
          <Text dimColor>{"no providers"}</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {pageProviders.map((row, i) => {
              const selected = i === safeProviderCursor
              return (
                <Box key={row.name} flexDirection="row" gap={1}>
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "▸" : " "}
                  </Text>
                  <Text
                    bold={selected && row.connected}
                    color={row.connected ? (selected ? theme.accent : undefined) : theme.muted}
                    dimColor={!row.connected}
                  >
                    {row.name}
                  </Text>
                  <Text dimColor>
                    {row.connected ? `${row.modelCount} model${row.modelCount === 1 ? "" : "s"}` : "unconnected"}
                  </Text>
                </Box>
              )
            })}
            {showConnectRow ? (
              <Box flexDirection="row" gap={1}>
                <Text color={safeProviderCursor === rowCount - 1 ? theme.accent : theme.muted}>
                  {safeProviderCursor === rowCount - 1 ? "▸" : " "}
                </Text>
                <Text bold color={theme.accent}>{CONNECT_ROW}</Text>
              </Box>
            ) : null}
          </Box>
        )
      ) : pageModels.length === 0 ? (
        <Text dimColor>{"no matches"}</Text>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          {(() => {
            const groups = groupModels(pageModels)
            let entryIdx = 0
            return groups.map((g) => (
              <Box key={g.provider} flexDirection="column">
                <Text bold color={theme.accent}>{g.provider}</Text>
                {g.entries.map((opt) => {
                  const i = entryIdx++
                  const selected = i === safeModelCursor
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
