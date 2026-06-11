# Homebrew formula for the AgentRail CLI.
#
# Intended for the tap bensigo/homebrew-agentrail:
#   brew tap bensigo/agentrail
#   brew install agentrail
#
# AgentRail is a stdlib-only Python CLI, so this formula bundles no Python
# dependencies — it only needs a python3 at runtime. It installs the shipped
# package tree (agentrail/ + scripts/ + skills/ + templates/) into libexec and
# symlinks the scripts/agentrail launcher onto PATH. The launcher resolves
# PYTHONPATH to libexec via its own "$script_dir/.." logic, so the CLI runs the
# flow from its own installed package — no project-local flow scripts required.
#
# url/sha256 point at the release tarball produced by .github/workflows/release.yml
# (agentrail-<version>.tar.gz, which extracts to agentrail-<version>/). Bump
# `version`, `url`, and `sha256` on each release. The sha256 below is a
# placeholder until the first real release tarball is cut and checksummed (the
# release workflow emits agentrail-<version>.tar.gz.sha256).
class Agentrail < Formula
  desc "Repo-native harness for AI coding agents (durable context, bounded execution)"
  homepage "https://github.com/Bensigo/agentrail"
  # On each release bump both the version in this URL and the sha256 below to the
  # values emitted by .github/workflows/release.yml (agentrail-<version>.tar.gz
  # and its .sha256 sidecar). Homebrew scans `version` from this URL.
  url "https://github.com/Bensigo/agentrail/releases/download/v0.1.2/agentrail-0.1.2.tar.gz"
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  # AgentRail is distributed under a proprietary license (see npm-README.md), so
  # no SPDX `license` stanza is declared here.

  depends_on "python@3.11"

  def install
    # The tarball extracts to agentrail-<version>/; Homebrew strips that top
    # directory, so the package tree is at the current dir root here.
    libexec.install "agentrail", "scripts", "skills", "templates"
    libexec.install "README.md" if File.exist?("README.md")
    chmod 0755, libexec/"scripts/agentrail"

    # The launcher (libexec/scripts/agentrail) sets PYTHONPATH to libexec and
    # resolves `python3` from PATH. A bare symlink would leave that `python3`
    # up to the user's environment — on modern macOS there may be no usable
    # system python3 at all, despite our python@3.11 dependency. So wrap the
    # launcher in an env-script that prepends the brewed python's unversioned
    # bin (python@3.x exposes libexec/bin/python3), making the CLI independent
    # of whatever python3 happens to be on PATH.
    # NOTE: validate the exact keg path on the first real `brew install`.
    py = Formula["python@3.11"]
    (bin/"agentrail").write_env_script libexec/"scripts/agentrail",
      PATH: "#{py.opt_libexec}/bin:$PATH"
  end

  test do
    assert_match "Usage", shell_output("#{bin}/agentrail --help")
  end
end
