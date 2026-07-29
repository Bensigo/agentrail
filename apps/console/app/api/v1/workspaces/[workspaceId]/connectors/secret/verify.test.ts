import { afterEach, describe, expect, it } from "vitest";
import { verifyConnectorCredential } from "./verify";

/**
 * Task 7 (debugging design spec): `verify.ts` had no dedicated test file
 * before this task — every case was only exercised indirectly (or not at
 * all) through `secret/route.test.ts`, which never mocks `global.fetch`.
 * This file adds direct coverage for the Railway branch specifically (the
 * one this task adds), mirroring the `global.fetch` swap-and-restore idiom
 * already used by `github.test.ts` / `github-repos.test.ts`. It does not
 * attempt to backfill coverage for the pre-existing Linear/Figma branches —
 * out of scope for this task.
 */

function railwayResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

describe("verifyConnectorCredential('railway', ...)", () => {
  it("posts to Railway's GraphQL endpoint with Authorization: Bearer <token> and the docs' own me{name email} query", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (url: string, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedInit = init;
      return railwayResponse(200, { data: { me: { name: "Ada", email: "ada@example.com" } } });
    }) as unknown as typeof fetch;

    const res = await verifyConnectorCredential(
      "railway",
      "3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );

    expect(res).toEqual({ ok: true });
    expect(capturedUrl).toBe("https://backboard.railway.com/graphql/v2");
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer 3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );
    const body = JSON.parse(String(capturedInit?.body)) as { query: string };
    expect(body.query).toBe("query { me { name email } }");
  });

  it("accepts a response carrying only `name` (not `email`)", async () => {
    global.fetch = (async () =>
      railwayResponse(200, { data: { me: { name: "Ada" } } })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "any-token");
    expect(res).toEqual({ ok: true });
  });

  it("rejects on HTTP 401", async () => {
    global.fetch = (async () => railwayResponse(401, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "bad-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("rejects on HTTP 403", async () => {
    global.fetch = (async () => railwayResponse(403, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "bad-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("rejects a 200 body carrying a GraphQL errors array (no data.me)", async () => {
    global.fetch = (async () =>
      railwayResponse(200, { errors: [{ message: "Not Authorized" }] })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("rejects a 200 body with neither data.me.name nor data.me.email present", async () => {
    global.fetch = (async () => railwayResponse(200, { data: { me: {} } })) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({ ok: false, error: "Railway rejected this token." });
  });

  it("reports a non-2xx, non-401/403 status with its HTTP code", async () => {
    global.fetch = (async () => railwayResponse(500, {})) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({ ok: false, error: "Couldn't verify with Railway (HTTP 500)." });
  });

  it("reports an unreachable upstream (thrown fetch) with a retry hint, never throwing itself", async () => {
    global.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const res = await verifyConnectorCredential("railway", "some-token");
    expect(res).toEqual({
      ok: false,
      error: "Couldn't reach Railway to verify the token — try again.",
    });
  });

  it("trims the token before sending it", async () => {
    let capturedInit: RequestInit | undefined;
    global.fetch = (async (_url: string, init?: RequestInit) => {
      capturedInit = init;
      return railwayResponse(200, { data: { me: { email: "a@b.com" } } });
    }) as unknown as typeof fetch;

    await verifyConnectorCredential("railway", "  3fa85f64-5717-4562-b3fc-2c963f66afa6  ");
    expect((capturedInit?.headers as Record<string, string>)?.Authorization).toBe(
      "Bearer 3fa85f64-5717-4562-b3fc-2c963f66afa6"
    );
  });
});
