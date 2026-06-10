from __future__ import annotations

import hashlib
import json
import os
import subprocess
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional

from agentrail.context.config import ProviderConfig, read_context_config
from agentrail.context.index import append_audit, build_index, load_index, now_iso
from agentrail.shared.json import write_json


def provider_name(mode: str, config: ProviderConfig) -> str:
    if config.provider:
        return config.provider
    if mode == "custom-command":
        return "custom-command"
    if mode == "openai-compatible":
        return "openai-compatible"
    return mode


def configured_model(mode: str, config: ProviderConfig) -> Optional[str]:
    if config.model:
        return config.model
    if mode == "custom-command":
        return "custom-command"
    return None


def embedding_config_hash(mode: str, config: ProviderConfig) -> str:
    fingerprint = {
        "mode": mode,
        "provider": config.provider,
        "model": config.model,
        "command": str(config.command or config.customCommand or "") if mode == "custom-command" else None,
        "baseUrl": str(config.baseUrl or "https://api.openai.com/v1").rstrip("/") if mode == "openai-compatible" else None,
        "apiKeyEnv": str(config.apiKeyEnv or "OPENAI_API_KEY") if mode == "openai-compatible" else None,
    }
    return f"sha256:{hashlib.sha256(json.dumps(fingerprint, separators=(',', ':')).encode()).hexdigest()}"


def normalize_embedding(value: Any) -> List[float]:
    if not isinstance(value, list) or not value:
        raise RuntimeError("provider returned an empty or missing embedding vector")
    vector = [float(item) for item in value]
    if any(not isinstance(item, float) for item in vector):
        raise RuntimeError("provider returned a non-numeric embedding vector")
    return vector


