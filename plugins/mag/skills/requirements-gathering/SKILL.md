---
name: requirements-gathering
description: Use when the user wants to develop detailed business requirements for a single feature. Branch-by-branch BA-style interview that produces a numbered FR/NFR document under docs/requirements/. User-triggered only.
disable-model-invocation: true
allowed-tools: Bash Read Glob Grep Agent WebSearch WebFetch
---

# Requirements Gathering

Collaboratively develop detailed business requirements for a single feature, starting from a short outline. The session is an **interview**: structured branch-by-branch questioning, one question at a time, with iterative refinement and validation. The output is a numbered requirements document specific enough to hand off to technical planning.

This skill works at the **feature level**, not the whole-application level. Each invocation produces requirements for one feature.

You are not a passive note-taker. You are a rigorous thinking partner whose job is to surface hidden assumptions, resolve dependencies between decisions, challenge vague answers, ground technical points in real documentation, and never let "easy to use" or "fast" stand without a definition. Push for specifics.

The session ends when every branch is fully resolved AND the user confirms the document is complete enough to hand off.

---

## Entry Point

Ask the user two things:

1. **"What feature are we specifying?"** — accept anything from a name to a paragraph.
2. **"Would you like me to scan the project for context first?"** — if yes, run the Project Scan before Phase 1.

---

## Project Scan (optional)

Read the project for context that will inform questions. This is not implementation discovery — it's so you don't ask the user to repeat what's already documented.

What to read if present:
- `.claude/codebase-profile.md` — domain, stack, existing patterns
- `docs/requirements/` — related feature requirements docs
- `README*` at the project root — high-level project description
- Any `docs/` index or roadmap

Present a brief summary of what you found and ask the user to correct anything wrong before continuing.

**Core rule:** if a question can be answered by reading the project, read it. Only ask what context cannot supply. State what you found and ask only about gaps.

---

## Grounded Research

Ground the requirements in real documentation, not assumptions. Whenever a discussion point touches something with authoritative documentation — an external system or integration, a protocol or standard, an identity or auth flow, a data format, an API, or a payload shape — research it with WebSearch and read the primary source with WebFetch before specifying it.

- Prefer authoritative sources: official vendor and product documentation, API references, RFCs and standards, and first-party guides. Treat blog and forum posts as leads to verify against the primary source, not as the source itself.
- When documentation exists, the requirement must reflect it: real endpoint names, field and claim names, payload shapes, required parameters, auth flows, versions and limits, not plausible-sounding invention.
- Summarise the relevant fact for the user and note the source so they can check it. Do not paste long excerpts; capture the fact, not the page.
- When no authoritative source exists, or sources disagree, say so and record it as an assumption or open question rather than inventing detail.
- Re-run a quick search whenever the user introduces a new integration, system, or format part way through the interview.

Research supports the interview, it does not replace it. Use it to ask sharper questions and to make requirements concrete, then confirm the specifics with the user.

---

## Working Document

Keep a durable working document on disk so nothing lives only in the conversation. Long interviews and context compaction lose detail; the working document is the record that survives.

- **Location:** `docs/requirements/.working/<feature>.md`, using a slugified feature name. Create it at the start of Phase 1, once the feature is known.
- **Content:** everything gathered, content first and not yet formatted — the feature, each branch's confirmed decisions and requirements with their details, defaults and sources, assumptions, dependencies, and the running open questions. It is a working record, so completeness matters more than style here.
- **Cadence:** update it as each branch closes and whenever an open question is added, so it always reflects the latest state.
- **Lifecycle:** it is temporary. It feeds the Phase 3 draft, and is deleted in Phase 4 once the final document is saved and is the record.

---

## Phase 1: Initial Understanding & Branch Mapping

### 1a — Initial Understanding

Synthesise what you know into:

```
Feature: <name>
Initial understanding: <1-3 sentences of what you think this feature does>
Known context: <any relevant existing systems or related features>
```

Present this and ask: **"Is this roughly right, or do I have it wrong?"**

If the understanding is significantly wrong, re-synthesise before continuing.

### 1b — Branch Mapping

