#!/usr/bin/env bash
# CI dry-run test for install.sh
#
# Builds a minimal stub release tarball, runs install.sh against it via
# local file:// URLs, and asserts:
#   1. The launcher symlink lands on PATH and 'agentrail --help' runs.
#   2. Re-running the installer is idempotent (no errors, symlink unchanged).
#   3. AGENTRAIL_VERSION pins the installed version directory.
#   4. Missing python3 exits non-zero with a clear, actionable error.
#
# Requires: bash, tar, curl, python3, sha256sum or shasum
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SH="${REPO_ROOT}/install.sh"

fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
pass() { printf 'PASS: %s\n' "$*"; }

# ── scratch space ─────────────────────────────────────────────────────────────

tmp_root=$(mktemp -d)
cleanup() { rm -rf "${tmp_root}"; }
trap cleanup EXIT

stub_dir="${tmp_root}/stub"
install_dir="${tmp_root}/install"
VERSION="0.0.0-test"

# ── build stub tarball ────────────────────────────────────────────────────────
# Mirrors the layout produced by .github/workflows/release.yml:
#   agentrail-<version>/scripts/agentrail   (launcher)
#   agentrail-<version>/agentrail/cli/main.py
#   agentrail-<version>/agentrail/skills/
#   agentrail-<version>/agentrail/templates/

stage="${stub_dir}/agentrail-${VERSION}"
mkdir -p "${stage}/scripts"
mkdir -p "${stage}/agentrail/cli"
mkdir -p "${stage}/agentrail/skills"
mkdir -p "${stage}/agentrail/templates"

