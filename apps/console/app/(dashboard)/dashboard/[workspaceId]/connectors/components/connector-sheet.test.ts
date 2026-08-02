import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// This repo's vitest environment is "node" — no DOM/render harness
// (@testing-library/react, jsdom). `connector-sheet.tsx` is a "use client"
// component; `SecretManage`/`ConnectorSheet`/`OauthConnectButton`/
// `OAuthManage`/`TriggerControls` all call hooks (useState/useCallback/
// useEffect/useRef) at their own top level, so none of them CAN be called
// directly here (no React dispatcher outside a real render pass — same
// reason `sidebar.test.tsx` never calls `Sidebar` and `digest-panel.
// test.ts` never calls `DigestPanel`).
//
// `OauthSetupNotice` (W3-T8, owner-visible OAuth setup state,
// `.superpowers/sdd/plan-oauth.md`) is different: it has no hooks of its
// own (props in, JSX out, exactly like `digest-panel.tsx`'s `PlanCardBlock`/
// `PlanCardEmpty`), so calling it directly and walking the returned plain
// React-element tree via `.type`/`.props` is safe and is this repo's only
// real render-assertion technique for it. It is exported from
// `connector-sheet.tsx` (not otherwise consumed outside that file) solely
// to make this direct-call test possible.
//
// NOT covered here, for lack of a render harness (same disclosed-gap
// posture as `sidebar.test.tsx`'s own note on the `EngineRoomGroup` splice
// it can't reach): whether `SecretManage`'s `!connector.oauthReady` branch
// actually WIRES `OauthSetupNotice` above `tokenForm` for the "setup+admin"
// state, and skips it for "ready"/"member" — that wiring is a single `if
// (setup && shouldShowOauthSetupHint(connector))` branch (visible by
// reading `connector-sheet.tsx` directly), proven by TypeScript (the
// non-null `setup` the JSX below requires) plus browser verification
// (`verify-console-ui`), not by a unit test in this file. The underlying
// "ready / setup+admin / member" state matrix — the exact boolean
// `SecretManage`'s branch calls — IS exhaustively unit-tested, in
// `connector-helpers.test.ts`'s own `shouldShowOauthSetupHint` describe
// block, since that function has no JSX and no hooks either.

import { OauthSetupNotice } from "./connector-sheet";
import { projectConnectors, type ConnectorView } from "./connector-helpers";

interface ReactElementLike {
  type: unknown;
  props: Record<string, unknown>;
}

function asElement(node: unknown): ReactElementLike {
  return node as ReactElementLike;
}

/** Recursively flattens every string/number leaf under a React-element-like
 *  tree's `children`, without ever invoking a component function — mirrors
 *  `digest-panel.test.ts`'s own `collectText` exactly. */
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

/** A real, fully-projected railway `ConnectorView` (via `projectConnectors`,
 *  the same pure projection the connectors GET route uses) — carries the
 *  REAL catalog `connect.oauthRegistrationUrl` this task adds, rather than
 *  a hand-typed fixture that could drift from the real catalog entry.
 *  `oauthSetup`/`oauthReady` are overridden per test via `projectConnectors`'
 *  own config-input fields. */
function railwayConnector(
  overrides: {
    oauthSetup?: ConnectorView["oauthSetup"];
    oauthReady?: boolean;
  } = {}
): ConnectorView {
  // `"oauthSetup" in overrides` (not `overrides.oauthSetup ?? default`) —
  // `??` would treat an explicitly-passed `null` identically to "not
  // provided," silently replacing it with the non-null default. No test in
  // this file currently passes `null` here, but the helper stays correct
  // regardless (mirrors the identical fix in `connectors-panel.test.ts`'s
  // own copy of this helper).
  const oauthSetup = "oauthSetup" in overrides
    ? overrides.oauthSetup
    : { capable: true as const, missingEnv: [] };
  return projectConnectors([
    {
      kind: "railway",
      hasSecret: false,
      oauthReady: overrides.oauthReady ?? false,
      oauthSetup,
    },
  ]).find((r) => r.kind === "railway")!;
}

