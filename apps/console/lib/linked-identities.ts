/**
 * `linkedIdentitiesLine` — one line summarizing a chat channel's linked
 * identities. Lifted out of `connectors/components/connector-helpers.ts`
 * (added there by #1449) into this shared, surface-agnostic home
 * (gateways-page T1) so the new gateways page can call the exact same
 * formatter alongside its existing callers, the connectors page and the
 * setup wizard's channel step — `connector-helpers.ts` loses this function
 * entirely once the gateways page ships (T4 strips the channel model out of
 * the connectors surface).
 */

/**
 * One line summarizing a channel's linked identities. Shared between the
 * connectors page (`connectors-panel.tsx`) and the setup wizard's channel
 * step (`channel-step.tsx`) so a connected channel reads identically in both
 * places — lifted here (was a private helper in `connectors-panel.tsx`)
 * rather than duplicated, per the connectors-channels wizard cutover (T5).
 * Takes bare display names, not full identity objects: this is a pure
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
