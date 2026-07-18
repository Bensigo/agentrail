"""Shared git clone-authentication helpers (#1268).

Every sandbox path that clones a possibly-private repo over HTTPS — the
host-native runner (:mod:`agentrail.sandbox.native_runner`) and the onboard
work-kind handler (:mod:`agentrail.runner.onboard`) alike — needs the SAME two
things: a way to embed a workspace's GitHub token into the clone URL, and a
way to strip that token back out of anything that might get reported (stdout/
stderr text, exception messages) before it can leave this host. This module is
the one source of truth for both, so the two callers can never drift apart
(before #1268, onboard's own clone never authenticated at all — see its own
module docstring).
"""
from __future__ import annotations


def authenticated_clone_url(repo_url: str, token: str) -> str:
    """Embed ``token`` as HTTP Basic auth (``x-access-token``) in an ``https://``
    clone URL, so ``git clone`` (and, since the cloned ``origin`` remote then
    carries it, every later ``git push``) authenticates as the workspace's
    connected GitHub OAuth token / a locally configured PAT — the SAME
    substitution the Docker sandbox's entrypoint already does
    (``agentrail/docker/runner/entrypoint.sh``), so every sandbox path
    authenticates identically.

    A no-op when there is no token, or the URL isn't ``https://`` (SSH remotes
    are unaffected — git's credential subsystem is HTTP(S)-only, so an SSH
    clone keeps relying on the host's own SSH keys exactly as before this
    fix).
    """
    if not token or not repo_url.startswith("https://"):
        return repo_url
    return repo_url.replace("https://", f"https://x-access-token:{token}@", 1)


def redact_token(text: str, token: str) -> str:
    """Strip a raw secret out of captured text before it can leave this host
    in anything reported back (logs_tail / gate_reason / exception strings).

    Defense in depth: git's own diagnostics do not reliably omit an embedded
    credential across versions or failure modes (verified empirically for
    #1268: a git-side auth failure and a DNS failure each omitted the
    userinfo on this host's git version, but that is not a documented
    contract to build safety on) — and, more concretely, Python's own
    ``subprocess.CalledProcessError``/``TimeoutExpired.__str__()`` ALWAYS
    embeds the raw argv it was constructed with (including a
    credential-embedded URL), regardless of what the child process itself
    printed. Any exception string that might have been built from a
    credentialed URL or command MUST be routed through this before it can
    reach a ``RunResult``/``gate_reason``/log line.
    """
    if not token:
        return text
    return text.replace(token, "***")
