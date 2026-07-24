import { describe, it, expect, vi, beforeEach } from "vitest";

// Redirect-stub regression (owner ruling: Repos & Health folded into Wiki).
// Same mocking shape as (auth)/signup/[token]/page.test.ts: `redirect()`
// throws in real Next.js, so it's mocked to a plain spy here — the ONLY
// thing worth asserting for a stub page is which URL it redirects to.
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

import ReposPage from "./page";
import { redirect } from "next/navigation";

const mockRedirect = vi.mocked(redirect);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("ReposPage — redirect stub (old /repos deep links keep working)", () => {
  it("redirects to the workspace's /wiki page, mirroring teams -> /members", async () => {
    await ReposPage({ params: Promise.resolve({ workspaceId: "ws-123" }) });
    expect(mockRedirect).toHaveBeenCalledExactlyOnceWith("/dashboard/ws-123/wiki");
  });

  it("uses the workspaceId from params, not a hardcoded one", async () => {
    await ReposPage({ params: Promise.resolve({ workspaceId: "another-ws" }) });
    expect(mockRedirect).toHaveBeenCalledExactlyOnceWith("/dashboard/another-ws/wiki");
  });
});
