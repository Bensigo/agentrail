from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional, Type


DEFAULT_EXCLUDE_GLOBS = [
    ".git/**",
    "node_modules/**",
    "**/node_modules/**",
    "dist/**",
    "**/dist/**",
    "build/**",
    "**/build/**",
    ".next/**",
    "**/.next/**",
    "target/**",
    "coverage/**",
    "**/coverage/**",
    ".cache/**",
    ".turbo/**",
    "**/*.log",
    # Non-product artifacts that pollute code retrieval and never belong in a
    # coding agent's context: the eval corpus (incl. answer-key dirs and
    # workdir clones that duplicate real modules like run/pricing.py),
    # generated eval reports, and documentation templates.
    "evals/**",
    "**/evals/**",
    "templates/**",
    "**/templates/**",
    # Repo-structure v2 / House 2 (spec 2026-07-08, PR-7 #1138): .agentrail/
    # is the single install dir and most of its content is load-bearing
    # operating docs the factory must be able to see, so do NOT
    # blanket-exclude .agentrail/**. Only generated caches, the trimmed
    # vendor copy, and secret-bearing files are excluded below:
    #   - .agentrail/context/**  — generated index/audit/embeddings cache.
    #   - .agentrail/source/**   — trimmed vendor copy for the legacy bash
    #     installer (#404 Option B); would otherwise duplicate the whole
    #     codebase in the index.
    #   - .agentrail/batch/**    — generated batch-run scratch space.
    #   - .agentrail/server.json — live API key/secrets; must never be
    #     indexed even if secretRedaction is reconfigured (also denied
    #     below for defense in depth).
    # .agentrail/runs/** and .agentrail/handoffs/** are deliberately NOT
    # excluded: they hold run/handoff artifacts (findings.json,
    # blockedReason, review-fix notes, …) that context/index.py's
    # prior-mistake surfacing (parsed_json_prior_mistake /
    # markdown_prior_mistake) depends on to warn agents away from repeating
    # past mistakes. Note this is orthogonal to whether the installed
    # .agentrail/.gitignore tracks these paths in git (D3) — un-tracked
    # files can and must still be indexed for retrieval.
    ".agentrail/context/**",
    ".agentrail/source/**",
    ".agentrail/batch/**",
    ".agentrail/server.json",
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*credentials*",
    "**/*secret*",
]

DEFAULT_DENY_GLOBS = [
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/*credentials*",
    "**/*secret*",
    ".agentrail/server.json",
]


@dataclass
class SecretRedactionConfig:
    enabled: bool = True
    action: str = "exclude"
    denyGlobs: List[str] = field(default_factory=lambda: list(DEFAULT_DENY_GLOBS))


@dataclass
class PackCutoffConfig:
    # Adaptive confidence cutoff (#1096): trim the pack's low-confidence tail by a
    # RELATIVE threshold on score.final. Default-OFF (like ``daemonAutoSpawn``) so
    # flag-OFF behaviour is byte-identical to today; flip during the testing phase.
    enabled: bool = False       # default-OFF, like daemonAutoSpawn
    minScoreRatio: float = 0.4  # keep items with score.final >= ratio * top score


@dataclass
class ProviderConfig:
    mode: str = "disabled"
    provider: Optional[str] = None
    model: Optional[str] = None
    command: Optional[str] = None
    customCommand: Optional[str] = None
    baseUrl: Optional[str] = None
    apiKeyEnv: Optional[str] = None

    @classmethod
    def from_dict(cls: Type["ProviderConfig"], value: Dict[str, Any] | None) -> "ProviderConfig":
        data = value or {}
        return cls(
            mode=str(data.get("mode") or "disabled"),
            provider=str(data["provider"]) if data.get("provider") is not None else None,
            model=str(data["model"]) if data.get("model") is not None else None,
            command=str(data["command"]) if data.get("command") is not None else None,
            customCommand=str(data["customCommand"]) if data.get("customCommand") is not None else None,
            baseUrl=str(data["baseUrl"]) if data.get("baseUrl") is not None else None,
            apiKeyEnv=str(data["apiKeyEnv"]) if data.get("apiKeyEnv") is not None else None,
        )


