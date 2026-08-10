import { describe, expect, it } from "vitest";
import { LANDING_CTA } from "./_cta";

describe("LANDING_CTA", () => {
  it("takes a prospective user through the canonical login and setup entry", () => {
    expect(LANDING_CTA).toEqual({
      href: "/login",
      label: "Add Jace to your project",
    });
  });
});
