import { describe, it, expect } from "vitest";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.js";
import { exchangeLocalLogin } from "../queries/local-login.js";
const available = await db.execute(sql`SELECT to_regclass('public.verification_tokens') AS present`).then(r => Boolean(r[0]?.present)).catch(() => false);

describe.skipIf(!available)("local owner login — real PostgreSQL", () => {
  it("exchanges a code atomically once and stores a usable expiring session", async () => {
    const user = randomUUID(), code = randomBytes(32).toString("hex");
    const hash = createHash("sha256").update(code).digest("hex");
    const identifier = `local-login:${user}`;
    try {
      await db.execute(sql`INSERT INTO users (id,email) VALUES (${user},${`${user}@localhost.invalid`})`);
      await db.execute(sql`INSERT INTO verification_tokens (identifier,token,expires) VALUES (${identifier},${hash},${new Date(Date.now()+120000).toISOString()}::timestamptz)`);
      const results = await Promise.all([exchangeLocalLogin(code),exchangeLocalLogin(code)]);
      const sessions = results.filter(Boolean);
      expect(sessions).toHaveLength(1);
      const rows = await db.execute(sql`SELECT user_id,expires FROM sessions WHERE session_token=${sessions[0]!.token}`);
      expect(rows[0]?.user_id).toBe(user);
      expect(new Date(String(rows[0]?.expires)).getTime()).toBeGreaterThan(Date.now());
      expect(await exchangeLocalLogin(code)).toBeNull();
    } finally {
      await db.execute(sql`DELETE FROM verification_tokens WHERE identifier=${identifier}`);
      await db.execute(sql`DELETE FROM users WHERE id=${user}`);
    }
  });
  it("refuses expired and malformed codes", async () => {
    const code = randomBytes(32).toString("hex"), identifier = `local-login:${randomUUID()}`;
    try {
      await db.execute(sql`INSERT INTO verification_tokens (identifier,token,expires) VALUES (${identifier},${createHash("sha256").update(code).digest("hex")},${new Date(Date.now()-1000).toISOString()}::timestamptz)`);
      expect(await exchangeLocalLogin(code)).toBeNull();
      expect(await exchangeLocalLogin("invalid")).toBeNull();
    } finally { await db.execute(sql`DELETE FROM verification_tokens WHERE identifier=${identifier}`); }
  });
});
