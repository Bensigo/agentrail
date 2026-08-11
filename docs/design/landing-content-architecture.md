# Landing Content Architecture

This is the public-copy boundary for Jace. It describes the current source
structure, not deployed, live, or customer proof. Pair it with
`docs/design/redesign-direction.md` for craft constraints.

## The spine

Jace is the trust layer around a team's coding agents. It does not present
itself as the builder, a factory, or an auto-merge system. The landing tells
one ordered story:

1. Plan the request.
2. Confirm the acceptance criteria with a human.
3. Hand the confirmed Contract and bounded Context Pack to the selected
   external coding agent through MCP.
4. Review the resulting pull request against its confirmed intent.
5. Show criterion evidence or refuse success and provide a correction path.
6. Leave accept, rework, or reject to a human.

## Section map (`apps/console/app/(marketing)/page.tsx`)

| Section | Public-copy boundary |
| --- | --- |
| Hero and demo | A request is planned and its criteria are confirmed before work. |
| Reviewability cards | Bounded Contracts, evidence, reviewability, and explicit refusal; no factory-execution claim. |
| How Jace works | The ordered planning → confirmation → MCP → external-builder → intent-review → evidence/refusal → human-decision flow. |
| Channels | Jace connects acceptance custody to the agent and channel a team already uses. |
| Pricing | A team commercial experiment. It does not claim product value, delivery, review savings, or payment availability beyond its explicit status. |
| Closing | Starts with a confirmed change and evidence attached to the result. |

## Technical-doc boundary

Technical documentation may describe optional internal adapters, the CLI,
workers, or managed-build experiments. Those descriptions are implementation
context, not public promises that Jace will generate code, deliver a pull
request, merge it, or operate live for a customer. Keep that boundary explicit
when technical copy changes.