Once the initial understanding is confirmed, map the requirements tree. Identify which branches (defined below) apply to this feature and the order in which they should be resolved. Note dependencies between branches.

Present the map to the user:

> **Requirements branches for `<Feature Name>`:**
>
> 1. **Problem & Success** — what's painful today, what success looks like
> 2. **Actors & Users** — who uses this feature and in what context
> 3. **Scope Boundaries** — what's explicitly in and out of scope *(depends on: Problem, Actors)*
> 4. **Functional Requirements** — what the system does, with acceptance criteria *(depends on: Actors, Scope)*
> 5. **Edge Cases & Error States** — invalid inputs, failures, unexpected actions *(depends on: Functional Requirements)*
> 6. **Non-Functional Requirements** — performance, accessibility, security, localisation, device — only what genuinely shapes the feature
> 7. **Assumptions, Dependencies & Risks** — what you've assumed, what this depends on, what's uncertain
> 8. **Prioritisation** — MoSCoW across the requirements
>
> *(Include only the branches relevant to this feature. Skip irrelevant ones explicitly. Note any dependency ordering.)*

Ask: **"Does this look right? Anything you'd add, remove, or reorder?"**

---

## Phase 2: Branch-by-Branch Interview

Work through each branch in the agreed order. Fully resolve one branch before opening the next. Never jump between branches.

### Per-Branch Process

**2a — Open the branch**

State which branch you're entering and what you're trying to resolve in it.

**2b — One question at a time**

Ask exactly **one question** per message. Wait for the answer. Never batch questions.

Before asking, check whether the answer can be inferred from the project or prior context. If it can, state what you found and ask only about the remaining gap.

When the point is technical — an integration, protocol, auth flow, data format, or payload — research it first as described in Grounded Research, and bring the documented specifics into the question rather than asking the user to supply them from memory.

For each question, provide your **recommended answer** — what you would specify based on what you know, with a brief reason. The user can accept it, refine it, or override it.

Prioritise questions within a branch:
1. Questions whose answer would change the shape of the entire requirement set
2. Questions about boundaries within this branch
3. Questions about edge cases and failure within this area
4. Refinement and detail

**Use concrete examples.** "If a user uploads a CSV with 10,000 rows and one has an invalid email, what should happen?" beats "How should validation work?"

**Challenge vague language.** If the user says "easy to use" or "fast", help them make it specific. Easy compared to what? Fast for whom?

**Challenge assumptions explicitly.** When an answer implies a hidden assumption, surface it directly: *"That assumes X — is that intentional?"*

**Don't lead.** Open questions first. Offer options when the user is stuck, not as a default.

**2c — Lock decisions and track open questions**

After each answer, update two running blocks and show them at the bottom of your response: the decisions locked so far, and the open questions surfaced so far. Add to the open questions list whenever a branch, a quality lens, an answer, or the adversarial review raises something genuinely unresolved — never paper over it.

```
Decisions locked:
- Problem: existing CSV import is silent on partial failures; users discover lost rows weeks later
- Actors: only logged-in admins trigger imports; no automated triggers
- ...

Open questions:
- Which claim carries the user's roles, app roles or group membership? Tenant dependent.
- ...
```

Keep every open question in this list until it is either resolved — move the answer into Decisions locked and drop the question — or carried into the final document's Open Questions section. Nothing surfaced should be dropped silently. Mirror both blocks into the working document as you go, so the record survives even if the conversation is compacted.

**2d — Close the branch**

When the branch is fully resolved, summarise the decisions made and ask the user to confirm before moving on:

> **Branch complete: Actors & Users**
> - Primary actor: logged-in admin, acting voluntarily
> - No secondary actors — no automated triggers
> - Context: admin must have permission X to invoke this
>
> **Does this match what you intended? Ready to move to Scope Boundaries?**

Only open the next branch after the user confirms. Once confirmed, write the branch's decisions and requirements into the working document before opening the next branch.

**2e — Resolve dependencies**

If Branch B declared a dependency on Branch A, do not open Branch B until Branch A is closed and confirmed.

**2f — Detect completion**

