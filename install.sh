#!/usr/bin/env bash
# haxford installer — https://github.com/Haxford/Haxford-agent
#
#   curl -fsSL https://raw.githubusercontent.com/Haxford/Haxford-agent/main/install.sh | bash
#
# Downloads the prebuilt binary for this platform from GitHub Releases, verifies
# its checksum, and installs it to ~/.local/bin.
#
# Environment:
#   HAXFORD_VERSION          version to install (default: latest), e.g. v0.2.0
#   HAXFORD_INSTALL_DIR      where the binary lands (default: ~/.local/bin)
#   HAXFORD_NO_MODIFY_PATH   set to 1 to leave shell rc files alone
#   HAXFORD_FORCE            set to 1 to reinstall even if up to date
set -euo pipefail

REPO="${HAXFORD_REPO:-Haxford/Haxford-agent}"
DEST="${HAXFORD_INSTALL_DIR:-$HOME/.local/bin}"
STATE="${XDG_DATA_HOME:-$HOME/.local/share}/haxford"
WANT="${HAXFORD_VERSION:-latest}"

# --- output ------------------------------------------------------------------
if [ -t 1 ] && [ "${NO_COLOR:-}" = "" ]; then
  C_ACCENT=$'\033[36m'; C_BOLD=$'\033[1m'; C_DIM=$'\033[2m'
  C_WARN=$'\033[33m'; C_ERR=$'\033[31m'; C_OFF=$'\033[0m'
else
  C_ACCENT=""; C_BOLD=""; C_DIM=""; C_WARN=""; C_ERR=""; C_OFF=""
fi
step() { printf '  %s▸%s %s\n' "$C_ACCENT" "$C_OFF" "$*"; }
note() { printf '  %s%s%s\n' "$C_DIM" "$*" "$C_OFF"; }
warn() { printf '  %swarning%s %s\n' "$C_WARN" "$C_OFF" "$*" >&2; }
die()  { printf '\n  %serror%s %s\n\n' "$C_ERR" "$C_OFF" "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- transport ---------------------------------------------------------------
if have curl; then DL=curl
elif have wget; then DL=wget
else die "need curl or wget to download anything"
fi

# Existence probe. A one-byte range request costs nothing and lets a missing
# asset (404) be told apart from a broken network (000) — the old installer
# collapsed both into "no release binary" and quietly started a source build.
url_status() {
  case "$DL" in
    curl) curl -sSL -o /dev/null -r 0-0 -w '%{http_code}' "$1" 2>/dev/null || echo 000 ;;
    wget) if wget -q --spider "$1" 2>/dev/null; then echo 200
          else case "$(wget -S --spider "$1" 2>&1 || true)" in
                 *" 404"*) echo 404 ;; *) echo 000 ;;
               esac
          fi ;;
  esac
}

fetch_text() {
  case "$DL" in
    curl) curl -fsSL --retry 3 --retry-delay 1 "$1" 2>/dev/null ;;
    wget) wget -qO- "$1" 2>/dev/null ;;
  esac
}

fetch_file() {
  case "$DL" in
    curl) if [ -t 1 ]; then curl -fL --retry 3 --retry-delay 1 --progress-bar -o "$2" "$1"
          else curl -fsSL --retry 3 --retry-delay 1 -o "$2" "$1"; fi ;;
    wget) wget -q -O "$2" "$1" ;;
  esac
}

human() {
  awk -v b="$1" 'BEGIN {
    if (b >= 1048576) printf "%.1f MB", b / 1048576
    else if (b >= 1024) printf "%.0f kB", b / 1024
    else printf "%d B", b
  }'
}

# --- platform ----------------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os_tag="linux" ;;
  Darwin) os_tag="darwin" ;;
  *) die "unsupported OS: $os — build from source: https://github.com/$REPO" ;;
esac
case "$arch" in
  x86_64 | amd64) arch_tag="x64" ;;
  aarch64 | arm64) arch_tag="arm64" ;;
  *) die "unsupported architecture: $arch" ;;
esac

# Alpine and friends: a glibc-linked binary dies at exec with a bare
# "not found" from the loader, which looks like the file is missing.
libc=""
if [ "$os_tag" = linux ]; then
  if [ -n "$(echo /lib/ld-musl-* 2>/dev/null | grep -v '\*' || true)" ] \
     || (ldd --version 2>&1 || true) | grep -qi musl; then
    libc="-musl"
  fi
fi

