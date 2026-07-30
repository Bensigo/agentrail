import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentrail/db-postgres", () => ({
  db: {},
  getBillingAccountIdForWorkspace: vi.fn(),
  claimSeat: vi.fn(),
}));

import { claimSeatsForAcceptedInvites } from "./claim-invite-seats";
import { getBillingAccountIdForWorkspace, claimSeat } from "@agentrail/db-postgres";

const mockGetBillingAccountIdForWorkspace = vi.mocked(getBillingAccountIdForWorkspace);
const mockClaimSeat = vi.mocked(claimSeat);

const USER_ID = "user-1";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("claimSeatsForAcceptedInvites (spec §5 rule 1, slice 4 Task 3)", () => {
  it("no claimed workspaces: no billing/seat lookups at all", async () => {
    await claimSeatsForAcceptedInvites([], USER_ID);

    expect(mockGetBillingAccountIdForWorkspace).not.toHaveBeenCalled();
    expect(mockClaimSeat).not.toHaveBeenCalled();
  });

  it("one claimed workspace: resolves the billing account and claims a seat", async () => {
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockClaimSeat.mockResolvedValue(undefined);

    await claimSeatsForAcceptedInvites(["ws-1"], USER_ID);

    expect(mockGetBillingAccountIdForWorkspace).toHaveBeenCalledWith(expect.anything(), "ws-1");
    expect(mockClaimSeat).toHaveBeenCalledWith(expect.anything(), {
      billingAccountId: "account-1",
      subject: { userId: USER_ID },
      claimedVia: "console",
    });
  });

  it("multiple claimed workspaces on the SAME billing account: claimSeat deduped to one call", async () => {
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockClaimSeat.mockResolvedValue(undefined);

    await claimSeatsForAcceptedInvites(["ws-1", "ws-2"], USER_ID);

    expect(mockGetBillingAccountIdForWorkspace).toHaveBeenCalledTimes(2);
    expect(mockClaimSeat).toHaveBeenCalledTimes(1);
  });

  it("multiple claimed workspaces on DIFFERENT billing accounts: claimSeat once per account", async () => {
    mockGetBillingAccountIdForWorkspace.mockImplementation(async (_db, workspaceId) =>
      workspaceId === "ws-1" ? "account-1" : "account-2"
    );
    mockClaimSeat.mockResolvedValue(undefined);

    await claimSeatsForAcceptedInvites(["ws-1", "ws-2"], USER_ID);

    expect(mockClaimSeat).toHaveBeenCalledTimes(2);
    expect(mockClaimSeat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ billingAccountId: "account-1" })
    );
    expect(mockClaimSeat).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ billingAccountId: "account-2" })
    );
  });

  it("null billing account (transitional workspace): skips that claim silently", async () => {
    mockGetBillingAccountIdForWorkspace.mockResolvedValue(null);

    await claimSeatsForAcceptedInvites(["ws-1"], USER_ID);

    expect(mockClaimSeat).not.toHaveBeenCalled();
  });

  it("claimSeat throws: caught and logged, never rejects (non-fatal contract)", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockGetBillingAccountIdForWorkspace.mockResolvedValue("account-1");
    mockClaimSeat.mockRejectedValue(new Error("db unavailable"));

    await expect(claimSeatsForAcceptedInvites(["ws-1"], USER_ID)).resolves.toBeUndefined();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it("getBillingAccountIdForWorkspace throws: caught and logged, never rejects, no seat claim attempted", async () => {
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockGetBillingAccountIdForWorkspace.mockRejectedValue(new Error("timeout"));

    await expect(claimSeatsForAcceptedInvites(["ws-1"], USER_ID)).resolves.toBeUndefined();

    expect(mockClaimSeat).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});
