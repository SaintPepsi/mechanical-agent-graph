---
name: writing-plans
description: Write a bite-sized implementation plan from a spec, requirements, or an approved design doc, resolved against the engineering principles. USE WHEN you have a spec or requirements for a multi-step task, before touching code.
---

# Writing Plans

## Overview

Write comprehensive implementation plans assuming the engineer has zero context for our codebase and questionable taste. Document everything they need to know: which files to touch for each task, code, testing, docs they might need to check, how to test it. Give them the whole plan as bite-sized tasks. DRY. YAGNI. TDD. Frequent commits.

Assume they are a skilled developer, but know almost nothing about our toolset or problem domain. Assume they don't know good test design very well.

**Context:** This should be run in the dedicated worktree the caller prepared.

**Save plans to:** the destination the caller specifies, or a dated `YYYY-MM-DD-<feature-name>.md` file if none is given.

## Engineering Principles Compliance

Before drafting tasks, read the sibling `../brainstorming/principles/index.md` once — it carries every principle's Goal and Rule, which is all a plan needs (open a leaf file under `../brainstorming/principles/` only if unsure how a rule applies). The principles shape the plan in concrete ways:

- Calculation logic extracted as pure functions (testable per task)
- Types live in central `types/` (the path appears in task headers)
- Files approaching ~300 lines split into folders (the split is its own task)
- New behavior added via data/config, not new conditional branches

If a design doc exists with a "Principles applied" section, preserve those decisions in task-level paths and code structure.

## Conditions Come From the Design, Not the Data Shape

When a task needs to detect a condition the design describes, the task names the **authoritative signal** that carries that meaning — the flag or field the design designates for it. It never infers the condition from how the data happens to be shaped: whether some field is present, how many items a list holds, what a type narrows to. Shape is an implementation detail owned by other tasks; the moment any of them changes it, an inferred condition silently changes meaning while the plan still reads as correct (Single Source of Truth, `../brainstorming/principles/core/single-source-of-truth.md` — a condition's meaning has one home). If the design names no such signal, adding one is its own task in this plan: that is part of translating the design into work, not an implementation nicety.

## Cross-Task Consistency Pass (before saving)

Tasks are drafted one at a time against the design; contradictions live *between* them. Before saving the plan, sweep it once: list every condition a task detects, and every change any task makes to shared data — what exists, what is required, how many there can be. A detected condition whose inputs another task changes is a plan bug — resolve it (usually via the rule above) before the plan is final.

## Shell Resolution (required when the design has an Envisioned Shell)

The design doc's **Envisioned Shell** is the structural contract: the design named *what exists*; this plan has **final say on where it lives**. Before cutting tasks, produce a **Resolution Table** covering EVERY symbol the shell references — component tags AND the factories/helpers in its script sketch:

```markdown
| Symbol | Resolution | Where | Budget |
| --- | --- | --- | --- |
| `RoomTile` | create | `src/lib/components/RoomTile.svelte` | ≤80 lines |
| `sortRoomsByAge` | create | `src/lib/overview-logic.ts` (+ test) | ≤40 lines |
| `StatusPill` | reuse | `src/lib/components/StatusPill.svelte` | — |
| `createPartyClient` | extract | from `src/routes/+page.svelte:40-102` → `src/lib/party-client.svelte.ts` | ≤120 lines |
```

The four resolutions:

- **reuse** — exists as-is. Check the discovery note's reuse map and the repo's shared modules first; rebuilding something the codebase already has is a process failure.
- **repurpose** — exists but needs a prop/variant/field; the modification is its own task.
- **create** — new file: exact path, one-line responsibility, line budget.
- **extract** — the logic already exists **inline** somewhere else; build the shared home as new code consumed by this feature, then add a **replace task** per existing inline site migrating it to the shared home. New stuff first, then replace the hardcoded stuff with the new stuff — **no stragglers**: if the new feature needed this abstraction, every existing hardcoded site of the same logic consumes it *in this same plan*. An existing site that needs **more** than the new feature does (extra interactivity, extra fields) is not a reason to leave it hardcoded — it is a reason to parameterize or decompose the shared home so it covers both (the prop-gated pattern: the capability is a prop/wrapper, the shared core is one; cf. Same Concept, Same Rendering). The only valid way to leave a site out is a quoted "When This Doesn't Apply" bullet from a principle leaf (genuine false sharing) — "out of scope" and "minimal blast radius" are not escape hatches, they are the straggler being born. Copying inline logic into a second file is never a valid resolution under the same rule.

Then plan **shell-first build order**: the first implementation task materializes the shell (real route file + stubs for every created component), and each created/extracted symbol gets its own task. No task is ever "build the page". The route shell stays composition-only and under ~100 lines (principle: Routes Compose, Components Render, `../brainstorming/principles/frontend/routes-compose.md`); every design seam maps to ≥1 row in this table, and review gates check the final diff against it.

## Bite-Sized Task Granularity

**Each step is one action (2-5 minutes):**

- "Write the failing test" - step
- "Run it to make sure it fails" - step
- "Implement the minimal code to make the test pass" - step
- "Run the tests and make sure they pass" - step
- "Commit" - step

## Plan Document Header

**Every plan MUST start with this header:**

```markdown
# [Feature Name] Implementation Plan

> **For Claude:** execution is owned by the caller that requested this plan.

**Goal:** [One sentence describing what this builds]

**Architecture:** [2-3 sentences about approach]

**Tech Stack:** [Key technologies/libraries]

---
```

## Task Structure

````markdown
### Task N: [Component Name]

**Files:**

- Create: `exact/path/to/file.py`
- Modify: `exact/path/to/existing.py:123-145`
- Test: `tests/exact/path/to/test.py`

**Step 1: Write the failing test**

```python
def test_specific_behavior():
    result = function(input)
    assert result == expected
```

**Step 2: Run test to verify it fails**

Run: `pytest tests/path/test.py::test_name -v`
Expected: FAIL with "function not defined"

**Step 3: Write minimal implementation**

```python
def function(input):
    return expected
```

**Step 4: Run test to verify it passes**

Run: `pytest tests/path/test.py::test_name -v`
Expected: PASS

**Step 5: Commit**

```bash
git add tests/path/test.py src/path/file.py
git commit -m "feat: add specific feature"
```
````

## Terminal State

The saved plan is this skill's terminal artifact. Report the plan path and a one-line summary per task, then return — execution is the caller's to run.
