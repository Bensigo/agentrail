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
    ".agentrail/context/**",
    ".agentrail/source/**",
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
]


@dataclass
class SecretRedactionConfig:
    enabled: bool = True
    action: str = "exclude"
    denyGlobs: List[str] = field(default_factory=lambda: list(DEFAULT_DENY_GLOBS))


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
    )
