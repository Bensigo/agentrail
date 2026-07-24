/**
 * `linkedIdentitiesLine` — one line summarizing a chat channel's linked
 * identities. Lifted out of `connectors/components/connector-helpers.ts`
 * (added there by #1449) into this shared, surface-agnostic home
 * (gateways-page T1). Once gateways-page T4 shipped, `connector-helpers.ts`
 * lost this function entirely and the connectors page stopped calling it —
 * today's real consumers are the Gateways page (`gateways-panel.tsx`) and
 * the setup wizard's channel step (`channel-step.tsx`).
 */

/**
 * One line summarizing a channel's linked identities. Shared between the
 * Gateways page (`gateways-panel.tsx`) and the setup wizard's channel step
 * (`channel-step.tsx`) so a connected channel reads identically in both
 * places — see the module doc-comment above for the full lineage. Takes
 * bare display names, not full identity objects: this is a pure
 * formatting rule over the one field either caller ever has to show, and
 * keeping the parameter that narrow means neither caller needs to fabricate
 * or unwrap an object shape it doesn't otherwise have (the wizard only ever
 * has names, never a platform user id, by design).
 *
 * Simplest honest form: a linked identity can have a null displayName (a
 * `chat_identities` row with no profile name), so when NONE of them have a
 * name there's nothing to list — just the count. Otherwise list the names we
 * do have and fold the nameless ones into a trailing "+N" rather than pad the
 * list with placeholders.
 */
export function linkedIdentitiesLine(displayNames: (string | null)[]): string {
  const names = displayNames.filter((name): name is string => name !== null);
  if (names.length === 0) return `${displayNames.length} linked`;
  const unnamed = displayNames.length - names.length;
  const joined = names.join(", ");
  return unnamed > 0 ? `Linked: ${joined} +${unnamed}` : `Linked: ${joined}`;
}