# Bun's standard x64 build uses AVX2; without it the binary aborts with SIGILL
# on first instruction. Older CPUs and feature-masked VMs need the baseline
# build, so prefer it when the CPU cannot prove it has AVX2.
baseline=""
if [ "$arch_tag" = x64 ]; then
  if [ "$os_tag" = linux ]; then
    grep -q avx2 /proc/cpuinfo 2>/dev/null || baseline="-baseline"
  else
    sysctl -n machdep.cpu.leaf7_features 2>/dev/null | grep -qi avx2 || baseline="-baseline"
  fi
fi

# Preference order, best match first. The plain build is a legitimate second
# choice only where it can actually run: same libc, and never baseline->AVX2.
targets="${os_tag}-${arch_tag}${libc}${baseline}"
[ -n "$baseline" ] || targets="$targets ${os_tag}-${arch_tag}${libc}-baseline"

# --- version -----------------------------------------------------------------
resolve_latest() {
  local eff json
  case "$DL" in
    curl) eff="$(curl -fsSL -o /dev/null -r 0-0 -w '%{url_effective}' \
            "https://github.com/$REPO/releases/latest" 2>/dev/null || true)" ;;
    wget) eff="$(wget -S --spider "https://github.com/$REPO/releases/latest" 2>&1 \
            | sed -n 's/.*[Ll]ocation: *//p' | tail -1)" ;;
  esac
  case "$eff" in */tag/*) printf '%s\n' "${eff##*/tag/}"; return 0 ;; esac
  # The redirect is not rate limited; the API is. It is the fallback, not the path.
  json="$(fetch_text "https://api.github.com/repos/$REPO/releases/latest" || true)"
  printf '%s\n' "$json" | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1
}

if [ "$WANT" = latest ]; then
  version="$(resolve_latest || true)"
else
  case "$WANT" in v*) version="$WANT" ;; *) version="v$WANT" ;; esac
fi

if [ -n "${version:-}" ]; then
  base="https://github.com/$REPO/releases/download/$version"
else
  # Could not resolve a tag; GitHub still serves the newest assets from here.
  version="latest"
  base="https://github.com/$REPO/releases/latest/download"
fi

printf '\n%shaxford%s %s %s·%s %s\n\n' \
  "$C_BOLD$C_ACCENT" "$C_OFF" "$version" "$C_DIM" "$C_OFF" "${targets%% *}"

# --- already installed? ------------------------------------------------------
installed=""
[ -r "$STATE/version" ] && installed="$(cat "$STATE/version" 2>/dev/null || true)"
if [ "${HAXFORD_FORCE:-0}" != 1 ] && [ -n "$installed" ] && [ "$installed" = "$version" ] \
   && [ -x "$DEST/haxford" ]; then
  step "already at $version — nothing to do"
  note "reinstall with HAXFORD_FORCE=1"
  printf '\n'
  exit 0
fi

mkdir -p "$DEST" "$STATE"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# --- fetch -------------------------------------------------------------------
# Tarballs are the current format (~96 MB of binary ships as ~36 MB); the raw
# asset name is the pre-0.2 layout, kept so this script works against releases
# cut before the packaging change.
found=""
for target in $targets; do
  for asset in "haxford-${target}.tar.gz" "haxford-${target}"; do
    status="$(url_status "$base/$asset")"
    case "$status" in
      200 | 206) found="$asset"; break 2 ;;
      404) : ;;
      *) die "cannot reach GitHub Releases (status $status) — check your network or proxy" ;;
    esac
  done
done

if [ -z "$found" ]; then
  warn "no prebuilt binary published for ${targets%% *} at $version"
  # --- fallback: build from source -------------------------------------------
  have git || die "no release asset and git is not installed"
  have bun || die "no release asset and Bun is not installed — get it at https://bun.sh"
  case "$(bun --version)" in
    0.* | 1.0* | 1.1*) die "Bun $(bun --version) is too old — need >= 1.2" ;;
  esac
  step "building from source with Bun $(bun --version) — this takes a minute"
  src="$tmp/src"
  git clone --depth 1 "https://github.com/$REPO.git" "$src" >/dev/null 2>&1 \
    || die "could not clone https://github.com/$REPO.git"
  ( cd "$src" && bun install && bun run compile ) || die "source build failed (output above)"
  chmod +x "$src/haxford"
  mv -f "$src/haxford" "$DEST/haxford"
  version="source-$(cd "$src" 2>/dev/null && git rev-parse --short HEAD 2>/dev/null || echo build)"