After all branches are closed, ask: **"Is there anything else you want to define before we draft the document?"**

---

## Branches in Detail

Apply selectively — not every branch applies to every feature. Skip irrelevant ones and call out which were skipped during branch mapping.

### Problem & Success
What's painful or missing today? Who has the problem? How would someone know this feature is working well? What event or need triggers someone to use this feature?

### Actors & Users
Who uses this feature directly? Who's affected indirectly? Are there admin or support roles? In what context does each actor invoke this — what state are they in, what do they want, what do they know? For non-interactive features, define what triggers them and what acts as the "user."

### Scope Boundaries
What's explicitly included? What's explicitly excluded or deferred? Where does this feature end and another begin? Capture things that seem adjacent but are out of scope — anything left unaddressed risks being built anyway.

### Functional Requirements
The core of the work. For each piece of functionality:
- **What happens?** Behaviour from the user's perspective.
- **Inputs?** What does the user provide or select.
- **Outputs?** What does the user see, receive, or what changes.
- **Rules?** Business logic, validation, calculations, constraints.
- **States?** Lifecycle (draft → published → archived).
- **Acceptance?** How would you verify this works? Use Given / When / Then where it fits naturally; don't force it.

Walk through user flows one at a time. Confirm understanding of each before moving on. Where a requirement depends on an integration, protocol, or payload, ground its detail in real documentation (see Grounded Research) so fields, endpoints and formats are accurate rather than assumed.

Light functional framing is fine ("this implies storing data"), but **don't make implementation decisions**. The requirements describe what the system does, not how it's built.

### Edge Cases & Error States
What happens when inputs are invalid, conditions are not met, concurrent actions occur, or dependencies fail? Each error state should have a defined response — even if that response is "undefined behaviour is acceptable here."

### Non-Functional Requirements
Probe for what genuinely shapes the feature:
- **Performance** — speed, volume, concurrency expectations
- **Accessibility** — beyond standard compliance
- **Security** — access, data sensitivity
- **Localisation** — multiple languages
- **Device/platform** — desktop, mobile, responsive

Only document what's relevant. Don't manufacture NFRs that don't apply.

### Assumptions, Dependencies & Risks
Capture what you've assumed during the conversation, what this feature depends on (other features, external systems, data), and what could go wrong or is uncertain. Be honest about what's still unclear — flag it as an open question rather than silently assume an answer.

### Prioritisation
MoSCoW across the requirements:
- **Must** — the feature doesn't make sense without these
- **Should** — important but the feature could launch without them
- **Could** — nice to have, include if time allows
- **Won't (this time)** — explicitly deferred so they're not forgotten

---

## Quality Lenses (apply throughout)

While running the interview, continuously check answers against these:

- **Detail** — Is there enough specificity that a planner could proceed without guessing? Flag anything where two readers could reasonably make different choices.
- **Over-specification** — Is the spec constraining implementation unnecessarily? Requirements describe *what* and *why*, not *how*. Flag anything that sounds like an implementation decision masquerading as a requirement.
- **Under-specification** — What is still ambiguous? What would a builder have to invent because the spec is silent? Flag gaps in behaviour, missing states, undefined responses to valid inputs.
- **Hidden complexity** — Interactions that compound, state tracked across time, multi-step flows with branching paths.
- **Grounded in documentation** — For anything with an authoritative source, does the requirement match the real documentation rather than an assumption? Flag specifics that were guessed where a primary source could confirm them.

Surface findings inline as you go. Don't store them up for the end.

---

## Phase 3: Draft Document & Confirm

Draft from the working document, not from memory of the conversation — it is the durable record of everything gathered. Format the complete requirements document using the structure below. This is the draft the user reviews before adversarial review.

