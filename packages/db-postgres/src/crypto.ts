import crypto from "crypto";

/**
 * Symmetric encryption for connector credentials at rest (M038 catalog
 * expansion). A connector's API key / token is **never** stored in plaintext: the
 * console encrypts it with AES-256-GCM before it touches the `connectors.secret`
 * column, and only decrypts it server-side when materializing the value into a
 * run's MCP config (the codebase) or posting to a gateway. The browser only ever
 * sees a `hasSecret` boolean — never the ciphertext or the plaintext.
 *
 * Key material comes from `CONNECTOR_SECRET_KEY` — a dedicated 32+ char secret
 * that must be set in every environment that reads or writes connector secrets,
 * derived to a stable 32-byte key via SHA-256. It is intentionally **not**
 * derived from `AUTH_SECRET`: the two have different threat models and rotation
 * lifecycles, and rotating the NextAuth session key must never silently brick
 * stored connector ciphertext. GCM gives us authenticated encryption: a tampered
 * ciphertext fails to decrypt rather than yielding garbage.
 *
 * Stored format (versioned so the scheme can evolve): `enc:v1:<iv>:<tag>:<ct>`
 * where each part is base64. `decryptSecret` passes through any value lacking the
 * `enc:v1:` prefix unchanged, so a legacy/plaintext value never crashes a read.
 */

const SCHEME = "enc:v1";
const ALGO = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length.

function encryptionKey(): Buffer {
  const material = process.env["CONNECTOR_SECRET_KEY"];
  if (!material) {
    throw new Error(
      "CONNECTOR_SECRET_KEY is not set: connector secrets cannot be encrypted " +
        "or decrypted. Set a dedicated 32+ char secret (do not reuse AUTH_SECRET)."
    );
  }
  // Derive a stable 32-byte key from the (high-entropy) secret material.
  return crypto.createHash("sha256").update(material).digest();
}

/** Encrypt a plaintext credential into the versioned at-rest format. */
export function encryptSecret(plaintext: string): string {
  const key = encryptionKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    SCHEME,
    iv.toString("base64"),
    tag.toString("base64"),
    ciphertext.toString("base64"),
  ].join(":");
}

/** Whether `value` is in the encrypted at-rest format. */
export function isEncrypted(value: string): boolean {
  return value.startsWith(`${SCHEME}:`);
}

/**
 * Decrypt an at-rest credential back to plaintext. A value not in the `enc:v1:`
 * format is returned unchanged (defensive passthrough for any legacy plaintext).
 * Throws only when a properly-tagged value fails authentication (tampering / wrong
 * key).
 */
export function decryptSecret(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const parts = stored.split(":");
  // ["enc","v1", iv, tag, ct]
  if (parts.length !== 5) {
    throw new Error("Malformed encrypted secret");
  }
  const [, , ivB64, tagB64, ctB64] = parts;
  const key = encryptionKey();
  const decipher = crypto.createDecipheriv(
    ALGO,
    key,
    Buffer.from(ivB64, "base64")
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}
