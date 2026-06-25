#!/bin/sh
# AgentRail curl|sh installer
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/Bensigo/agentrail/main/install.sh | sh
#
# Environment overrides:
#   AGENTRAIL_VERSION     – install a specific version (default: latest)
#   AGENTRAIL_INSTALL_DIR – base install directory (default: ~/.agentrail)
#
# Internal testing overrides (not for production use):
#   _AGENTRAIL_TARBALL_URL – override tarball download URL
#   _AGENTRAIL_SHA256_URL  – override SHA-256 sidecar download URL

set -eu

REPO="Bensigo/agentrail"
INSTALL_BASE="${AGENTRAIL_INSTALL_DIR:-${HOME}/.agentrail}"

# ── helpers ──────────────────────────────────────────────────────────────────

info()  { printf '==> %s\n' "$*"; }
error() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }

# ── require python3 ──────────────────────────────────────────────────────────

if ! command -v python3 >/dev/null 2>&1; then
  error "python3 is required but was not found on your PATH.

  Install Python 3 and re-run the installer:
    https://www.python.org/downloads/

  macOS:        brew install python3
  Debian/Ubuntu: sudo apt install python3
  Fedora/RHEL:   sudo dnf install python3"
fi

PYTHON_VER=$(python3 --version 2>&1)
info "Found ${PYTHON_VER}"

# ── resolve version ───────────────────────────────────────────────────────────

if [ -n "${AGENTRAIL_VERSION:-}" ]; then
  version="${AGENTRAIL_VERSION}"
  info "Using pinned version: ${version}"
else
  info "Detecting latest release..."
  version=$(
    curl -fsSLI -o /dev/null -w '%{url_effective}' \
      "https://github.com/${REPO}/releases/latest" 2>/dev/null \
      | sed 's|.*releases/tag/v||' | tr -d '[:space:]'
  )
  [ -n "${version}" ] || error "Could not detect the latest release version from GitHub."
  info "Latest version: ${version}"
fi

# ── build URLs ────────────────────────────────────────────────────────────────

tarball="agentrail-${version}.tar.gz"

if [ -n "${_AGENTRAIL_TARBALL_URL:-}" ]; then
  tarball_url="${_AGENTRAIL_TARBALL_URL}"
else
  tarball_url="https://github.com/${REPO}/releases/download/v${version}/${tarball}"
fi

if [ -n "${_AGENTRAIL_SHA256_URL:-}" ]; then
  sha256_url="${_AGENTRAIL_SHA256_URL}"
else
  sha256_url="https://github.com/${REPO}/releases/download/v${version}/${tarball}.sha256"
fi

# ── set paths ─────────────────────────────────────────────────────────────────

install_dir="${INSTALL_BASE}/versions/${version}"
bin_dir="${INSTALL_BASE}/bin"

# ── idempotency check ─────────────────────────────────────────────────────────

if [ -d "${install_dir}" ] && [ -x "${install_dir}/scripts/agentrail" ]; then
  info "Version ${version} is already installed at ${install_dir}."
else

  # ── download ────────────────────────────────────────────────────────────────

  tmpdir=$(mktemp -d)
  tmpdir_set=1
  cleanup() {
    if [ "${tmpdir_set:-0}" = "1" ]; then
      rm -rf "${tmpdir}"
    fi
  }
  trap cleanup EXIT

  info "Downloading ${tarball_url} ..."
  curl -fsSL -o "${tmpdir}/${tarball}" "${tarball_url}"

  info "Downloading checksum ..."
  curl -fsSL -o "${tmpdir}/${tarball}.sha256" "${sha256_url}"

  # ── verify checksum ──────────────────────────────────────────────────────────

  info "Verifying checksum ..."
  expected_hash=$(awk '{print $1}' "${tmpdir}/${tarball}.sha256")
  [ -n "${expected_hash}" ] || error "Checksum file is empty or malformed."

  if command -v sha256sum >/dev/null 2>&1; then
    actual_hash=$(sha256sum "${tmpdir}/${tarball}" | awk '{print $1}')
  elif command -v shasum >/dev/null 2>&1; then
    actual_hash=$(shasum -a 256 "${tmpdir}/${tarball}" | awk '{print $1}')
  else
    error "Neither sha256sum nor shasum is available; cannot verify the download."
  fi

  if [ "${expected_hash}" != "${actual_hash}" ]; then
    error "Checksum mismatch — aborting.
  Expected: ${expected_hash}
  Got:      ${actual_hash}
  The download may be corrupt or tampered."
  fi
  info "Checksum OK."

  # ── extract ──────────────────────────────────────────────────────────────────

  info "Installing to ${install_dir} ..."
  tar --no-same-owner -xzf "${tmpdir}/${tarball}" -C "${tmpdir}"
  mkdir -p "$(dirname "${install_dir}")"
  mv "${tmpdir}/agentrail-${version}" "${install_dir}"
  chmod +x "${install_dir}/scripts/agentrail"

fi

# ── symlink ───────────────────────────────────────────────────────────────────

mkdir -p "${bin_dir}"
ln -sf "${install_dir}/scripts/agentrail" "${bin_dir}/agentrail"
info "Linked: ${bin_dir}/agentrail -> ${install_dir}/scripts/agentrail"

# ── PATH guidance ─────────────────────────────────────────────────────────────

printf '\n'
info "AgentRail ${version} installed successfully!"
printf '\n'

case ":${PATH}:" in
  *":${bin_dir}:"*)
    info "${bin_dir} is already on your PATH."
    ;;
  *)
    printf '%s\n' "  To use agentrail, add it to your PATH:"
    printf '\n'
    printf '%s\n' "  bash / zsh (~/.bashrc or ~/.zshrc):"
    # shellcheck disable=SC2016
    printf '%s\n' '    export PATH="$HOME/.agentrail/bin:$PATH"'
    printf '\n'
    printf '%s\n' "  fish (~/.config/fish/config.fish):"
    # shellcheck disable=SC2016
    printf '%s\n' '    fish_add_path $HOME/.agentrail/bin'
    printf '\n'
    printf '%s\n' "  Or for the current shell session:"
    # shellcheck disable=SC2016
    printf '%s\n' '    export PATH="$HOME/.agentrail/bin:$PATH"'
    printf '\n'
    ;;
esac

printf '%s\n' "  Verify the install:"
printf '%s\n' "    agentrail --help"
printf '\n'
