import { createHash } from "node:crypto";
import { signedGetUrl } from "./store";

const ARTIFACT_PROXY_TIMEOUT_MS = 8_000;
const ARTIFACT_PROXY_MAX_BYTES = 2 * 1024 * 1024;
const ARTIFACT_SIGNED_URL_TTL_SECONDS = 60;

export type ArtifactProxyResult =
  | { kind: "available"; bytes: Uint8Array }
  | { kind: "unavailable" };

async function cancelBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // Best-effort connection cleanup. The public result remains unavailable.
  }
}

/**
 * Privately signs and consumes one DB-resolved artifact key. Neither the key
 * nor the signed URL escapes this server-only helper. Bytes are buffered under
 * one fixed timeout and size ceiling so the member route never emits a partial
 * artifact response.
 */
export async function readBoundedArtifactForProxy(input: {
  artifactKey: string;
  contentSha256: string;
  fetchImpl?: typeof fetch;
}): Promise<ArtifactProxyResult> {
  if (!/^[a-f0-9]{64}$/.test(input.contentSha256)) {
    return { kind: "unavailable" };
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARTIFACT_PROXY_TIMEOUT_MS);

  try {
    const signedUrl = await signedGetUrl(
      input.artifactKey,
      ARTIFACT_SIGNED_URL_TTL_SECONDS,
    );
    const response = await fetchImpl(signedUrl, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      await cancelBody(response.body);
      return { kind: "unavailable" };
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null && (/^\d+$/.test(declaredLength)
      ? Number(declaredLength) > ARTIFACT_PROXY_MAX_BYTES
      : true)) {
      await cancelBody(response.body);
      return { kind: "unavailable" };
    }

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        total += next.value.byteLength;
        if (total > ARTIFACT_PROXY_MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {
            // The bounded unavailable result is authoritative.
          }
          return { kind: "unavailable" };
        }
        chunks.push(next.value);
      }
    } catch {
      try {
        await reader.cancel();
      } catch {
        // The bounded unavailable result is authoritative.
      }
      return { kind: "unavailable" };
    } finally {
      reader.releaseLock();
    }

    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    if (createHash("sha256").update(bytes).digest("hex") !== input.contentSha256) {
      return { kind: "unavailable" };
    }
    return { kind: "available", bytes };
  } catch {
    return { kind: "unavailable" };
  } finally {
    clearTimeout(timeout);
  }
}
