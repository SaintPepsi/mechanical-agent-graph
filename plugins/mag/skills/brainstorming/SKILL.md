---
name: brainstorming
description: Engineering brainstorming mode for software work — a feature, component, refactor, or architecture decision. USE WHEN brainstorming or designing a feature/component/refactor, choosing between approaches, or thinking through architecture before writing implementation code.
---

# Engineering Brainstorming

Turn a software idea into a fully-formed design through collaborative dialogue, evaluated against the engineering principles stack.

## Checklist

Create a task for each item and complete in order:

1. **Envision** — draw the ideal shape of the built thing, once per matched stack, blind to what exists today → `docs/graph/<TICKET>/vision-<notation>.md`
2. **Discover** — recon what the codebase already has, cited by path, never assumed → `docs/graph/<TICKET>/discover.md`
3. **Explore project context** — files, docs, recent commits, relevant types
4. **Read `./principles/index.md`** — engineering principles stack (leaf files load just-in-time)
5. **Ask clarifying questions** — one at a time, multiple-choice when possible
6. **Propose 2-3 approaches** — each evaluated against principles, with tradeoffs and recommendation
7. **Envision the shell** — draw the chosen approach as a shell: the ideal shape of the built thing (see "The Envisioned Shell" below)
8. **Present design** — sections scaled to complexity, incremental approval
9. **Write design doc** — to `docs/graph/<TICKET>/design.md`, including "Envisioned Shell", "Seams & Ownership", and "Principles applied" sections
10. **Confirm the design doc** — the file at `docs/graph/<TICKET>/design.md` is written and non-empty. The node checks it and copies it into the run record; whether it is also committed is the repository's policy, not yours: do not run git
11. **Return** — the design doc you wrote is this skill's terminal artifact. Do NOT invoke any implementation skill; planning and execution belong to the caller.

## The Design Lane

This design follows one spine, **Envision ∥ Discover → Brainstorm**: draw the ideal shape of the built thing blind to what exists, recon the codebase for what already covers this ground, then join the two into a design. Envision and Discover (checklist items 1 and 2) open together; enter from either side. Brainstorm joins them:

**Brainstorm** — join the visions to discover's recon and this checklist's own design into one design doc → `docs/graph/<TICKET>/design.md`

`<TICKET>` above and below is this session's ticket id; use a short kebab-case slug instead when none exists, the same slug everywhere it appears. `<notation>` stands for whichever matched stack's vision this design cites (svelte, effect, graph-core, or generic) — one path per matched stack, not a single fill.

If the work is **not** primarily code (article, talk, naming, life decision), this engineering mode isn't the right fit — stop and brainstorm it conversationally instead.

<HARD-GATE>
Do NOT invoke any implementation skill, write any code, scaffold any project, or take any implementation action until you have presented a design and the user has approved it. This applies to EVERY project regardless of perceived simplicity.
</HARD-GATE>

## Anti-Pattern: "This Is Too Simple To Need A Design"

Every project goes through this process. A todo list, a single-function utility, a config change — all of them. "Simple" projects are where unexamined assumptions cause the most wasted work. The design can be short (a few sentences for truly simple projects), but it is not optional.

## Engineering Principles Stack

**Read `./principles/index.md` in full before proposing approaches.** It carries every principle's Goal and Rule — the rules are binding from the index alone. Per-principle leaf files under `./principles/` hold the teaching material (why it works, examples, "When This Doesn't Apply").

Open a leaf file at these moments (not speculatively):

- **Unsure how a principle applies** to an approach — read its examples rather than guessing
- **Justifying a violation** — see below
- **Before writing the Principles-applied section** — open the leaf of every principle you cite in it

When proposing approaches and presenting the design:

- Evaluate each approach against the relevant principles
- Call out tradeoffs in principle terms ("Approach B violates Single Source of Truth because…")
- The final design doc must include a **Principles applied** section listing which principles shaped the design and how

If a proposed approach violates a principle, you must either (a) justify the violation by opening that principle's leaf file and **quoting the applicable "When This Doesn't Apply" bullet verbatim** in the design doc's Deviations entry, or (b) revise the approach. The index's one-line teaser is not quotable material — a justification that doesn't quote the leaf is not a justification. Don't silently violate principles. Principles inform, not constrain: they exist to surface tradeoffs, not to block exploration.

## Clarifying Questions

Cover purpose, constraints, success criteria, performance requirements, and integration points.

## Exploring Approaches

Remove unnecessary features — YAGNI ruthlessly. If you can't write a plausible **Wins when:** for an approach, it isn't a real option: replace it with one that is.

## The Envisioned Shell

Before presenting the design, draw the desired outcome as a shell: the ideal shape of the built thing, blind to the current mess, in whichever notation the matched stack calls for.

