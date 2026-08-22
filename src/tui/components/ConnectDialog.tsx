import { Box, Text, useInput } from "ink"
import React, { useEffect, useMemo, useState } from "react"

import type { ProviderCatalogEntry } from "./ModelPicker.tsx"
import { railProps, theme } from "../theme.ts"

/**
 * Default base URLs for the built-in providers, used to pre-fill the optional
 * base URL field. Unknown providers start with an empty field.
 */
const DEFAULT_BASE_URL: Record<string, string> = {
  anthropic: "",
  openai: "",
  openrouter: "https://openrouter.ai/api/v1",
  ollama: "http://localhost:11434/v1",
  zai: "https://api.z.ai/api/paas/v4",
  moonshot: "https://api.moonshot.ai/v1",
  opencode: "https://opencode.ai/zen/v1",
  codex: "https://chatgpt.com/backend-api/codex",
}

/**
 * Mask a key for display: show asterisks. The real value lives in state only;
 * the render never echoes the secret. An empty key shows the placeholder.
 */
function maskKey(key: string): string {
  return key.length === 0 ? "" : "*".repeat(key.length)
}

/** Which form field is active. */
type Field = "key" | "baseURL"

export interface ConnectDialogProps {
  /** Known providers with their current connection status. */
  providerCatalog: ProviderCatalogEntry[]
  /** Called when the user saves the form. Persistence is the host's job. */
  onConnect: (provider: string, apiKey: string, baseURL?: string) => void
  /** Esc at the provider chooser, or the form's cancel, closes the dialog. */
  onCancel: () => void
}

/**
 * /connect flow. Two stages: a provider chooser (stage "provider") and a
 * small form with a masked key input and an editable base URL (stage "form").
 *
 * The component renders UI only; it calls `onConnect` with the entered values
 * and closes. The host owns persistence, rerender, and the notice event.
 */
export function ConnectDialog({
  providerCatalog,
  onConnect,
  onCancel,
}: ConnectDialogProps): React.ReactElement {
  const [stage, setStage] = useState<"provider" | "form">("provider")
  const [provider, setProvider] = useState<string>("")
  const [apiKey, setApiKey] = useState<string>("")
  const [baseURL, setBaseURL] = useState<string>("")
  const [field, setField] = useState<Field>("key")
  const [cursor, setCursor] = useState(0)

  // Unconnected providers first (the common case: adding a new provider),
  // then connected ones; alphabetical within each tier.
  const rows = useMemo(() => {
    return [...providerCatalog].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? 1 : -1
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    })
  }, [providerCatalog])
  const safeCursor = rows.length === 0 ? 0 : Math.min(cursor, rows.length - 1)

  // Pre-fill the base URL field when the provider is chosen.
  useEffect(() => {
    if (stage === "form" && provider.length > 0) {
      const def = DEFAULT_BASE_URL[provider]
      if (def !== undefined && baseURL === "") setBaseURL(def)
    }
  }, [stage, provider, baseURL])

  useInput((input, key) => {
    if (key.escape) {
      if (stage === "form") {
        setStage("provider")
        setApiKey("")
        setBaseURL("")
        setField("key")
      } else {
        onCancel()
      }
      return
    }

    if (stage === "provider") {
      if (rows.length === 0) return
      if (key.upArrow) {
        setCursor((c) => (c <= 0 ? rows.length - 1 : c - 1))
      } else if (key.downArrow) {
        setCursor((c) => (c >= rows.length - 1 ? 0 : c + 1))
      } else if (key.return) {
        const row = rows[safeCursor]
        if (row !== undefined) {
          setProvider(row.name)
          setStage("form")
          setField("key")
        }
      }
      return
    }

    // --- form stage ---
    if (key.tab) {
      setField((f) => (f === "key" ? "baseURL" : "key"))
      return
    }
    if (key.return) {
      if (apiKey.trim().length > 0) {
        const url = baseURL.trim().length > 0 ? baseURL.trim() : undefined
        onConnect(provider, apiKey.trim(), url)
      }
      return
    }
    if (key.backspace || key.delete) {
      if (field === "key") setApiKey((k) => k.slice(0, -1))
      else setBaseURL((b) => b.slice(0, -1))
      return
    }
    // Printable characters build the active field. Accept multi-char input
    // (paste events deliver several chars at once); filter to printable ASCII.
    if (input && !key.ctrl && !key.meta && !key.tab && input.length > 0) {
      const printable = input.replace(/[^\x20-\x7e]/g, "")
      if (printable.length === 0) return
      if (field === "key") setApiKey((k) => k + printable)
      else setBaseURL((b) => b + printable)
    }
  })

  if (stage === "provider") {
    const footer = rows.length === 0
      ? "no providers known · esc to cancel"
      : `${rows.length} provider${rows.length === 1 ? "" : "s"} · enter select · esc back`
    return (
      <Box flexDirection="column" {...railProps()} paddingLeft={1}>
        <Box>
          <Text bold>{"connect a provider"}</Text>
          <Box flexGrow={1} justifyContent="flex-end">
            <Text dimColor>{"esc"}</Text>
          </Box>
        </Box>
        {rows.length === 0 ? (
          <Text dimColor>{"no providers known"}</Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {rows.map((row, i) => {
              const selected = i === safeCursor
              return (
                <Box key={row.name} flexDirection="row" gap={1}>
                  <Text color={selected ? theme.accent : theme.muted}>
                    {selected ? "▸" : " "}
                  </Text>
                  <Text bold={selected} color={selected ? theme.accent : undefined}>
                    {row.name}
                  </Text>
                  {row.connected ? (
                    <Text dimColor color={theme.success}>{"connected"}</Text>
                  ) : null}
                </Box>
              )
            })}
          </Box>
        )}
        <Text dimColor>{footer}</Text>
      </Box>
    )
  }

  // --- form stage ---
  const keyDisplay = maskKey(apiKey)
  const keyPlaceholder = "paste your API key"
  const urlPlaceholder = "default endpoint (optional)"
  return (
    <Box flexDirection="column" {...railProps()} paddingLeft={1}>
      <Box>
        <Text bold>{`connect ${provider}`}</Text>
        <Box flexGrow={1} justifyContent="flex-end">
          <Text dimColor>{"esc"}</Text>
        </Box>
      </Box>
      <Box flexDirection="column" marginTop={1} gap={0}>
        <Box flexDirection="row" gap={1}>
          <Text color={field === "key" ? theme.accent : theme.muted}>{"key"}</Text>
          <Text color={field === "key" ? theme.accent : undefined}>
            {keyDisplay.length > 0 ? keyDisplay : keyPlaceholder}
          </Text>
        </Box>
        <Box flexDirection="row" gap={1}>
          <Text color={field === "baseURL" ? theme.accent : theme.muted}>{"url "}</Text>
          <Text color={field === "baseURL" ? theme.accent : undefined} dimColor={baseURL.length === 0}>
            {baseURL.length > 0 ? baseURL : urlPlaceholder}
          </Text>
        </Box>
      </Box>
      <Text dimColor>{"tab next field · enter save · esc back"}</Text>
    </Box>
  )
}
