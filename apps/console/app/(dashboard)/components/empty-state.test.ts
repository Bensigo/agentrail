import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { EmptyState } from "./empty-state";

// EmptyState has no hooks of its own, so — same technique as the
// dashboard/[workspaceId] page tests — it's safe to call directly and walk
// the returned plain React-element tree via `.type`/`.props`. This repo's
// vitest environment has no DOM/render harness.

describe("EmptyState (#1281 AC2 — dead-end copy dies)", () => {
  it("renders the message with no action slot when none is passed (the old dead-end shape)", () => {
    const element = EmptyState({ message: "No work yet." }) as {
      props: { children: unknown[] };
    };
    // children: [icon-or-false, <p>message</p>, action-or-false]
    const [, messageEl, actionSlot] = element.props.children as [
      unknown,
      { props: { children: string } },
      unknown,
    ];
    expect(messageEl.props.children).toBe("No work yet.");
    expect(actionSlot).toBeFalsy();
  });

  it("renders the passed action node when one is provided", () => {
    const action = createElement("a", { href: "/setup" }, "Message Jace");
    const element = EmptyState({
      message: "No work yet.",
      action,
    }) as { props: { children: unknown[] } };
    const [, , actionSlot] = element.props.children as [
      unknown,
      unknown,
      { props: { children: typeof action } } | false,
    ];
    expect(actionSlot).not.toBe(false);
    expect((actionSlot as { props: { children: typeof action } }).props.children).toBe(
      action
    );
  });

  it("renders the optional icon when passed", () => {
    const icon = createElement("svg", {});
    const element = EmptyState({ message: "No work yet.", icon }) as {
      props: { children: unknown[] };
    };
    const [iconSlot] = element.props.children as [
      { props: { children: typeof icon } } | false,
    ];
    expect(iconSlot).not.toBe(false);
    expect((iconSlot as { props: { children: typeof icon } }).props.children).toBe(icon);
  });
});