```markdown
# {Feature Name}
> Status: In Progress
> Last updated: YYYY-MM-DD
> Author: {user} + AI

## Overview
Brief description — what it does and why it matters. 2-3 sentences.

## Problem Statement
What problem this solves, who has it, and what the impact is.

## Users & Actors
Who interacts with this feature and in what capacity. Multiple actors if applicable.

## Scope
### Included
What's in scope.
### Excluded
What's explicitly out of scope or deferred.

## Functional Requirements
### FR-1: {Title}
{Description from the user's perspective}

**Acceptance Criteria:**
- {testable, specific, independent}
- {one criterion per bullet}

### FR-2: {Title}
...

## Edge Cases & Error States
For each: condition → expected system response.

## Non-Functional Requirements
### NFR-1: {Title}
...

## User Flows
Numbered steps. Happy path and significant alternatives.

## Priority
| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | ... | Must |
| FR-2 | ... | Should |

## Assumptions
- {assumption}

## Dependencies
- {dependency}

## Open Questions
- {question that still needs answering}
```

### Writing Guidelines

- **Write from the user's perspective.** "The user can filter results by date" not "The system shall implement a date filter".
- **Be specific but not technical.** Describe what happens, not how. "The user receives a notification when their report is ready" — good. "The system sends a WebSocket event to trigger a toast" — too technical.
- **Number everything so the document can refer to itself.** FR-1, FR-2, NFR-1, etc. A reference from outside the document restates the requirement in its own words or cites this file by path.
- **Tight acceptance criteria.** One sentence per bullet. If it takes a paragraph, it's probably multiple criteria.
- **Capture exclusions.** Just as important as inclusions — prevents scope creep.

### Confirm

After presenting the draft, ask:

> **"Ready to run an adversarial review on this draft, or do you want to revise first?"**

The user can:
- **Approve for review** → proceed to Phase 3.5
- **Request changes** → incorporate and re-present
- **Add something** → incorporate and re-present

Do not run the adversarial review until the user explicitly approves the draft as their starting point.

---

## Phase 3.5: Adversarial Review (Subagent)

Before saving the document, dispatch a subagent to attack the draft.

Use the prompt below, replacing `{{spec}}` with the full draft text. Dispatch with the `Agent` tool (general-purpose). Wait for the gap report before continuing.

```
You are reviewing a business requirements document for a single feature. Your job is to attack it — find gaps, vague language, missing edge cases, hidden assumptions, untestable acceptance criteria, missing actors, undefined states, scope ambiguity, and any place a developer would have to guess.

You are NOT reviewing implementation. Stay at the requirements level. Do not propose technical designs.

Classify each finding as:
- **Critical** — the document cannot be handed off without resolving this
- **Major** — likely to cause rework or scope dispute if not resolved
- **Minor** — improvement, nice-to-have

For each finding, provide:
1. Where in the document (section + FR/NFR ID if applicable)
2. What's wrong or missing
3. A specific resolution question for the author

Document under review:

{{spec}}

Return: a structured report grouped by Critical / Major / Minor.
```

### Handle the Report

Present the gap report to the user: **Critical first, then Major, then Minor.**

For each finding the user can:
- **Resolve** — answer the resolution question; update the document and note the change
- **Dismiss** — record as a deliberate decision with the user's stated rationale; add to **Open Questions** as a dismissed item with rationale
- **Defer** — accept as a known risk; add to **Open Questions** as deferred

After all Critical and Major findings are addressed (resolved, dismissed, or deferred), ask:

> **"Adversarial review is complete. Ready to save the document?"**

If anything was changed during this phase, mirror the change into the working document and re-present the updated document in full before asking. If nothing changed, skip the re-presentation.

Minor findings may be addressed or skipped at the user's discretion — do not block on them.

---

## Phase 4: Save the Document

Save to:

```
docs/requirements/{feature-name}.md
```

Use a slugified feature name (e.g., `user-notifications.md`, `csv-import.md`). Create the directory if it doesn't exist.

### Status Lifecycle

- On first write: `Status: In Progress`
- When the user confirms the saved document is final: update to `Status: Complete`
- If the document already exists with `Status: Complete` (re-running the skill): confirm with the user before overwriting

### After Saving

Once the final document is saved, delete the working document — the final document is now the record.

Tell the user:
- Where the file was saved
- A count of what was captured (e.g., "8 functional requirements, 3 non-functional, 2 deferred items in Open Questions")
- That the working document was removed
- Suggest they review the Open Questions before handing off to technical planning