else
  step "downloading $found"
  fetch_file "$base/$found" "$tmp/$found" || die "download failed: $base/$found"
  step "$(human "$(wc -c < "$tmp/$found")") downloaded"

  # --- verify ----------------------------------------------------------------
  if have sha256sum; then sha() { sha256sum "$1" | cut -d' ' -f1; }
  elif have shasum; then sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else sha() { echo ""; }
  fi
  sums="$(fetch_text "$base/checksums.txt" || true)"
  if [ -z "$sums" ]; then
    warn "release publishes no checksums.txt — skipping verification"
  elif [ -z "$(sha "$tmp/$found")" ]; then
    warn "no sha256sum or shasum on this system — skipping verification"
  else
    expected="$(printf '%s\n' "$sums" | awk -v f="$found" '$2 == f || $2 == "*"f {print $1}' | head -1)"
    if [ -z "$expected" ]; then
      warn "checksums.txt does not list $found — skipping verification"
    elif [ "$expected" != "$(sha "$tmp/$found")" ]; then
      die "checksum mismatch for $found — refusing to install. Retry, or report this."
    else
      step "sha256 verified"
    fi
  fi

  # --- unpack ----------------------------------------------------------------
  case "$found" in
    *.tar.gz)
      have tar || die "need tar to unpack $found"
      tar -xzf "$tmp/$found" -C "$tmp" || die "could not unpack $found"
      [ -f "$tmp/haxford" ] || die "$found did not contain a haxford binary"
      ;;
    *) mv -f "$tmp/$found" "$tmp/haxford" ;;
  esac
  chmod +x "$tmp/haxford"
  # Replace rather than write in place: an overwrite of a running binary is
  # ETXTBSY, a rename over it is not.
  mv -f "$tmp/haxford" "$DEST/haxford" || die "could not install to $DEST/haxford"
fi

printf '%s\n' "$version" > "$STATE/version"
step "installed to $DEST/haxford"

# --- smoke test --------------------------------------------------------------
if ! "$DEST/haxford" --help >/dev/null 2>&1; then
  die "the installed binary did not run. If this is an older or virtualised CPU, retry with:
    HAXFORD_VERSION=$version HAXFORD_FORCE=1 ... (baseline build)
  Otherwise please open an issue at https://github.com/$REPO/issues"
fi

# --- PATH --------------------------------------------------------------------
on_path=0
case ":$PATH:" in *":$DEST:"*) on_path=1 ;; esac

if [ "$on_path" = 0 ] && [ "${HAXFORD_NO_MODIFY_PATH:-0}" != 1 ]; then
  shell_name="$(basename "${SHELL:-sh}")"
  case "$shell_name" in
    zsh)  rc="${ZDOTDIR:-$HOME}/.zshrc"; line="export PATH=\"$DEST:\$PATH\"" ;;
    bash) if [ "$os_tag" = darwin ] && [ -f "$HOME/.bash_profile" ]; then rc="$HOME/.bash_profile"
          else rc="$HOME/.bashrc"; fi
          line="export PATH=\"$DEST:\$PATH\"" ;;
    fish) rc="${XDG_CONFIG_HOME:-$HOME/.config}/fish/config.fish"; line="fish_add_path $DEST" ;;
    *)    rc=""; line="export PATH=\"$DEST:\$PATH\"" ;;
  esac
  if [ -n "$rc" ] && { [ ! -e "$rc" ] || ! grep -qF "$DEST" "$rc"; }; then
    mkdir -p "$(dirname "$rc")"
    printf '\n# haxford\n%s\n' "$line" >> "$rc"
    step "added $DEST to PATH in ${rc/#$HOME/\~}"
    note "open a new shell, or run: $line"
  elif [ -n "$rc" ]; then
    note "$DEST is in ${rc/#$HOME/\~} already — open a new shell to pick it up"
  else
    warn "$DEST is not on your PATH — add: $line"
  fi
elif [ "$on_path" = 0 ]; then
  warn "$DEST is not on your PATH — add: export PATH=\"$DEST:\$PATH\""
fi

# A different haxford earlier on PATH silently wins every invocation.
if [ "$on_path" = 1 ]; then
  which_haxford="$(command -v haxford || true)"
  if [ -n "$which_haxford" ] && [ "$which_haxford" != "$DEST/haxford" ]; then
    warn "another haxford shadows this one: $which_haxford"
  fi
fi

# --- done --------------------------------------------------------------------
printf '\n  %sready.%s run %shaxford%s to start.\n\n' "$C_BOLD" "$C_OFF" "$C_ACCENT" "$C_OFF"
note "key         export ANTHROPIC_API_KEY=… (or /connect inside the TUI)"
note "upgrade     curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash"
note "uninstall   rm $DEST/haxford"
printf '\n'
