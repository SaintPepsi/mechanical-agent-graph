# Engineering Principles — Index

> Always read this index in full. Every principle's **Rule** is binding from here alone.
> Leaf files hold the teaching material: why the rule works, good/bad code examples, and the
> full "When This Doesn't Apply" escape hatches.

## When to open a leaf file

1. **Justifying a violation** — a design may deviate from a principle only under that principle's
   "When This Doesn't Apply" reasoning. Open the leaf and **quote the applicable bullet verbatim**
   in the design doc's Deviations section. The teaser here is not quotable material.
2. **Writing the Principles-applied section** — before writing it, open the leaf of every principle
   you cite in it.
3. **Unsure how a principle applies** — the examples are the teaching material; read them rather
   than guessing.

## Standing rule

**0. Do not create deprecated functions or variables.** Replace all deprecation warnings with their
correct implementation. (No leaf file — the rule is the whole principle.)

## Core Principles

### 1. Pure Functions for Testability — [core/pure-functions.md](core/pure-functions.md)

- **Goal:** Code that can be tested in isolation without mocking the world.
- **Rule:** Extract computation into pure functions. Functions take inputs, return outputs, have no side effects.
- **Bad → Good:** 100-line store method → pure functions + thin orchestration.
- **Doesn't apply:** glue code; I/O boundaries.

### 2. Data Drives Behavior — [core/data-drives-behavior.md](core/data-drives-behavior.md)

- **Goal:** Add new behavior by adding data, not by writing new code branches.
- **Rule:** Behavior is configured via data structures, not `if` statements that check for specific types or names.
- **Bad → Good:** `if (type === 'burn')` → `effect.config.burns`.
- **Doesn't apply:** genuinely unique behavior; performance-critical paths.

### 3. Single Source of Truth — [core/single-source-of-truth.md](core/single-source-of-truth.md)

- **Goal:** Every concept has one canonical home — find it once, update it once.
- **Rule:** Types, constants, and definitions live in one place. Everything else imports from there.
- **Bad → Good:** type defined in component → central `types/` folder.
- **Doesn't apply:** derived values; types local to one file.

### 4. Separation of Concerns — [core/separation-of-concerns.md](core/separation-of-concerns.md)

- **Goal:** Each layer does one job; changes stay localized.
- **Rule:** UI renders state. Stores manage state. Pure functions compute. Don't mix responsibilities.
- **Bad → Good:** logic in component → props + events only.
- **Doesn't apply:** prototyping; tiny components.

## Derived Guidelines

### Functional Programming for Testability — [core/functional-programming.md](core/functional-programming.md)

- **Derived from:** Pure Functions for Testability.
- **Goal:** Each calculation is a pure function that can be unit tested in isolation.
- **Rule:** Extract calculation logic from stores/components into pure functions. Stores orchestrate; they don't compute.
- **Bad → Good:** logic in store → extracted pure functions.
- **Doesn't apply:** trivial operations (`x + 1`).

### Stores Orchestrate, Don't Compute — [frontend/stores-orchestrate.md](frontend/stores-orchestrate.md) `[frontend]`

- **Derived from:** Pure Functions for Testability.
- **Goal:** Stores are thin wiring layers that compose pure functions.
- **Rule:** Store methods read state, call pure functions, write state. No business logic inline.
- **Bad → Good:** store computes → store calls pure functions.
- **Doesn't apply:** glue logic (`this.count++`).

### Derived, Not Hardcoded — [core/derived-not-hardcoded.md](core/derived-not-hardcoded.md)

- **Derived from:** Data Drives Behavior.
- **Goal:** Values derive from a central source; behavior is never hardcoded for specific types.
- **Rule:** Don't write `if (type === 'burn')`. Read behavior from the type's configuration.
- **Bad → Good:** hardcoded list → config-driven.
- **Doesn't apply:** truly unique one-off cases.

### Unify Shared Interfaces — [core/unify-shared-interfaces.md](core/unify-shared-interfaces.md)

- **Derived from:** Data Drives Behavior.
- **Goal:** If two systems need the same interface, make it generic so any system can compose it.
- **Rule:** Extract shared structure into a common interface. Systems implement the interface; logic operates on the interface.
- **Bad → Good:** separate player/enemy health → unified `Entity` interface.
- **Doesn't apply:** false sharing (same fields, different concepts).

### Central Type Ownership — [core/central-type-ownership.md](core/central-type-ownership.md)

- **Derived from:** Single Source of Truth.
- **Goal:** Types are owned in one place, not scattered across UI files.
- **Rule:** Types live in `src/lib/types/` or domain folders. UI components import types, never define them.
- **Bad → Good:** type in `.svelte` file → type in `types/`.
- **Doesn't apply:** component-internal types.

