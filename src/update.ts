import { APP_VERSION, USER_AGENT } from "./providers/attribution.ts"
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises"
import { chmodSync } from "node:fs"
import { basename, dirname, join } from "node:path"

const REPO = "Haxford/Haxford-agent"
const API_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`

export interface UpdateCheck {
  current: string
  latest: string
  updateAvailable: boolean
}

interface Asset {
  name: string
  url: string
}

interface Release {
  tag: string
  assets: Asset[]
}

/**
 * Mirror of install.sh platform detection. Preference order matters:
 * plain build first when it can run, then the AVX2-free baseline.
 */
async function targetCandidates(): Promise<string[]> {  const osTag =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null
  if (!osTag) return []
  const archTag = process.arch === "x64" ? "x64" : process.arch === "arm64" ? "arm64" : null
  if (!archTag) return []

  let libc = ""
  if (osTag === "linux") {
    try {
      const ldd = Bun.spawnSync(["ldd", "--version"], { stdout: "pipe", stderr: "pipe" })
      const out = (ldd.stdout.toString() + ldd.stderr.toString()).toLowerCase()
      libc = out.includes("musl") || (await detectMusl()) ? "-musl" : ""
    } catch {
      // Probe failures default to glibc builds, the common case.
    }
  }

  let baseline = ""
  if (archTag === "x64") {
    let hasAvx2 = false
    try {
      if (osTag === "linux") {
        hasAvx2 = (await Bun.file("/proc/cpuinfo").text()).includes("avx2")
      } else {
        const out = Bun.spawnSync(["sysctl", "-n", "machdep.cpu.leaf7_features"], {
          stdout: "pipe",
          stderr: "ignore",
        })
        hasAvx2 = out.stdout.toString().toLowerCase().includes("avx2")
      }
    } catch {
      // Cannot prove AVX2 -> prefer baseline, matching install.sh.
    }
    baseline = hasAvx2 ? "" : "-baseline"
  }

  const base = `${osTag}-${archTag}${libc}`
  const candidates = [`${base}${baseline}`]
  if (baseline === "") candidates.push(`${base}-baseline`)
  return candidates
}

/** Test seam: platform/asset-target detection without side effects. */
export const targetCandidatesForTest = targetCandidates

async function detectMusl(): Promise<boolean> {
  try {
    for (const entry of await readdir("/lib")) {
      if (entry.startsWith("ld-musl-")) return true
    }
  } catch {
    // No /lib or unreadable - assume glibc.
  }
  return false
}

async function fetchJsonRelease(): Promise<Release | null> {
  try {
    const res = await fetch(API_LATEST, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/vnd.github+json" },
    })
    if (!res.ok) return null
    const j = (await res.json()) as {
      tag_name?: string
      assets?: { name?: string; browser_download_url?: string }[]
    }
    if (!j.tag_name || !j.assets) return null
    const assets: Asset[] = []
    for (const a of j.assets) {
      if (a.name && a.browser_download_url) assets.push({ name: a.name, url: a.browser_download_url })
    }
    return { tag: j.tag_name.replace(/^v/, ""), assets }
  } catch {
    return null
  }
}

/** Compare dotted versions; true when latest > current. */
export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map((n) => Number.parseInt(n, 10) || 0)
  const c = current.split(".").map((n) => Number.parseInt(n, 10) || 0)
  for (let i = 0; i < Math.max(l.length, c.length); i++) {
    const li = l[i] ?? 0
    const ci = c[i] ?? 0
    if (li !== ci) return li > ci
  }
  return false
}

export async function checkForUpdate(): Promise<UpdateCheck | { error: string }> {
  const release = await fetchJsonRelease()
  if (!release) return { error: "could not reach GitHub releases (offline? rate-limited?)" }
  return {
    current: APP_VERSION,
    latest: release.tag,
    updateAvailable: isNewer(release.tag, APP_VERSION),
  }
}

/**
 * The binary we are actually running from, when running as a compiled
 * standalone. In dev (`bun run src/index.ts`) execPath is bun itself.
 */
function installedBinaryPath(): string | null {
  // Under `bun run` execPath is the bun runtime itself; a compiled
  // standalone IS its own executable, so execPath is the haxford binary.
  // (Bun.embeddedFiles is unreliable here - it can be empty in standalones.)
  const exe = basename(process.execPath)
  if (exe === "bun" || exe === "bun-debug" || exe === "bunx") return null
  return process.execPath
}

async function downloadTo(url: string, dest: string): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } })
  if (!res.ok || !res.body) return `download failed: ${assetLabel(url)} (${res.status})`
  const bytes = await res.arrayBuffer()
  await Bun.write(dest, bytes)
  return ""
}

function assetLabel(url: string): string {
  return basename(new URL(url).pathname)
}

/** Pick the newest asset matching our platform candidates. */
function pickAsset(release: Release, candidates: string[]): Asset | null {
  for (const t of candidates) {
    const hit = release.assets.find((a) => a.name === `haxford-${t}.tar.gz`)
    if (hit) return hit
  }
  return null
}

export async function performUpdate(): Promise<{ ok: boolean; message: string }> {
  const self = installedBinaryPath()
  if (!self) {
    return {
      ok: false,
      message: "running from source - use `git pull && bun install` instead of haxford update",
    }
  }

  const check = await checkForUpdate()
  if ("error" in check) return { ok: false, message: check.error }
  if (!check.updateAvailable) {
    return { ok: true, message: `already up to date (haxford ${check.current})` }
  }
  console.log(`updating haxford ${check.current} -> ${check.latest}`)

  const release = await fetchJsonRelease()
  if (!release) return { ok: false, message: "could not list release assets" }
  const candidates = await targetCandidates()
  if (candidates.length === 0) {
    return { ok: false, message: `unsupported platform: ${process.platform}/${process.arch}` }
  }
  const asset = pickAsset(release, candidates)
  if (!asset) {
    return {
      ok: false,
      message: `no prebuilt binary for this platform in v${release.tag} - see install.sh`,
    }
  }

  const work = await mkdtemp(join("/tmp", "haxford-update-"))
  try {
    const tgz = join(work, asset.name)
    const err1 = await downloadTo(asset.url, tgz)
    if (err1) return { ok: false, message: err1 }

    // Verify against the release checksums before anything touches disk.
    const sumsAsset = release.assets.find((a) => a.name === "checksums.txt")
    if (sumsAsset) {
      const sumsFile = join(work, "checksums.txt")
      const err2 = await downloadTo(sumsAsset.url, sumsFile)
      if (err2) return { ok: false, message: err2 }
      const expected = (await Bun.file(sumsFile).text())
        .split("\n")
        .find((l) => l.trimEnd().endsWith(` ${asset.name}`))
        ?.trim()
        .split(/\s+/)[0]
      if (expected) {
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(await Bun.file(tgz).arrayBuffer())
        if (hasher.digest("hex") !== expected) {
          return { ok: false, message: `checksum mismatch for ${asset.name} - aborting` }
        }
      }
    }

    const extract = Bun.spawnSync(["tar", "-xzf", tgz, "-C", work])
    if (extract.exitCode !== 0) {
      return { ok: false, message: "failed to extract release tarball" }
    }
    const stagedTar = join(work, "haxford")
    if (!(await Bun.file(stagedTar).exists())) {
      return { ok: false, message: "tarball missing haxford binary" }
    }

    // Atomic-ish swap: stage beside the target so rename stays on one fs.
    const dir = dirname(self)
    await mkdir(dir, { recursive: true })
    const stagedFinal = join(dir, `.haxford-update-${Date.now()}`)
    await Bun.write(stagedFinal, Bun.file(stagedTar))
    chmodSync(stagedFinal, 0o755)
    try {
      await rename(stagedFinal, self)
    } catch (e) {
      await rm(stagedFinal, { force: true })
      const msg = e instanceof Error ? e.message : String(e)
      return { ok: false, message: `cannot replace ${self}: ${msg} (need write permission?)` }
    }
  } finally {
    await rm(work, { recursive: true, force: true })
  }
  return { ok: true, message: `updated haxford ${check.current} -> ${check.latest}` }
}
