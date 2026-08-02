import { describe, expect, it } from "vitest";

// This repo's vitest environment is "node" — no DOM/render harness
// (@testing-library/react, jsdom). `connectors-panel.tsx` is a "use client"
// component; `ConnectorsPanel` itself (useState/useEffect/useCallback) and
// `OauthResultBanner` (useSearchParams/useRouter/usePathname/useState) both
// call hooks at their own top level, so neither CAN be called directly here
// (no React dispatcher outside a real render pass — same reason
// `sidebar.test.tsx` never calls `Sidebar`).
//
// `ConnectorTile` is different: it has no hooks of its own (props in, JSX
// out, exactly like `digest-panel.tsx`'s `PlanCardBlock`/`PlanCardEmpty`),
// so calling it directly and walking the returned plain React-element tree
// via `.type`/`.props` is safe and is this repo's only real
// render-assertion technique for it. It is exported from
// `connectors-panel.tsx` (not otherwise consumed outside that file) solely
// to make this direct-call test possible — W3-T8 (owner-visible OAuth
// setup state, `.superpowers/sdd/plan-oauth.md`) is what needs it: the
// tile's small "Setup" tag, and the #1545 fixed-`h-28` invariant that tag
// must never break.

import { ConnectorTile } from "./connectors-panel";
import { ConnectorStatusBadge } from "./connector-status-badge";
import { projectConnectors, type ConnectorView } from "./connector-helpers";

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

/** Recursively flattens every string/number leaf under a React-element-like
 *  tree's `children` — mirrors `digest-panel.test.ts`'s own `collectText`. */
function collectText(node: unknown, acc: string[] = []): string[] {
  if (node === null || node === undefined || typeof node === "boolean") {
    return acc;
  }
  if (typeof node === "string" || typeof node === "number") {
    acc.push(String(node));
    return acc;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, acc);
    return acc;
  }
  const el = node as Partial<ReactElementLike>;
  if (el && typeof el === "object" && "props" in el) {
    collectText(el.props?.children, acc);
  }
  return acc;
}

const NOOP_ON_OPEN = () => {};

/** A real, fully-projected railway `ConnectorView` (via `projectConnectors`,
 *  the same pure projection the connectors GET route uses), with
 *  `oauthSetup`/`oauthReady`/connection overridable per test. */
function railwayConnector(
  overrides: {
    oauthSetup?: ConnectorView["oauthSetup"];
    oauthReady?: boolean;
    hasSecret?: boolean;
  } = {}
): ConnectorView {
  // `"oauthSetup" in overrides` (not `overrides.oauthSetup ?? default`) —
  // `??` treats an explicitly-passed `null` (the member-state fixture)
  // identically to "not provided," which would silently replace it with
  // the non-null default and defeat the whole point of that override.
  const oauthSetup = "oauthSetup" in overrides
    ? overrides.oauthSetup
    : { capable: true as const, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] };
  return projectConnectors([
    {
      kind: "railway",
      hasSecret: overrides.hasSecret ?? false,
      oauthReady: overrides.oauthReady ?? false,
      oauthSetup,
    },
  ]).find((r) => r.kind === "railway")!;
}

