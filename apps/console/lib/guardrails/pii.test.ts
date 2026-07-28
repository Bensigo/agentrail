import { describe, it, expect } from "vitest";
import { normalizeForScreening, detectPii, redactPii } from "./pii";

// Zero-width space (U+200B) — one of the invisible code points an attacker
// could use to split a card number's digits past a naive regex.
// `normalizeForScreening` must strip it before any detector runs.
const ZWS = "​";

function interleave(s: string, ch: string): string {
  return s.split("").join(ch);
}

// --- Known-valid checksum test vectors -------------------------------------
// Publicly documented test numbers (Stripe/PayPal test cards, the textbook
// mod-97 IBAN example from Wikipedia's own IBAN article, a real published
// ABA routing number). None of these are live secrets.
const VISA = "4111111111111111";
const MASTERCARD = "5555555555554444";
const AMEX = "378282246310005"; // 15 digits
const IBAN = "GB82WEST12345698765432";
const SORT_CODE = "12-34-56";
const ABA = "021000021"; // real, checksum-valid; group digits "00" so it is NOT SSN-structurally-valid
const SSN_FORMATTED = "123-45-6789";
const SSN_BARE = "234567890"; // structurally valid, deliberately NOT ABA-checksum-valid

describe("normalizeForScreening", () => {
  it("NFC-normalizes and strips zero-width/invisible characters", () => {
    const withZw = interleave("4111111111111111", ZWS);
    expect(normalizeForScreening(withZw)).toBe("4111111111111111");
  });

  it("keeps ordinary whitespace and newlines intact (screening, not rendering)", () => {
    const s = "line one\nline two\tindented  double space";
    expect(normalizeForScreening(s)).toBe(s);
  });

  it("is safe on non-string input", () => {
    expect(normalizeForScreening(undefined as unknown as string)).toBe("");
    expect(normalizeForScreening(null as unknown as string)).toBe("");
  });
});

describe("detectPii — negative controls (must NOT fire)", () => {
  const cases: Array<[string, string]> = [
    ["40-hex git SHA", "commit a94a8fe5ccb19ba61c4c0873d391e987982fbbd3 landed"],
    ["7-hex short SHA", "fixed in a94a8fe, see the log"],
    ["order/invoice number", "Your order number is 1234567890123, thanks!"],
    ["semver string", "Upgraded to v2.14.1-beta.3 today"],
    ["port number", "connect to localhost:8080 for the dev server"],
    ["16-digit run that fails Luhn", "account ref 4111111111111112 was rejected"],
    ["US phone number", "call me at (415) 555-2671 after noon"],
    ["international phone number", "reach the office at +44 20 7946 0958"],
    ["GitHub issue ref", "see #1234 for the original report"],
    ["ISO timestamp", "deployed at 2026-07-28T14:30:00Z"],
    ["UUID", "trace id 550e8400-e29b-41d4-a716-446655440000"],
    [
      "long digit run inside a URL",
      "https://example.com/track/1234567890123456789012345/details",
    ],
  ];

  for (const [label, text] of cases) {
    it(`does not flag ${label}`, () => {
      expect(detectPii(text)).toHaveLength(0);
    });
  }
});

