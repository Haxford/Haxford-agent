#!/usr/bin/env bash
# haxford installer — https://github.com/Haxford/Haxford-agent
#
#   curl -fsSL https://raw.githubusercontent.com/Haxford/Haxford-agent/main/install.sh | bash
#
# Downloads the prebuilt binary for your platform from GitHub Releases and
# installs it to ~/.local/bin. Falls back to a source build if Bun >= 1.2 is
# available and no matching release asset exists.
set -euo pipefail

REPO="Haxford/Haxford-agent"
DEST="${HAXFORD_INSTALL_DIR:-$HOME/.local/bin}"

log() { printf '\033[1;36mhaxford\033[0m %s\n' "$*"; }
err() { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# --- platform detection ------------------------------------------------------
os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Linux) os_tag="linux" ;;
  Darwin) os_tag="darwin" ;;
  *) err "unsupported OS: $os (build from source: git clone https://github.com/$REPO)" ;;
esac
case "$arch" in
  x86_64 | amd64) arch_tag="x64" ;;
  aarch64 | arm64) arch_tag="arm64" ;;
  *) err "unsupported architecture: $arch" ;;
esac
asset="haxford-${os_tag}-${arch_tag}"

# --- install location --------------------------------------------------------
mkdir -p "$DEST"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *) log "note: $DEST is not on your PATH - add 'export PATH=\"$DEST:\$PATH\"' to your shell rc" ;;
esac

# --- try a release binary ----------------------------------------------------
url="https://github.com/$REPO/releases/latest/download/$asset"
if command -v curl >/dev/null 2>&1; then
  fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO "$2" "$1"; }
else
  fetch() { err "need curl or wget to download $1"; }
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
if fetch "$url" "$tmp/haxford" 2>/dev/null; then
  chmod +x "$tmp/haxford"
  mv -f "$tmp/haxford" "$DEST/haxford"
  log "installed $asset -> $DEST/haxford"
  "$DEST/haxford" --help >/dev/null 2>&1 || log "warning: binary did not respond to --help"
  log "run 'haxford' to start. set OPENROUTER_API_KEY or connect a provider inside the TUI (/connect)."
  exit 0
fi

# --- fallback: build from source ---------------------------------------------
log "no release binary for ${os_tag}/${arch_tag} - trying source build"
command -v git >/dev/null 2>&1 || err "git not found"
if ! command -v bun >/dev/null 2>&1; then
  err "Bun >= 1.2 not found - install it first: https://bun.sh"
fi
bun_ver="$(bun --version)"
case "$bun_ver" in
  0.* | 1.0 | 1.1*) err "Bun $bun_ver too old - need >= 1.2" ;;
esac

src="$tmp/Haxford-agent"
git clone --depth 1 "https://github.com/$REPO.git" "$src" >/dev/null 2>&1
( cd "$src" && bun install && bun run compile ) >/dev/null 2>&1 || err "source build failed"
mv -f "$src/haxford" "$DEST/haxford"
chmod +x "$DEST/haxford" 2>/dev/null || true
log "built from source and installed -> $DEST/haxford"
log "run 'haxford' to start."
