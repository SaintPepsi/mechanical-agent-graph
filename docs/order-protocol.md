# Order protocol

How the work order is kept, checked, and advanced. **The tracker tracks state, this
document holds the protocol.**

## Where the order lives

- **The milestone is the order.** Each campaign is a GitHub milestone; every step is a real issue on
  it. Closed issues drop out of view on their own — nothing is ticked, struck through, or renumbered
  by hand.
- **Sequence** lives in the milestone description as one ordered line of issue numbers, plus a
  `Depends on:` line in each issue body. Gated steps name their condition in the body and carry
  `form:revisit`.
- **Forms are labels.** `form:graph-run` (the CLI does the full step; a person starts and
  supervises the run), `form:in-session` (a person or model does the step in one work session),
  `form:conversation` (the result is a decision written in a document, not code), `form:revisit`
  (decided later; the issue names the condition that reopens it).
- **History** is not this document's job. A campaign's step-by-step audit lives in the advisor
  comments on the campaign's milestone issue; run records live in the journals.

## End goal

The graph grows by adding edges in code — per-ticket branching, fan-out, and eventually
machine-authored graph files typechecked against the registry — never by an engine that walks
topology-as-data.

## How the order gets checked

Consult a Fable subagent before ruling on the order, and whenever the order has not been questioned
in a while. Ask it for advice, not an audit — it decides priority and cuts clutter well, and that is
what it is for here.

- **Prompt it as a manager or coach giving advice to a colleague**, not as a reviewer producing
  findings. Tell it to take positions, say "I would do X", and disagree once with reasoning where it
  thinks something is wrong.
- **Point it at:** `docs/rebuild-sketch.md`, `docs/core-definitions.md`, the repo
  root `CLAUDE.md`, `plugins/mag/PRINCIPLES.md`, the current milestone, and `plugins/mag/src/`.
- **Ask it:** what the next sequence should be and what form each step takes; what should be cut;
  what will hurt in a month; what is not on the critical path.
- **Answers may be steps rather than tickets.** A conversation, a throwaway spike or an in-session
  port is a legitimate answer — file it as an issue with its form label.
- **Give it the deltas** each time: what shipped, what was cut, what was deferred since it last
  advised.
- **Sonnet does the legwork**, never Fable: citation cross-checks, "is this ticket still accurate",
  searching the tree. Fable is only for the judgment call.
- **The ruling stays the maintainer's.** Post the advice as a comment on the milestone issue
  unacted, then apply what is accepted: retitle the milestone's description line, file or close
  issues, move labels.

## Before starting any step

Read `node_modules/effect/AGENTS.md` and ground the *design decisions* in it, not just the code —
a `setInterval` watchdog once shipped inside an `Effect.promise` that silently discarded
interruption, because the API was consulted at implementation time instead of before the shape was
chosen.
