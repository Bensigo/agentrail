import { createHash, randomBytes } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";

/** Exchange a two-minute, one-use code issued by the local operator CLI. */
export async function exchangeLocalLogin(code: string) {
  if (!/^[a-f0-9]{64}$/.test(code)) return null;
  const hash = createHash("sha256").update(code).digest("hex");
  return db.transaction(async (tx) => {
    const tokens =
      await tx.execute(sql`DELETE FROM verification_tokens WHERE token = ${hash}
      AND identifier LIKE 'local-login:%' AND expires > now() RETURNING identifier`);
    if (tokens.length !== 1) return null;
    const userId = String(tokens[0].identifier).slice("local-login:".length);
    if (!/^[a-f0-9-]{36}$/.test(userId)) return null;
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 12 * 60 * 60 * 1000);
    await tx.execute(
      sql`INSERT INTO sessions (session_token, user_id, expires) VALUES (${token}, ${userId}, ${expires.toISOString()}::timestamptz)`,
    );
    return { token, expires };
  });
}
