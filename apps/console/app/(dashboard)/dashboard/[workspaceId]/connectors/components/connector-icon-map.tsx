import type { ComponentType } from "react";
import { Radio } from "lucide-react";
import {
  GithubBrand,
  LinearBrand,
  FigmaBrand,
  Context7Brand,
  RailwayBrand,
  LangfuseBrand,
  SentryBrand,
  DatadogBrand,
  PrometheusBrand,
  GrafanaBrand,
  VercelBrand,
  CloudflareBrand,
  type BrandIconProps,
} from "./brand-icons";
import type { ConnectorKind } from "./connector-helpers";

/**
 * `factory` (Task 5, `availability: "internal"`) is filtered out of the grid
 * entirely by `projectConnectors` before a `ConnectorView` ever reaches
 * either consumer of this map (see that function's own doc-comment) — this
 * glyph is dead code, present only so `KIND_ICON`/`KIND_TINT` below (typed
 * `Record<ConnectorKind, …>`) stay total now that `ConnectorKind` includes
 * `"factory"`. Wraps the already-imported `Radio` rather than assigning it
 * directly so the map entry's type is exactly `BrandIconProps`, matching
 * every other entry, instead of relying on lucide's own (wider) prop type
 * being structurally compatible.
 */
function FactoryGlyph({ size = 18, className }: BrandIconProps) {
  return <Radio size={size} className={className} aria-hidden="true" />;
}

/**
 * Brand glyph + tint per connector kind (lucide carries no logos — see
 * brand-icons.tsx). Connectors UX v2 Track A: split out of
 * connectors-panel.tsx (where this lived pre-redesign) into its own module
 * so BOTH the tile grid (connectors-panel.tsx) and the connect/manage sheet
 * (connector-sheet.tsx) can import it without either file importing the
 * other — connectors-panel.tsx renders <ConnectorSheet>, so a sheet→panel
 * import for just this map would form a cycle. Pure data, no behavior
 * change from the pre-redesign map.
 */
export const KIND_ICON: Record<ConnectorKind, ComponentType<BrandIconProps>> = {
  github: GithubBrand,
  linear: LinearBrand,
  figma: FigmaBrand,
  context7: Context7Brand,
  factory: FactoryGlyph,
  railway: RailwayBrand,
  langfuse: LangfuseBrand,
  sentry: SentryBrand,
  datadog: DatadogBrand,
  prometheus: PrometheusBrand,
  grafana: GrafanaBrand,
  vercel: VercelBrand,
  cloudflare: CloudflareBrand,
};

/** A subtle brand tint per kind, used on the icon chip so cards stay scannable. */
export const KIND_TINT: Record<ConnectorKind, string> = {
  github: "text-[var(--gray-12)]",
  linear: "text-[#5e6ad2]",
  figma: "text-[#f24e1e]",
  context7: "text-[var(--gray-11)]",
  factory: "text-[var(--gray-11)]",
  // Railway's mark is monochrome (like GitHub's) — the gray var, not a
  // literal brand hex (Task 7 could not confirm one against public docs).
  railway: "text-[var(--gray-12)]",
  // Task P2: same fallback as Railway — Langfuse's mark here is a generic
  // stand-in (brand-icons.tsx's own doc-comment), so no brand hex to pin.
  langfuse: "text-[var(--gray-12)]",
  // Task P3: Sentry's real brand purple, confirmed against simple-icons'
  // own data/simple-icons.json ("hex": "362D59") — unlike Railway/Langfuse
  // above, a real mark exists, so a real hex is pinned too.
  sentry: "text-[#362d59]",
  // Task P4: Datadog's real brand purple ("Daisy Bush", #632CA6) — same
  // "real mark exists, so a real hex is pinned" precedent as Sentry above.
  datadog: "text-[#632ca6]",
  // Task P5: Prometheus's real brand orange (#E6522C, "Cinnabar", confirmed
  // against simple-icons' own data) — same "real mark exists, so a real hex
  // is pinned" precedent as Sentry/Datadog above.
  prometheus: "text-[#e6522c]",
  // Task P6: Grafana's real brand orange (#F46800, confirmed against
  // simple-icons' own data) — same "real mark exists, so a real hex is
  // pinned" precedent as Sentry/Datadog/Prometheus above.
  grafana: "text-[#f46800]",
  // Task P7: Vercel's mark is monochrome (like GitHub's/Railway's/
  // Langfuse's) — the gray var, not a literal brand hex (Vercel's own
  // identity is pure black-in-light/white-in-dark, which a fixed hex
  // cannot represent across both themes).
  vercel: "text-[var(--gray-12)]",
  // Task P8 (final Wave-2 provider): Cloudflare's real brand orange
  // (#F38020, confirmed against simple-icons' own data) — same "real mark
  // exists, so a real hex is pinned" precedent as Sentry/Datadog/
  // Prometheus/Grafana above.
  cloudflare: "text-[#f38020]",
};