def run_custom_command(target_dir: Path, config: ProviderConfig, payload: Dict[str, Any]) -> Dict[str, Any]:
    command = config.command or config.customCommand
    if not command:
        raise RuntimeError("context.embedding.command is required for custom-command mode")
    result = subprocess.run(command, input=f"{json.dumps(payload)}\n", text=True, shell=True, cwd=target_dir, env=os.environ.copy(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)
    if result.returncode != 0:
        suffix = f": {result.stderr.strip()}" if result.stderr.strip() else ""
        raise RuntimeError(f"custom embedding command failed with exit {result.returncode}{suffix}")
    try:
        parsed = json.loads(result.stdout.strip())
    except Exception as error:
        raise RuntimeError(f"custom embedding command returned invalid JSON: {error}") from error
    return {"provider": str(parsed["provider"]) if parsed.get("provider") else None, "model": str(parsed["model"]) if parsed.get("model") else None, "vector": normalize_embedding(parsed.get("embedding") or parsed.get("vector"))}


def run_openai_compatible(config: ProviderConfig, payload: Dict[str, Any]) -> Dict[str, Any]:
    if not config.model:
        raise RuntimeError("context.embedding.model is required for openai-compatible mode")
    base_url = (config.baseUrl or "https://api.openai.com/v1").rstrip("/")
    is_local = any(host in base_url for host in ("localhost", "127.0.0.1", "0.0.0.0"))
    api_key_env = config.apiKeyEnv or "OPENAI_API_KEY"
    api_key = os.environ.get(api_key_env)
    if not api_key and not is_local:
        raise RuntimeError(f"{api_key_env} is required for openai-compatible embedding mode")
    api_key = api_key or "local"  # local servers (e.g. Ollama) ignore the bearer token
    request = urllib.request.Request(
        f"{base_url}/embeddings",
        data=json.dumps({"model": config.model, "input": payload["content"]}).encode("utf-8"),
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
        method="POST",
    )
    with urllib.request.urlopen(request) as response:
        parsed = json.loads(response.read().decode("utf-8"))
    return {"provider": config.provider or "openai-compatible", "model": str(parsed.get("model") or config.model), "vector": normalize_embedding(parsed.get("data", [{}])[0].get("embedding"))}


def read_existing(path: Path) -> List[Dict[str, Any]]:
    try:
        parsed = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return []
    if not isinstance(parsed.get("embeddings"), list):
        raise RuntimeError("invalid existing embedding metadata: embeddings must be an array")
    return parsed["embeddings"]


def is_reusable(record: Optional[Dict[str, Any]], chunk: Dict[str, Any], source: Dict[str, Any], mode: str, config_hash: str) -> bool:
    return bool(record and record.get("mode") == mode and record.get("configHash") == config_hash and record.get("chunkId") == chunk.get("id") and record.get("textHash") == chunk.get("textHash") and record.get("contentHash") == source.get("contentHash") and record.get("provider") and record.get("model") and isinstance(record.get("dimension"), (int, float)))


def embed_context(target_dir: Path) -> Dict[str, Any]:
    root = target_dir.resolve()
    build_index(root)
    cfg = read_context_config(root).embedding
    mode = cfg.mode
    provider = provider_name(mode, cfg)
    model = configured_model(mode, cfg)
    config_hash = embedding_config_hash(mode, cfg)
    index = load_index(root)
    embeddings_path = root / ".agentrail" / "context" / "index" / "embeddings.json"
    chunks = [chunk for chunk in index.get("chunks", []) if str(chunk.get("content") or "").strip()]
    sources = {record["id"]: record for record in index.get("records", [])}

    if mode == "disabled":
        write_json(embeddings_path, {"schemaVersion": 1, "provider": {"mode": mode, "provider": None, "model": None}, "builtAt": now_iso(), "embeddings": []})
        append_audit(root, {"event": "embedding_provider_call", "mode": mode, "provider": None, "model": None, "action": "skipped_local_only", "payloadCount": 0})
        return {"embeddingPath": ".agentrail/context/index/embeddings.json", "providerMode": mode, "provider": None, "model": None, "eligible": len(chunks), "embedded": 0, "skipped": len(chunks), "failed": 0}
    if mode not in {"custom-command", "openai-compatible"}:
        append_audit(root, {"event": "embedding_provider_failure", "mode": mode, "provider": provider, "model": model, "action": "unsupported_mode", "payloadCount": len(chunks)})
        raise RuntimeError(f"context embedding mode '{mode}' is not supported by this AgentRail version; config is reserved for future provider extension")

    existing = {record.get("chunkId"): record for record in read_existing(embeddings_path)}
    next_records: List[Dict[str, Any]] = []
    embedded = 0
    skipped = 0
    for chunk in chunks:
        source = sources.get(chunk.get("sourceId"), {})
        prior = existing.get(chunk["id"])
        if is_reusable(prior, chunk, source, mode, config_hash):
            next_records.append(prior)  # type: ignore[arg-type]
            skipped += 1
            continue
        payload = {"mode": mode, "provider": provider, "model": model, "chunkId": chunk["id"], "path": chunk["path"], "citation": chunk["citation"], "contentHash": source.get("contentHash"), "textHash": chunk["textHash"], "auditRef": source.get("auditRef"), "content": chunk["content"]}
        append_audit(root, {"event": "embedding_provider_call", "mode": mode, "provider": provider, "model": model, "action": "embed_chunk", "chunkId": chunk["id"], "contentHash": source.get("contentHash"), "textHash": chunk["textHash"], "auditRef": source.get("auditRef")})
        try:
            result = run_custom_command(root, cfg, payload) if mode == "custom-command" else run_openai_compatible(cfg, payload)
        except Exception as error:
            append_audit(root, {"event": "embedding_provider_failure", "mode": mode, "provider": provider, "model": model, "action": "embed_chunk_failed", "chunkId": chunk["id"], "contentHash": source.get("contentHash"), "textHash": chunk["textHash"], "auditRef": source.get("auditRef"), "message": "embedding provider failed"})
            raise error
        vector = result["vector"]
        next_records.append({"mode": mode, "provider": result["provider"] or provider, "model": result["model"] or model, "configHash": config_hash, "dimension": len(vector), "contentHash": source.get("contentHash"), "chunkId": chunk["id"], "textHash": chunk["textHash"], "timestamp": now_iso(), "auditRef": source.get("auditRef"), "path": chunk["path"], "citation": chunk["citation"], "embedding": vector})
        embedded += 1
    next_records.sort(key=lambda record: str(record.get("chunkId")))
    write_json(embeddings_path, {"schemaVersion": 1, "provider": {"mode": mode, "provider": provider, "model": model}, "builtAt": now_iso(), "embeddings": next_records})
    append_audit(root, {"event": "embedding_provider_complete", "mode": mode, "provider": provider, "model": model, "payloadCount": len(chunks), "embedded": embedded, "skipped": skipped, "embeddingCount": len(next_records)})
    return {"embeddingPath": ".agentrail/context/index/embeddings.json", "providerMode": mode, "provider": provider, "model": model, "eligible": len(chunks), "embedded": embedded, "skipped": skipped, "failed": 0}


_PRESET_DEFAULTS = {
    "ollama": {"mode": "openai-compatible", "provider": "ollama", "model": "nomic-embed-text", "baseUrl": "http://localhost:11434/v1", "apiKeyEnv": "OLLAMA_API_KEY"},
    "openai": {"mode": "openai-compatible", "provider": "openai", "model": "text-embedding-3-small", "baseUrl": "https://api.openai.com/v1", "apiKeyEnv": "OPENAI_API_KEY"},
}


def embedding_preset(preset: str, *, model: Optional[str] = None, base_url: Optional[str] = None, api_key_env: Optional[str] = None, command: Optional[str] = None, name: Optional[str] = None) -> Dict[str, Any]:
    """Build a `context.embedding` config block for a named provider preset."""
    if preset == "disable":
        return {"mode": "disabled", "provider": None, "model": None, "customCommand": None, "baseUrl": None, "apiKeyEnv": None}
    if preset == "custom":
        if not command:
            raise SystemExit("context embed setup custom requires --command")
        return {"mode": "custom-command", "provider": name or "custom", "model": model or "custom", "customCommand": command}
    if preset in _PRESET_DEFAULTS:
        base = dict(_PRESET_DEFAULTS[preset])
        if model:
            base["model"] = model
        if base_url:
            base["baseUrl"] = base_url
        if api_key_env:
            base["apiKeyEnv"] = api_key_env
        if name:
            base["provider"] = name
        return base
    raise SystemExit(f"unknown embedding preset: {preset} (expected ollama, openai, custom, or disable)")


def validate_embedding_provider(target_dir: Path, embedding: Dict[str, Any]) -> Dict[str, Any]:
    """Make one real embedding call so a broken provider is caught before saving."""
    mode = str(embedding.get("mode"))
    config = ProviderConfig.from_dict(embedding)
    payload = {"mode": mode, "chunkId": "setup-probe", "path": "setup", "citation": "setup", "content": "AgentRail embedding setup probe."}
    if mode == "custom-command":
        result = run_custom_command(target_dir, config, payload)
    elif mode == "openai-compatible":
        result = run_openai_compatible(config, payload)
    else:
        raise RuntimeError(f"cannot validate embedding mode '{mode}'")
    dimension = len(result.get("vector") or [])
    if dimension <= 0:
        raise RuntimeError("provider returned an empty embedding vector")
    return {"provider": result.get("provider") or config.provider, "model": result.get("model") or config.model, "dimension": dimension}


def _write_embedding_config(target_dir: Path, embedding: Dict[str, Any]) -> None:
    config_path = target_dir.resolve() / ".agentrail" / "config.json"
    data = json.loads(config_path.read_text(encoding="utf-8"))
    context = data.setdefault("context", {})
    context["embedding"] = {key: value for key, value in embedding.items() if value is not None} or {"mode": "disabled"}
    write_json(config_path, data)


def setup_embeddings(target_dir: Path, preset: str, *, model: Optional[str] = None, base_url: Optional[str] = None, api_key_env: Optional[str] = None, command: Optional[str] = None, name: Optional[str] = None, validate: bool = True) -> Dict[str, Any]:
    """Configure (and optionally live-validate) the embedding provider, then persist it."""
    root = target_dir.resolve()
    embedding = embedding_preset(preset, model=model, base_url=base_url, api_key_env=api_key_env, command=command, name=name)
    validation: Optional[Dict[str, Any]] = None
    if validate and embedding.get("mode") not in {"disabled", None}:
        validation = validate_embedding_provider(root, embedding)
    _write_embedding_config(root, embedding)
    append_audit(root, {"event": "embedding_setup", "mode": embedding.get("mode"), "provider": embedding.get("provider"), "model": embedding.get("model"), "validated": validation is not None})
    return {"mode": embedding.get("mode"), "embedding": embedding, "validated": validation is not None, "validation": validation}
