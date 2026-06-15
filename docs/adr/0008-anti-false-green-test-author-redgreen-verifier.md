# ADR 0008: Anti-false-green — separate Test-Author role, Red-Green Proof, different-model Verifier

## Status

Accepted

## Context

With the **Objective Gate** ("tests pass") as the definition of done (ADR 0007),
an agent that writes both the solution and its own tests can game the gate by
writing tautological tests that assert nothing. This was observed in practice:
runs that reported "tests pass" while the change still missed the intent
(false-green).

## Decision

Defeat false-green with three separated roles and a falsifiable property of the
test itself:

1. **Test-Author** (a checker) turns the issue's acceptance criteria into a
   *failing* acceptance test **before** any implementation.
2. **Implementer** (the maker) writes the smallest change to turn that test green.
3. **Verifier** (**Independent Verification**, a *different* model than the
   Implementer) confirms the solution **and** the tests satisfy the AC contract.

The **Objective Gate** requires the **Red-Green Proof**: the acceptance test must
be observed failing before implementation and passing after — proving the test is
real (not tautological) and that the change caused the pass.

## Consequences

- The maker cannot author tautological tests in its own favour, because it does
  not author the test.
- Red-before-green proves the test exercises the behaviour; a different-model
  verifier prevents self-preferential bias.
- Costs more tokens per issue (an extra agent and a second model). This is
  accepted: trust in the gate is the product.
- Still bounded by acceptance-criteria quality — a vague AC yields a vague test.
  See ADR 0007's input contract.