describe("detectPii — positive controls", () => {
  it("detects a Luhn-valid Visa", () => {
    const findings = detectPii(`card on file: ${VISA}`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ category: "pii", type: "card", detector: "deterministic" });
  });

  it("detects a Luhn-valid Mastercard", () => {
    const findings = detectPii(`card on file: ${MASTERCARD}`);
    expect(findings.map((f) => f.type)).toContain("card");
  });

  it("detects a Luhn-valid Amex (15 digits)", () => {
    const findings = detectPii(`amex: ${AMEX}`);
    expect(findings.map((f) => f.type)).toContain("card");
  });

  it("detects a mod-97-valid IBAN", () => {
    const findings = detectPii(`transfer to ${IBAN} please`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("iban");
  });

  it("detects a formatted SSN", () => {
    const findings = detectPii(`ssn is ${SSN_FORMATTED} on file`);
    expect(findings.map((f) => f.type)).toContain("ssn");
  });

  it("detects a bare 9-digit SSN only when not adjacent to other digits", () => {
    const isolated = detectPii(`ssn ${SSN_BARE} confirmed`);
    expect(isolated.map((f) => f.type)).toContain("ssn");

    // Same digits, but glued to another digit run — must NOT fire, per spec:
    // bare 9-digit SSNs are only matched in isolation.
    const glued = detectPii(`ref ${SSN_BARE}1 confirmed`);
    expect(glued.map((f) => f.type)).not.toContain("ssn");
  });

  it("detects a checksum-valid ABA routing number", () => {
    const findings = detectPii(`routing number ${ABA} for the wire`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("aba");
  });

  it("detects a UK sort code", () => {
    const findings = detectPii(`sort code ${SORT_CODE} branch`);
    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe("sort_code");
  });

  it("still detects each positive when zero-width characters are interleaved between digits", () => {
    expect(detectPii(`card: ${interleave(VISA, ZWS)}`).map((f) => f.type)).toContain("card");
    expect(detectPii(`iban: ${interleave(IBAN, ZWS)}`).map((f) => f.type)).toContain("iban");
    expect(detectPii(`ssn: ${interleave(SSN_FORMATTED, ZWS)}`).map((f) => f.type)).toContain(
      "ssn"
    );
    expect(detectPii(`aba: ${interleave(ABA, ZWS)}`).map((f) => f.type)).toContain("aba");
    expect(
      detectPii(`sort code: ${interleave(SORT_CODE, ZWS)}`).map((f) => f.type)
    ).toContain("sort_code");
  });
});

describe("redactPii", () => {
  it("redacts a card and removes the original digits", () => {
    const { text, findings } = redactPii(`please charge ${VISA} now`);
    expect(text).toContain("[redacted:card]");
    expect(text).not.toContain(VISA);
    expect(findings).toHaveLength(1);
  });

  it("redacts an IBAN, SSN, ABA and sort code with the correct placeholders", () => {
    const iban = redactPii(`iban ${IBAN}`);
    expect(iban.text).toContain("[redacted:iban]");
    expect(iban.text).not.toContain(IBAN);

    const ssn = redactPii(`ssn ${SSN_FORMATTED}`);
    expect(ssn.text).toContain("[redacted:ssn]");
    expect(ssn.text).not.toContain(SSN_FORMATTED);

    const aba = redactPii(`routing ${ABA}`);
    expect(aba.text).toContain("[redacted:aba]");
    expect(aba.text).not.toContain(ABA);

    const sortCode = redactPii(`sort code ${SORT_CODE}`);
    expect(sortCode.text).toContain("[redacted:sort_code]");
    expect(sortCode.text).not.toContain(SORT_CODE);
  });

  it("redacts zero-width-interleaved PII too", () => {
    const { text } = redactPii(`card: ${interleave(VISA, ZWS)}`);
    expect(text).toContain("[redacted:card]");
    expect(text).not.toContain(VISA);
  });

  it("leaves surrounding prose intact", () => {
    const { text } = redactPii(`hi, my card is ${VISA} — thanks!`);
    expect(text).toContain("hi, my card is");
    expect(text).toContain("— thanks!");
  });
});

describe("multiple PII types and offsets", () => {
  it("finds every type present in one message, with correct non-overlapping offsets", () => {
    const text = `Card ${VISA}, IBAN ${IBAN}, SSN ${SSN_FORMATTED}, routing ${ABA}, sort code ${SORT_CODE}.`;
    const findings = detectPii(text);
    const types = findings.map((f) => f.type).sort();
    expect(types).toEqual(["aba", "card", "iban", "sort_code", "ssn"].sort());

    // Offsets are ascending and never overlap, and each one really does
    // locate its own match inside the (normalized == unchanged, no invisibles
    // here) text.
    const sorted = [...findings].sort((a, b) => a.offsets[0][0] - b.offsets[0][0]);
    let prevEnd = -1;
    for (const f of sorted) {
      const [start, end] = f.offsets[0];
      expect(start).toBeGreaterThanOrEqual(prevEnd);
      prevEnd = end;
    }

    const visaFinding = findings.find((f) => f.type === "card")!;
    const [vs, ve] = visaFinding.offsets[0];
    expect(text.slice(vs, ve)).toBe(VISA);

    const ibanFinding = findings.find((f) => f.type === "iban")!;
    const [is_, ie] = ibanFinding.offsets[0];
    expect(text.slice(is_, ie)).toBe(IBAN);
  });

  it("redacts every type present in one message and drops all original digits", () => {
    const text = `Card ${VISA}, IBAN ${IBAN}, SSN ${SSN_FORMATTED}, routing ${ABA}, sort code ${SORT_CODE}.`;
    const { text: redacted } = redactPii(text);
    expect(redacted).toContain("[redacted:card]");
    expect(redacted).toContain("[redacted:iban]");
    expect(redacted).toContain("[redacted:ssn]");
    expect(redacted).toContain("[redacted:aba]");
    expect(redacted).toContain("[redacted:sort_code]");
    expect(redacted).not.toContain(VISA);
    expect(redacted).not.toContain(IBAN);
    expect(redacted).not.toContain(SSN_FORMATTED);
    expect(redacted).not.toContain(ABA);
    expect(redacted).not.toContain(SORT_CODE);
  });

  it("never emits overlapping findings even when a card and a bare digit run could both match", () => {
    // A 16-digit card written with a single interior space happens to leave
    // an isolated 9-digit prefix that, on its own, could look like a bare
    // SSN/ABA run. The longer card match must win outright.
    const spaced = "4111111111 111111"; // still 16 digits, still Luhn-valid
    const findings = detectPii(`card ${spaced} on file`);
    const types = findings.map((f) => f.type);
    expect(types).toContain("card");
    expect(types).not.toContain("ssn");
    expect(types).not.toContain("aba");
  });
});

describe("empty and non-string-ish input", () => {
  it("detectPii on empty string returns no findings", () => {
    expect(detectPii("")).toEqual([]);
  });

  it("redactPii on empty string returns empty text and no findings", () => {
    expect(redactPii("")).toEqual({ text: "", findings: [] });
  });

  it("detectPii and redactPii are safe on non-string input", () => {
    expect(detectPii(undefined as unknown as string)).toEqual([]);
    expect(detectPii(null as unknown as string)).toEqual([]);
    expect(detectPii(12345 as unknown as string)).toEqual([]);
    expect(redactPii(undefined as unknown as string)).toEqual({ text: "", findings: [] });
    expect(redactPii(null as unknown as string)).toEqual({ text: "", findings: [] });
  });
});

// A lowercase paste is exactly the case where redaction matters most — people
// paste what their banking app showed them, not what ISO 13616 prescribes.
describe("IBAN case-insensitivity", () => {
  it("detects and redacts a lowercase IBAN", () => {
    const out = redactPii("transfer to gb82west12345698765432 today");
    expect(out.findings.some((f) => f.type === "iban")).toBe(true);
    expect(out.text).toContain("[redacted:iban]");
    expect(out.text.toLowerCase()).not.toContain("west12345698765432");
  });

  it("detects a mixed-case IBAN", () => {
    expect(detectPii("Gb82WeSt12345698765432").some((f) => f.type === "iban")).toBe(true);
  });

  it("still rejects a checksum-invalid lowercase lookalike", () => {
    expect(detectPii("gb82west12345698765433").some((f) => f.type === "iban")).toBe(false);
  });
});
