#!/bin/sh
# weave bootstrap installer.
#
#   curl -fsSL https://raw.githubusercontent.com/weave-registry/weave/main/install.sh | sh
#
# Detects your platform, downloads the matching self-extracting installer from the latest GitHub
# release, VERIFIES it against the release's SHA256SUMS, and runs it. The heavy lifting (layout,
# launcher, post-install check, uninstall) belongs to that installer -- this script only has to get
# the right bytes safely.
#
# Options are passed through as environment variables, because a piped `sh` cannot take arguments:
#   WEAVE_VERSION=v0.2.0   install a specific tag instead of the latest
#   WEAVE_PREFIX=/usr/local install root (default $HOME/.local)
#   WEAVE_REPO=owner/name   pull from a different releases repo (a fork, or the private source)
#   GITHUB_TOKEN=...        only when WEAVE_REPO points somewhere private
#
# POSIX sh: this is the first thing a new machine runs.
set -eu

# The PUBLIC artifact repo, matching `weave upgrade`'s own default (src/cli.ts). Defaulting to the
# private source repo instead — as this did — meant the documented one-liner 404'd for everyone
# without access, and said so as "no release found", which reads like nothing was ever published
# rather than "you cannot see it". The two repos hold the same bytes; only this one is reachable.
REPO="${WEAVE_REPO:-weave-registry/weave}"
API="https://api.github.com/repos/$REPO"

say()  { printf '%s\n' "$*"; }
die()  { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- platform -------------------------------------------------------------------------------------
os=$(uname -s 2>/dev/null || echo unknown)
arch=$(uname -m 2>/dev/null || echo unknown)
case "$os" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *) die "unsupported OS: $os (weave builds for darwin and linux)" ;;
esac
case "$arch" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *) die "unsupported architecture: $arch" ;;
esac
TARGET="$os-$arch"
ASSET="weave-installer-$TARGET.sh"

# --- prerequisites --------------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  # -f so an HTTP error is a failure rather than an error page written to disk and then executed.
  fetch() { curl -fsSL ${GITHUB_TOKEN:+-H "Authorization: Bearer $GITHUB_TOKEN"} "$1"; }
elif command -v wget >/dev/null 2>&1; then
  fetch() { wget -qO- ${GITHUB_TOKEN:+--header="Authorization: Bearer $GITHUB_TOKEN"} "$1"; }
else
  die "need curl or wget"
fi
if command -v shasum >/dev/null 2>&1; then sum() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then sum() { sha256sum "$1" | cut -d' ' -f1; }
else die "need shasum or sha256sum -- refusing to install without verifying the download"
fi

# --- resolve the release --------------------------------------------------------------------------
if [ -n "${WEAVE_VERSION:-}" ]; then
  REL_URL="$API/releases/tags/$WEAVE_VERSION"
else
  REL_URL="$API/releases/latest"
fi
say "resolving weave for ${TARGET}..."
meta=$(fetch "$REL_URL" 2>/dev/null) || die "could not reach GitHub, or no release found for $REPO${GITHUB_TOKEN:+ (token rejected?)}${GITHUB_TOKEN:-  -- if WEAVE_REPO names a private repo, set GITHUB_TOKEN}"

tag=$(printf '%s' "$meta" | sed -n 's/.*"tag_name"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
[ -n "$tag" ] || die "release metadata has no tag_name"

# Pick the browser_download_url whose basename matches our asset. Parsed with sed rather than jq so
# the one-liner does not require jq on a fresh machine.
url_for() {
  printf '%s' "$meta" \
    | tr ',' '\n' \
    | sed -n 's/.*"browser_download_url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
    | grep "/$1$" \
    | head -1
}
asset_url=$(url_for "$ASSET")
sums_url=$(url_for "SHA256SUMS")
[ -n "$asset_url" ] || die "release $tag has no build for $TARGET"
[ -n "$sums_url" ]  || die "release $tag publishes no SHA256SUMS -- refusing to install unverified"

# --- download + verify ------------------------------------------------------------------------------
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t weave-boot)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "downloading $ASSET ($tag)..."
fetch "$asset_url" > "$tmp/$ASSET" || die "download failed"
fetch "$sums_url"  > "$tmp/SHA256SUMS" || die "could not fetch SHA256SUMS"

want=$(grep " \*\{0,1\}$ASSET\$" "$tmp/SHA256SUMS" | cut -d' ' -f1 | head -1)
[ -n "$want" ] || die "SHA256SUMS has no entry for $ASSET -- refusing to install unverified"
got=$(sum "$tmp/$ASSET")
[ "$want" = "$got" ] || die "checksum mismatch for $ASSET (expected $want, got $got) -- refusing to run a modified installer"

say "verified ${got}"
# The installer takes its own flags; WEAVE_PREFIX is read from the environment by it too.
sh "$tmp/$ASSET"
