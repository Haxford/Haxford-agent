/**
 * Shared vertical-rhythm rules for the transcript.
 *
 * Extracted from Transcript.tsx so Markdown.tsx and Diff.tsx can obey the same
 * spacing law without importing the component that renders them (which would
 * be a cycle). Transcript.tsx re-exports these, so existing importers are
 * unaffected.
 */

/**
 * Blank lines to insert before an item, given whether it and its predecessor
 * are multi-line.
 *
 * opencode's rule, and the single biggest source of visual rhythm: a run of
 * one-line tool calls packs into a tight scannable stack, while anything with
 * a body gets air around it. A uniform `gap={1}` spaces everything equally,
 * which is the same as spacing nothing — that flatness is what read as
 * "minimal and plain".
 */
export function separatorBefore(
  prevMultiline: boolean | undefined,
  curMultiline: boolean,
): 0 | 1 {
  if (prevMultiline === undefined) return 0
  return prevMultiline || curMultiline ? 1 : 0
}
