export const HOSTED_INBOUND_BODY_BYTES = 64 * 1024;

/**
 * Reads one authenticated machine request without allowing either a declared
 * or chunked body to exceed its byte budget. Returns only a JSON object.
 */
export async function readBoundedRequestJson(request, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) return null;
  const declared = request?.headers?.get?.("content-length");
  if (declared !== null && declared !== undefined
    && (!/^\d+$/u.test(declared) || Number(declared) > maxBytes)) return null;
  if (!request?.body?.getReader) return null;

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        try { await reader.cancel(); } catch { /* already closed */ }
        return null;
      }
      chunks.push(next.value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed
      : null;
  } catch {
    return null;
  }
}
