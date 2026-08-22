/**
 * The git branch of the working directory, probed once per cwd and cached.
 *
 * The footer names the branch next to the cwd, and re-running `git rev-parse`
 * on every render would be both wasteful and racy. A session's branch is
 * effectively fixed at startup — switching branches mid-session is rare enough
 * that a stale label is an acceptable price for a footer that never flickers.
 *
 * Any failure (not a repo, git missing, spawn error) resolves to null and is
 * cached too, so a broken probe costs exactly one attempt.
 */

const cache = new Map<string, Promise<string | null>>()

/** Probe `git rev-parse --abbrev-ref HEAD` in `cwd`. Null when it fails. */
export function probeBranch(cwd: string): Promise<string | null> {
  const hit = cache.get(cwd)
  if (hit !== undefined) return hit
  const pending = (async () => {
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--abbrev-ref", "HEAD"], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
      })
      const out = await new Response(proc.stdout).text()
      const code = await proc.exited
      if (code !== 0) return null
      const branch = out.trim()
      return branch.length > 0 ? branch : null
    } catch {
      return null
    }
  })()
  cache.set(cwd, pending)
  return pending
}

/** Test seam: forget every cached probe. */
export function clearBranchCache(): void {
  cache.clear()
}