### Static Class Namespacing — [core/static-class-namespacing.md](core/static-class-namespacing.md)

- **Derived from:** Single Source of Truth.
- **Goal:** Exports are namespaced for clarity; no raw function exports.
- **Rule:** Group related functions under static classes. Import reads as `Domain.action()`.
- **Bad → Good:** `export function foo()` → `export class Foo { static foo() }`.
- **Doesn't apply:** single-purpose modules; framework conventions.

### File Organization — [core/file-organization.md](core/file-organization.md)

- **Derived from:** Single Source of Truth.
- **Goal:** Large files are broken into folders with focused sub-files.
- **Rule:** Files over ~300 lines probably need splitting. One concept per file. `index.ts` re-exports the public API.
- **Bad → Good:** 800-line monolith → folder with sub-files.
- **Doesn't apply:** cohesive small files; test files.

### UI = fn(state) — [frontend/ui-fn-state.md](frontend/ui-fn-state.md) `[frontend]`

- **Derived from:** Separation of Concerns.
- **Goal:** Components are pure functions of state with no business logic.
- **Rule:** Components receive all data via props. Components emit events, never mutate state directly. Parent gates rendering — components don't check "should I render?"
- **Bad → Good:** store access in component → props + events.
- **Doesn't apply:** container components; local UI state (hover, focus, animation).

### Same Concept, Same Rendering — [frontend/same-concept-same-rendering.md](frontend/same-concept-same-rendering.md) `[frontend]`

- **Derived from:** Single Source of Truth.
- **Goal:** A concept looks the same on every surface that shows it; its appearance has one home.
- **Rule:** A concept's appearance is part of its single source of truth: what it looks like lives in exactly one component. Any surface that shows the concept composes that component. When part of the component doesn't fit the new surface, decompose it into a presentational core plus wrappers — never write a parallel renderer with a divergent look. A capability difference (interactive vs read-only, full-size vs scaled) does not make it a different concept.
- **Bad → Good:** second surface draws its own markers for an existing concept → one presentational component composed everywhere, wrappers add capability.
- **Doesn't apply:** divergence the requirements explicitly ask for; genuinely different concepts that merely share fields.

### Routes Compose, Components Render — [frontend/routes-compose.md](frontend/routes-compose.md) `[frontend]`

- **Derived from:** Separation of Concerns.
- **Goal:** Route files stay thin shells; the good structure is the first code on disk, not a later refactor.
- **Rule:** A route file (`+page.svelte`, `+layout.svelte`) is wiring and layout only: it connects stores, derives view state in one-liners, and composes named components. Every named visual region is its own component — region markup never lives inline in the route. A route shell stays composition-only and under ~100 lines.
- **Bad → Good:** 400-line `+page.svelte` with regions inline → shell composing `<NameEditor/>`, `<RoomView/>`, `<LobbyList/>`.
- **Doesn't apply:** trivial single-region routes; layout glue.

### Stable Layout / No Layout Shift — [frontend/stable-layout.md](frontend/stable-layout.md) `[frontend]`

- **Derived from:** Separation of Concerns.
- **Goal:** The UI stays visually stable. Conditional controls, toasts, badges, and async content never reflow what the user is already looking at.
- **Rule:** Transient or conditional UI must not push existing elements around. Take it out of flow (absolute/fixed overlay) or reserve its space; never let a state toggle relayout an unrelated region. A control that appears must not move the thing the user is about to click.
- **Bad → Good:** `{#if}` bar reflows content → absolute overlay / reserved space.
- **Doesn't apply:** user-initiated expansion; first render of an always-present region.

## Growth rules

- **Index tags are the taxonomy; folders are storage.** An entry's `[domain]` tag is authoritative.
  Moving a leaf between folders touches only this index's links, never the skills that consume it.
- **A domain folder exists only once it holds 3+ principles.** Until then, new principles live in
  `core/` with their domain tagged here (`backend/` arrives with its third backend-tagged
  principle, not preemptively).
- **A folder splits at ~7+ files**, along whatever seam the content actually formed (e.g.
  `frontend/` → `frontend/state/` + `frontend/layout/`) — never along a seam guessed in advance.

## Adding a principle

1. Write the leaf: `<domain>/<slug>.md` with a `# Title`, a `> **Derived From:**` link if derived,
   then verbatim `**Rule:**`, `**Why this works:**`, `## Examples`, `## When This Doesn't Apply`.
2. Add its entry here: Goal + Rule verbatim, a Bad → Good one-liner, a short Doesn't-apply teaser,
   Derived-from, and the `[domain]` tag.
3. Apply the growth rules above when picking the folder.
