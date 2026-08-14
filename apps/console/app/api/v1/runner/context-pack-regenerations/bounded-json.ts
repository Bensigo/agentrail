export const MAX_CONTEXT_PACK_REGENERATION_BODY_BYTES = 2 * 1024;

export async function readBoundedContextPackRegenerationJson(request: Request): Promise<unknown | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && (!/^\d+$/u.test(contentLength)
    || Number(contentLength) > MAX_CONTEXT_PACK_REGENERATION_BODY_BYTES)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > MAX_CONTEXT_PACK_REGENERATION_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* bounded refusal */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch { return null; } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; }
}