describe("OauthSetupNotice (W3-T8, owner-visible OAuth setup state)", () => {
  it("renders the pinned 'One-click connect available' heading", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
    });
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const [heading] = el.props.children as ReactElementLike[];
    expect(asElement(heading).props.children).toBe("One-click connect available");
  });

  it("the explanatory sentence names the connector's own label, and never apologizes or markets", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
    });
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const text = collectText(el).join(" ");
    expect(text).toContain("Railway");
    expect(text).toContain("one-click");
    // House tone (TASTE.md / less-slop-writing) — no apology, no hype.
    expect(text.toLowerCase()).not.toContain("sorry");
    expect(text.toLowerCase()).not.toContain("coming soon");
    expect(text).not.toContain("!");
  });

  it("renders every missingEnv name as its own <code> list item, in order", () => {
    const connector = railwayConnector({
      oauthSetup: {
        capable: true,
        missingEnv: ["RAILWAY_OAUTH_CLIENT_ID", "RAILWAY_OAUTH_CLIENT_SECRET"],
      },
    });
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const [, , list] = el.props.children as ReactElementLike[];
    const items = asElement(list).props.children as ReactElementLike[];
    const names = items.map((li) => asElement(asElement(li).props.children).props.children);
    expect(names).toEqual(["RAILWAY_OAUTH_CLIENT_ID", "RAILWAY_OAUTH_CLIENT_SECRET"]);
  });

  it("renders no list at all when missingEnv is empty (a fully-configured, still-capable provider)", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: [] },
    });
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const [, , list] = el.props.children as ReactElementLike[];
    expect(Boolean(list)).toBe(false);
  });

  it("links to the provider's own doc-verified registration URL (the real railway catalog entry), target=_blank, rel=noopener noreferrer", () => {
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
    });
    expect(connector.connect?.oauthRegistrationUrl).toBe(
      "https://docs.railway.com/integrations/oauth/creating-an-app"
    );
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const [, , , link] = el.props.children as ReactElementLike[];
    expect(asElement(link).props.href).toBe(
      "https://docs.railway.com/integrations/oauth/creating-an-app"
    );
    expect(asElement(link).props.target).toBe("_blank");
    expect(asElement(link).props.rel).toBe("noopener noreferrer");
  });

  it("renders no link at all when the connector declares no oauthRegistrationUrl", () => {
    const base = railwayConnector({
      oauthSetup: { capable: true, missingEnv: ["RAILWAY_OAUTH_CLIENT_ID"] },
    });
    const connector: ConnectorView = {
      ...base,
      connect: base.connect ? { ...base.connect, oauthRegistrationUrl: undefined } : null,
    };
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const [, , , link] = el.props.children as ReactElementLike[];
    expect(Boolean(link)).toBe(false);
  });

  // -----------------------------------------------------------------------
  // No-XSS (task's own explicit ask): missingEnv names are this codebase's
  // OWN constants (RAILWAY_OAUTH_CLIENT_ID, etc. — never user input), but
  // they still render through the normal `{name}` JSX interpolation path,
  // which React always treats as a literal text child (escaped on any real
  // DOM render) rather than parsed markup — proven here by checking the
  // pathological value survives as an EXACT, unmodified string leaf (never
  // split into child elements, e.g. by an HTML parse), plus a source-level
  // sweep confirming this file never uses `dangerouslySetInnerHTML` at all.
  // -----------------------------------------------------------------------
  it("renders a pathological missingEnv name as a literal, unmodified text leaf (no HTML parsing anywhere in this path)", () => {
    const pathological = 'RAILWAY_OAUTH_CLIENT_ID<img src=x onerror=alert(1)>ZZPROBE11';
    const connector = railwayConnector({
      oauthSetup: { capable: true, missingEnv: [pathological] },
    });
    const el = asElement(
      OauthSetupNotice({ connector, setup: connector.oauthSetup! })
    );
    const [, , list] = el.props.children as ReactElementLike[];
    const [li] = asElement(list).props.children as ReactElementLike[];
    const code = asElement(asElement(li).props.children);
    // The <code> element's own children is the raw string, verbatim — not
    // an array of parsed sub-elements the way a real `<img>` tag would
    // become if this had gone through an HTML-parsing path instead of JSX
    // interpolation.
    expect(code.props.children).toBe(pathological);
    expect(typeof code.props.children).toBe("string");
  });

  it("source: connector-sheet.tsx never uses dangerouslySetInnerHTML anywhere", () => {
    const source = readFileSync(
      fileURLToPath(new URL("./connector-sheet.tsx", import.meta.url)),
      "utf8"
    );
    expect(source).not.toContain("dangerouslySetInnerHTML");
  });
});