@dataclass
class WikiConfig:
    """Repo Wiki source-custody switch (spec open question 1:
    docs/superpowers/specs/2026-07-23-repo-wiki-compiled-repo-knowledge-design.md
    §4.2 "Source custody" — `sourceCustody.wikiUploadAllowed`). This dataclass
    does not decide the enterprise default (that is the open question); it
    only wires the per-workspace off-switch through to the push client.

    When ``upload`` is False, ``agentrail/context/wiki_push.py`` skips the
    network entirely — self-hosters who disable it keep a fully local wiki
    (Jace then answers from workspace memory, as today).
    """

    upload: bool = True

    @classmethod
    def from_dict(cls: Type["WikiConfig"], value: Dict[str, Any] | None) -> "WikiConfig":
        data = value or {}
        return cls(upload=bool(data.get("upload", True)))


@dataclass
class ContextConfig:
    includeGlobs: List[str] = field(default_factory=lambda: ["**/*"])
    excludeGlobs: List[str] = field(default_factory=lambda: list(DEFAULT_EXCLUDE_GLOBS))
    maxFileSizeBytes: int = 262144
    skipBinary: bool = True
    respectGitIgnore: bool = True
    secretRedaction: SecretRedactionConfig = field(default_factory=SecretRedactionConfig)
    embedding: ProviderConfig = field(default_factory=ProviderConfig)
    summary: ProviderConfig = field(default_factory=ProviderConfig)
    externalSources: List[Dict[str, Any]] = field(default_factory=list)
    codebaseUnits: List[Dict[str, Any]] = field(default_factory=list)
    daemonAutoSpawn: bool = False
    packCutoff: PackCutoffConfig = field(default_factory=PackCutoffConfig)
    wiki: WikiConfig = field(default_factory=WikiConfig)


def read_context_config(target_dir: Path) -> ContextConfig:
    config_path = target_dir / ".agentrail" / "config.json"
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return ContextConfig()
    except Exception as error:
        raise RuntimeError(f"invalid .agentrail/config.json: {error}") from error

    context = raw.get("context") if isinstance(raw, dict) else {}
    if not isinstance(context, dict):
        context = {}
    redaction_raw = context.get("secretRedaction") if isinstance(context.get("secretRedaction"), dict) else {}
    redaction = SecretRedactionConfig(
        enabled=bool(redaction_raw.get("enabled", True)),
        action=str(redaction_raw.get("action", "exclude")),
        denyGlobs=redaction_raw.get("denyGlobs") if isinstance(redaction_raw.get("denyGlobs"), list) else list(DEFAULT_DENY_GLOBS),
    )
    cutoff_raw = context.get("packCutoff") if isinstance(context.get("packCutoff"), dict) else {}
    pack_cutoff = PackCutoffConfig(
        enabled=bool(cutoff_raw.get("enabled", False)),
        minScoreRatio=float(cutoff_raw["minScoreRatio"]) if isinstance(cutoff_raw.get("minScoreRatio"), (int, float)) else 0.4,
    )
    max_file_size = context.get("maxFileSizeBytes")
    return ContextConfig(
        includeGlobs=context.get("includeGlobs") if isinstance(context.get("includeGlobs"), list) else ["**/*"],
        excludeGlobs=context.get("excludeGlobs") if isinstance(context.get("excludeGlobs"), list) else list(DEFAULT_EXCLUDE_GLOBS),
        maxFileSizeBytes=int(max_file_size) if isinstance(max_file_size, (int, float)) else 262144,
        skipBinary=bool(context.get("skipBinary", True)),
        respectGitIgnore=bool(context.get("respectGitIgnore", True)),
        secretRedaction=redaction,
        embedding=ProviderConfig.from_dict(context.get("embedding") if isinstance(context.get("embedding"), dict) else None),
        summary=ProviderConfig.from_dict(context.get("summary") if isinstance(context.get("summary"), dict) else None),
        externalSources=context.get("externalSources") if isinstance(context.get("externalSources"), list) else [],
        codebaseUnits=context.get("codebaseUnits") if isinstance(context.get("codebaseUnits"), list) else [],
        daemonAutoSpawn=bool(context.get("daemonAutoSpawn", False)),
        packCutoff=pack_cutoff,
        wiki=WikiConfig.from_dict(context.get("wiki") if isinstance(context.get("wiki"), dict) else None),
    )