- **No file paths, no resolution verbs.** The design names *what exists* and *who owns it*; the plan (the sibling `../writing-plans/SKILL.md`) resolves every symbol against the codebase (reuse / repurpose / create / extract) and has final say on *where it lives*. Stating a fact in the ownership table ("already lives in the shared package") is a design call and fine; assigning a resolution verb or a path is the plan's job.

Alongside the shell, fill the **Seams & Ownership** table: each named part with an owner — server / shared package / app (adapt the owner set to the repo's real layers). Shared-vs-local is a design-time call, never deferred to the plan.

A design that retires a ruling, renames a contract, or moves a file records a **Reference Sweep** alongside that table: the repo-wide grep you ran for the old name, docs included, and every hit it returned, each hit either owned by an edit this change makes or carrying a one-line reason its wording stays (frozen historical records keep theirs).

Pick the notation the change actually deserves — prose, a diagram, pseudo-code, whatever draws the idea without prescribing its file layout — and name which one in the design. The discipline is unchanged: draw the ideal shape of the built thing, imagined as if from nothing — what exists today has no vote.

## What You May Decide vs What the User Sees

Pragmatic calls cover **how it's built** — structure, seams, placement, data flow. They never cover **what the user sees relative to what already exists**. If a choice would make an existing concept look or behave differently from how it renders today — dropping a label, changing an affordance, restyling a shared element — that is a product decision, not a design decision: ask the user, or when running autonomously, record it in Open Questions and **default to the existing behavior**. "The requirements don't mention it" argues **for** the status quo, never against it (principle: Same Concept, Same Rendering — silence in the ACs is not permission to diverge).

## Presenting the Design

Scale each section to complexity.

Ask after each section whether it looks right, and be ready to revise. Cap dialogue messages around 6-10 lines unless presenting a full design: present, approve, then move on.

## Interpretation Rulings

Every AC ambiguity you resolve is a recorded ruling, never a silent choice. Where the design commits to a reading of an AC whose wording allows more than one, the design doc's **Interpretation Rulings** section records the AC id, the chosen reading, and its basis. A ruling about user-visible behaviour with no basis in the ticket or its attachments is not yours to make — it goes under Open Questions instead.

## Convention Rulings

A design that adds a package, module tree, or tool — rather than extending one that exists — records its conventions as first-class rulings: import style, test placement, naming, and the process-globals boundary, each with its basis in the repo's existing precedent. A convention left unruled here gets decided by accident wherever the build session first needs it, instead of once, here.

## Improvements

An improvement you notice while designing is decided now, not deferred: build it in this same run, never file it as a follow-up ticket. A backlog entry is where an improvement goes to rot.

## Design Doc Template

```markdown
# <Topic> — Design

**Date:** YYYY-MM-DD

## Problem

What we're solving and why.

## Constraints

Hard limits, deadlines, integration requirements.

## Approaches Considered

<!-- Identical rubric per approach. NO verdicts here — no "rejected", no "(recommended)";
     the comparison happens in Chosen Approach, after all options are drawn in full. -->

1. **Approach A** — summary, structure, principle implications, costs/risks. **Wins when:** …
2. **Approach B** — summary, structure, principle implications, costs/risks. **Wins when:** …
3. **Approach C** — summary, structure, principle implications, costs/risks. **Wins when:** …

## Chosen Approach

The picked approach and why — including why each alternative's "Wins when:" condition
doesn't hold here. This is the only section where rejection language belongs.

## Envisioned Shell

<!-- the feature drawn in the matched stack's own notation;
     tags/factories/rails may not exist yet; NO file paths -->

## Seams & Ownership

| Seam | Responsibility | Owner (server / shared package / app) |
| --- | --- | --- |

## Reference Sweep

Present when the change retires a ruling, renames a contract, or moves a file: the grep command run, then one row per hit.

| Hit | Owned by / reason its wording stays |
| --- | --- |

## Architecture

Components, data shapes, flow.

## Data Model

Types, schemas, central definitions.

## Error Handling

Failure modes and responses.

## Testing Strategy

What gets tested at which layer (unit / integration / e2e).

## Principles Applied

- **<Principle name>** — how the design honors it
- **<Principle name>** — how the design honors it
- **Deviations (if any)** — the principle's "When This Doesn't Apply" bullet, quoted verbatim from its leaf file, plus why it covers this case

## Interpretation Rulings

Present when an AC's wording allows more than one reading. One row per ruling: the AC id, the chosen reading, and its basis.

| AC | Reading | Basis |
| --- | --- | --- |

## Convention Rulings

Present when the design creates a new surface. One row per convention settled: the topic, the ruling, and the precedent it's based on.

| Topic | Ruling | Precedent |
| --- | --- | --- |

## Open Questions

Anything unresolved.
```

