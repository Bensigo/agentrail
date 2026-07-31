import { disableTool } from "eve/tools";

// Nested investigator isolation (Task 10, debugging design spec:
// docs/superpowers/specs/2026-07-29-jace-debugging-agent-design.md; spec PR
// #1501) — Eve injects a default harness (bash, write_file, read_file, ...) into
// EVERY agent at runtime regardless of the authored tools list. This
// investigator answers ONE mission question via its two authored, read-only
// evidence-verb tools (fetch_changes, search_events) and returns a single
// structured result (outputSchema); it inherits nothing from its parent (the
// debugger) or from root.
//
// todo tracks a multi-step task. This investigator is a single-call,
// structured-output task (outputSchema), not a multi-step tracked one, so todo
// is stripped.
//
// A tools/<name>.ts that default-exports disableTool() drops that framework
// tool from this agent's runtime registry.
export default disableTool();
