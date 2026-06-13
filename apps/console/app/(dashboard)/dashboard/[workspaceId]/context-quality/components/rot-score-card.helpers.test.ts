import { describe, it, expect } from "vitest";
import {
  severityColor,
  truncateId,
  formatStaleness,
  contributorHref,
  contributorTypeLabel,
  badgeColors,
} from "./rot-score-card-helpers";

describe("severityColor", () => {
  it("returns green for score = 0", () => {
    expect(severityColor(0)).toBe("#1fd8a4");
  });
  it("returns green for score = 30 (boundary)", () => {
    expect(severityColor(30)).toBe("#1fd8a4");
  });
  it("returns yellow for score = 31 (boundary)", () => {
    expect(severityColor(31)).toBe("#f5e147");
  });
  it("returns yellow for score = 60 (boundary)", () => {
    expect(severityColor(60)).toBe("#f5e147");
  });
  it("returns red for score = 61 (boundary)", () => {
    expect(severityColor(61)).toBe("#ff9592");
  });
  it("returns red for score = 100", () => {
    expect(severityColor(100)).toBe("#ff9592");
  });
});

describe("truncateId", () => {
  it("returns short IDs unchanged", () => {
    expect(truncateId("abc")).toBe("abc");
  });
  it("returns IDs of exactly 12 chars unchanged", () => {
    expect(truncateId("123456789012")).toBe("123456789012");
  });
  it("truncates IDs longer than 12 chars", () => {
    expect(truncateId("1234567890123")).toBe("123456789012…");
  });
  it("truncates UUIDs to 12 chars + ellipsis", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(truncateId(uuid)).toBe("550e8400-e29…");
  });
});

describe("formatStaleness", () => {
  it("formats 0 days as '0d ago'", () => {
    expect(formatStaleness(0)).toBe("0d ago");
  });
  it("formats 14 days as '14d ago'", () => {
    expect(formatStaleness(14)).toBe("14d ago");
  });
  it("floors fractional days", () => {
    expect(formatStaleness(14.9)).toBe("14d ago");
  });
  it("formats 30 days as '30d ago'", () => {
    expect(formatStaleness(30)).toBe("30d ago");
  });
});

describe("contributorHref", () => {
  const wid = "ws-123";

  it("routes memory_item to /memory", () => {
    expect(contributorHref("memory_item", wid)).toBe(
      `/dashboard/${wid}/memory`
    );
  });
  it("routes index_snapshot to /repos", () => {
    expect(contributorHref("index_snapshot", wid)).toBe(
      `/dashboard/${wid}/repos`
    );
  });
  it("routes hash_churn to /context-packs", () => {
    expect(contributorHref("hash_churn", wid)).toBe(
      `/dashboard/${wid}/context-packs`
    );
  });
});

describe("contributorTypeLabel", () => {
  it("labels memory_item", () => {
    expect(contributorTypeLabel("memory_item")).toBe("Memory Item");
  });
  it("labels index_snapshot", () => {
    expect(contributorTypeLabel("index_snapshot")).toBe("Index Snapshot");
  });
  it("labels hash_churn", () => {
    expect(contributorTypeLabel("hash_churn")).toBe("Source Hash Churn");
  });
});

describe("badgeColors", () => {
  it("returns distinct colors for each type", () => {
    const mem = badgeColors("memory_item");
    const snap = badgeColors("index_snapshot");
    const churn = badgeColors("hash_churn");
    expect(mem.text).not.toBe(snap.text);
    expect(snap.text).not.toBe(churn.text);
    expect(mem.text).not.toBe(churn.text);
  });
  it("returns teal for hash_churn", () => {
    expect(badgeColors("hash_churn").text).toBe("#0bd8b6");
  });
});
