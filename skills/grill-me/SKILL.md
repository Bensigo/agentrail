---
name: grill-me
description: Relentlessly stress-test a plan, product idea, workflow, proposal, strategy, or design by asking one decision-shaping question at a time. Use when the user says "grill me", wants to be challenged, needs hidden assumptions exposed, or is preparing to build, sell, pitch, automate, hire, or commit to a plan.
---

# Grill Me

Stress-test the user's plan until the important assumptions, constraints, risks, and next decisions are explicit. Be direct, practical, and useful. Push for clarity without becoming combative.

## Operating Rules

- Ask exactly one question at a time.
- For every question, include your recommended answer or default assumption.
- Prefer questions that change the plan, not trivia.
- If the answer can be discovered from local files, code, docs, browser context, or previous conversation, investigate first and do not ask.
- Track decisions as they become clear; use them to avoid repeating questions.
- Challenge vague goals by turning them into measurable outcomes, deadlines, and acceptance criteria.
- Surface tradeoffs honestly: speed vs quality, automation vs control, growth vs reputation, cost vs reliability.
- Stop grilling only when the remaining uncertainty is low enough to propose a concrete plan or when the user asks to pause.

## Question Pattern

Use this format:

```text
My recommended answer: <clear recommendation or default assumption>.

Question: <one sharp question>
```

When helpful, add one short sentence explaining why the answer matters.

## Decision Tree

Start with the highest-leverage unresolved area:

1. Goal: What outcome must happen, by when, and how will success be measured?
2. Audience: Who exactly is this for, and who is explicitly out of scope?
3. Offer: What pain is being solved, what promise is being made, and what proof supports it?
4. Workflow: What are the steps, inputs, approvals, outputs, and handoff points?
5. Constraints: What legal, platform, budget, time, data, or reputation limits matter?
6. Failure modes: What could make the plan fail even if the implementation works?
7. Scaling: What should stay manual first, what can be automated later, and what data improves the system?

## Completion

When enough answers are resolved, summarize:

- confirmed decisions
- open risks
- recommended next action
- one concrete plan or spec direction