# Stub launcher: resolves PYTHONPATH and calls main.py — matches the real launcher.
cat > "${stage}/scripts/agentrail" << 'LAUNCHER'
#!/usr/bin/env bash
set -euo pipefail
source_path="${BASH_SOURCE[0]}"
while [[ -L "$source_path" ]]; do
  source_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
  linked_path="$(readlink "$source_path")"
  if [[ "$linked_path" == /* ]]; then
    source_path="$linked_path"
  else
    source_path="${source_dir}/${linked_path}"
  fi
done
script_dir="$(cd -P "$(dirname "$source_path")" && pwd)"
repo_dir="$(cd "${script_dir}/.." && pwd)"
export PYTHONPATH="${repo_dir}${PYTHONPATH:+:${PYTHONPATH}}"
exec python3 -m agentrail.cli.main "$@"
LAUNCHER
chmod +x "${stage}/scripts/agentrail"

# Stub CLI: always prints usage (sufficient for --help smoke test).
cat > "${stage}/agentrail/cli/main.py" << 'MAIN'
print("Usage: agentrail [OPTIONS] COMMAND [ARGS]...")
MAIN

# Minimal package init so `python3 -m agentrail.cli.main` resolves.
touch "${stage}/agentrail/__init__.py"
touch "${stage}/agentrail/cli/__init__.py"
touch "${stage}/agentrail/skills/.gitkeep"
touch "${stage}/agentrail/templates/.gitkeep"

# Build tarball (mirrors release.yml exactly).
tarball="agentrail-${VERSION}.tar.gz"
(cd "${stub_dir}" && tar --numeric-owner --owner=0 --group=0 -czf "${tarball}" "agentrail-${VERSION}")

# Write sha256 sidecar (mirrors release.yml: sha256sum writes "<hash>  <file>").
(
  cd "${stub_dir}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "${tarball}" > "${tarball}.sha256"
  else
    shasum -a 256 "${tarball}" > "${tarball}.sha256"
  fi
)

tarball_path="${stub_dir}/${tarball}"
sha256_path="${stub_dir}/${tarball}.sha256"

# ── test 1: happy-path install ────────────────────────────────────────────────

AGENTRAIL_VERSION="${VERSION}" \
  AGENTRAIL_INSTALL_DIR="${install_dir}" \
  _AGENTRAIL_TARBALL_URL="file://${tarball_path}" \
  _AGENTRAIL_SHA256_URL="file://${sha256_path}" \
  sh "${INSTALL_SH}" > "${tmp_root}/install1.out" 2>&1

symlink="${install_dir}/bin/agentrail"
[[ -L "${symlink}" ]] || fail "symlink not created at ${symlink}"

symlink_target=$(readlink "${symlink}")
expected_target="${install_dir}/versions/${VERSION}/scripts/agentrail"
[[ "${symlink_target}" == "${expected_target}" ]] \
  || fail "symlink points to '${symlink_target}', expected '${expected_target}'"

help_out=$(PATH="${install_dir}/bin:${PATH}" agentrail --help 2>&1)
printf '%s\n' "${help_out}" | grep -qi "usage" \
  || fail "'agentrail --help' did not print usage; got: ${help_out}"

pass "happy-path install"

# ── test 2: idempotency ───────────────────────────────────────────────────────

AGENTRAIL_VERSION="${VERSION}" \
  AGENTRAIL_INSTALL_DIR="${install_dir}" \
  _AGENTRAIL_TARBALL_URL="file://${tarball_path}" \
  _AGENTRAIL_SHA256_URL="file://${sha256_path}" \
  sh "${INSTALL_SH}" > "${tmp_root}/install2.out" 2>&1

grep -q "already installed" "${tmp_root}/install2.out" \
  || fail "second run did not report 'already installed'"

symlink2="${install_dir}/bin/agentrail"
[[ -L "${symlink2}" ]] || fail "symlink missing after second run"

pass "idempotency"

# ── test 3: AGENTRAIL_VERSION pins the install directory ─────────────────────

VERSION2="0.0.1-test"
stage2="${stub_dir}/agentrail-${VERSION2}"
cp -R "${stage}" "${stage2}"
# Rename the inner directory to match VERSION2.
(cd "${stub_dir}" && tar --numeric-owner --owner=0 --group=0 -czf "agentrail-${VERSION2}.tar.gz" "agentrail-${VERSION2}")
(
  cd "${stub_dir}"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "agentrail-${VERSION2}.tar.gz" > "agentrail-${VERSION2}.tar.gz.sha256"
  else
    shasum -a 256 "agentrail-${VERSION2}.tar.gz" > "agentrail-${VERSION2}.tar.gz.sha256"
  fi
)

AGENTRAIL_VERSION="${VERSION2}" \
  AGENTRAIL_INSTALL_DIR="${install_dir}" \
  _AGENTRAIL_TARBALL_URL="file://${stub_dir}/agentrail-${VERSION2}.tar.gz" \
  _AGENTRAIL_SHA256_URL="file://${stub_dir}/agentrail-${VERSION2}.tar.gz.sha256" \
  sh "${INSTALL_SH}" > "${tmp_root}/install3.out" 2>&1

[[ -d "${install_dir}/versions/${VERSION2}" ]] \
  || fail "pinned version ${VERSION2} directory not created"

symlink3="${install_dir}/bin/agentrail"
symlink3_target=$(readlink "${symlink3}")
[[ "${symlink3_target}" == "${install_dir}/versions/${VERSION2}/scripts/agentrail" ]] \
  || fail "symlink not updated to pinned version ${VERSION2}; got: ${symlink3_target}"

pass "AGENTRAIL_VERSION pin"

# ── test 4: missing python3 → clear error, no partial install ─────────────────

install_dir_nopy="${tmp_root}/install-nopy"

# Build a PATH with symlinks to tools install.sh needs but intentionally
# omitting python3, mirroring the pattern in scripts/test-install.
no_python3_bin="${tmp_root}/no-python3-bin"
mkdir -p "${no_python3_bin}"
for bin in curl tar awk sed shasum sha256sum mktemp dirname; do
  bin_path=$(command -v "${bin}" 2>/dev/null || true)
  [ -n "${bin_path}" ] && ln -sf "${bin_path}" "${no_python3_bin}/${bin}"
done
# Intentionally do NOT add python3.

sh_bin=$(command -v sh)

set +e
no_python_output=$(
  PATH="${no_python3_bin}" \
    AGENTRAIL_VERSION="${VERSION}" \
    AGENTRAIL_INSTALL_DIR="${install_dir_nopy}" \
    _AGENTRAIL_TARBALL_URL="file://${tarball_path}" \
    _AGENTRAIL_SHA256_URL="file://${sha256_path}" \
    "${sh_bin}" "${INSTALL_SH}" 2>&1
)
no_python_exit=$?
set -e

[[ ${no_python_exit} -ne 0 ]] \
  || fail "installer should have exited non-zero when python3 is missing"

printf '%s\n' "${no_python_output}" | grep -qi "python3" \
  || fail "missing-python3 error did not mention 'python3'; got: ${no_python_output}"

[[ ! -d "${install_dir_nopy}" ]] \
  || fail "partial install directory was created despite missing python3"

pass "missing python3 → clear error, no partial install"

# ── done ──────────────────────────────────────────────────────────────────────

echo ""
echo "All install.sh tests passed."