describe("ConnectorTile — 'Setup' tag (W3-T8, owner-visible OAuth setup state)", () => {
  it("shows the 'Setup' tag for the setup+admin state: oauthSetup present, not ready, not connected", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
      oauthReady: false,
    });
    expect(connector.status).toBe("disconnected");
    const el = ConnectorTile({ connector, onOpen: NOOP_ON_OPEN });
    expect(collectText(el)).toContain("Setup");
  });

  it("omits the tag for the ready state: oauthReady true", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: [] },
      oauthReady: true,
    });
    const el = ConnectorTile({ connector, onOpen: NOOP_ON_OPEN });
    expect(collectText(el)).not.toContain("Setup");
  });

  it("omits the tag for the member state: oauthSetup null", () => {
    const connector = railwayConnector({ oauthSetup: null, oauthReady: false });
    const el = ConnectorTile({ connector, onOpen: NOOP_ON_OPEN });
    expect(collectText(el)).not.toContain("Setup");
  });

  it("omits the tag once connected — nothing left to set up regardless of env state", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
      oauthReady: false,
      hasSecret: true,
    });
    expect(connector.status).toBe("connected");
    const el = ConnectorTile({ connector, onOpen: NOOP_ON_OPEN });
    expect(collectText(el)).not.toContain("Setup");
  });

  it("omits the tag for a non-oauth-capable provider (linear — oauthSetup is always null for it)", () => {
    const linear = projectConnectors([{ kind: "linear", hasSecret: false }]).find(
      (r) => r.kind === "linear"
    )!;
    expect(linear.oauthSetup).toBeNull();
    const el = ConnectorTile({ connector: linear, onOpen: NOOP_ON_OPEN });
    expect(collectText(el)).not.toContain("Setup");
  });

  // -----------------------------------------------------------------------
  // #1545's fixed-height invariant — the task's own explicit requirement:
  // the tag rides in the SAME bottom row as the existing status badge, so
  // the tile's own `h-28` must be byte-identical whether or not the tag
  // renders. Asserted directly on the returned element's own className,
  // both ways, rather than trusting the JSX diff alone.
  // -----------------------------------------------------------------------
  it("keeps the tile's own h-28 fixed height whether or not the Setup tag renders", () => {
    const withTag = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
      oauthReady: false,
    });
    const withoutTag = railwayConnector({ oauthSetup: null, oauthReady: false });

    const elWith = asElement(ConnectorTile({ connector: withTag, onOpen: NOOP_ON_OPEN }));
    const elWithout = asElement(ConnectorTile({ connector: withoutTag, onOpen: NOOP_ON_OPEN }));

    expect(String(elWith.props.className)).toContain("h-28");
    expect(String(elWithout.props.className)).toContain("h-28");
    // Byte-identical className between the two states — the tag's presence
    // changes the BOTTOM ROW's contents only, never the button's own
    // outer classes.
    expect(elWith.props.className).toBe(elWithout.props.className);
  });

  it("the tag sits in the same row as the status badge (bottom row), not a fourth row of its own", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
      oauthReady: false,
    });
    const el = asElement(ConnectorTile({ connector, onOpen: NOOP_ON_OPEN }));
    // [iconRow, description, bottomRow] — exactly 3 top-level rows, mirroring
    // the tile's own `justify-between` 3-child flex-col structure. Still
    // exactly 3 WITH the tag present — proof the tag rides inside the
    // existing bottom row rather than adding a 4th row of its own.
    const rows = el.props.children as ReactElementLike[];
    expect(rows.length).toBe(3);

    const bottomRow = asElement(rows[2]);
    const bottomRowChildren = bottomRow.props.children as ReactElementLike[];
    // Two children: the pre-existing <ConnectorStatusBadge> element (never
    // invoked by this direct-call style — see this file's own doc-comment
    // — so identified by `.type` reference equality, not its internally-
    // rendered text) plus this task's own <span>"Setup"</span> tag.
    expect(bottomRowChildren.length).toBe(2);
    expect(asElement(bottomRowChildren[0]).type).toBe(ConnectorStatusBadge);
    const tag = asElement(bottomRowChildren[1]);
    expect(tag.type).toBe("span");
    expect(tag.props.children).toBe("Setup");
  });

  it("the bottom row has only the status badge (no tag) once the Setup tag's own gate is false", () => {
    const connector = railwayConnector({ oauthSetup: null, oauthReady: false });
    const el = asElement(ConnectorTile({ connector, onOpen: NOOP_ON_OPEN }));
    const rows = el.props.children as ReactElementLike[];
    const bottomRow = asElement(rows[2]);
    const bottomRowChildren = bottomRow.props.children as ReactElementLike[];
    expect(bottomRowChildren.length).toBe(2);
    expect(asElement(bottomRowChildren[0]).type).toBe(ConnectorStatusBadge);
    expect(Boolean(bottomRowChildren[1])).toBe(false);
  });
});
