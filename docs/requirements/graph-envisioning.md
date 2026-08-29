# Graph Envisioning & Design Prompt Composition
> Status: requirements settled; build in progress
> Author: Ian + Maple

## Overview

Two co-developed capabilities: a way to construct graphs by envisioning them first (raw diagram → rail-sketch → code), and the design lane rebuilt as a composition of distinct concern modules with stack-specific envisioning selected by mechanical probes. The design spine is **Envision ∥ Discover → Brainstorm → Plan**: envision answers "what does the ideal shape of the built thing look like", discover answers "what currently exists in the repo we are going to be meddling with" — two independent questions, answerable side by side; brainstorm consumes both, plan sequences. The envisioning capability is its own first customer: it envisions the new design graph and develop-graph, which are then built from those visions.

## Problem Statement

Design output is inconsistent and surprising, so PR review costs Ian heavy reading and back-and-forth; a bad design costs re-review rounds or not understanding what was made. Graph structure is implicit: nodes get strung together in hand-wired pipelines, steps hide as runtime utilities (it has happened more than once in a GraphNode-first repo), and run-conditions live in nobody's declaration. The design prompt is one compiled wall of text that cannot be scrutinised concern by concern, carries interactive-era dead weight into headless dispatches, and instructs every target — backend included — in Svelte.

**Success is Ian's judgment**: the system converges on the vision in his head — smoother implementation, fewer round trips, PRs he understands on first read. No proxy metric substitutes for that call.

## Users & Actors

- **The develop-graph run** — the direct consumer: its design lane assembles and dispatches the composed prompt; its build lane consumes visions.
- **Ian** — reviews the PRs the runs produce and judges success; his reading time and round-trip count are the cost being minimized.
- **Maple / agent sessions** — author visions, borrow subgraphs, and construct new graphs with the tooling.
- **The effect-expert agent** — writes rail-sketches and builds graphs from visions; trusted to choose Effect idiom, never to change what a vision says the graph does.

## Scope

### Included
- Full split of the design prompt into one-file-per-concern modules; the three interactive-era sections removed from headless variants.
- Three probe/envisioning pairs (svelte, effect, graph-core) plus a generic fallback; mechanical assembly.
- Conditional composition (`when`-style) and graph=node subgraph composition.
- The envision graph (envision-mermaid → envision-rail-sketch), standalone-runnable; discover as its own independent recon step, runnable side by side with it.
- A design graph and a develop graph, both envisioned from scratch; design runs as a subgraph underneath develop-graph.
- Borrow/modify lifecycle (Construct → Modify → Finalise → Execute) with typed modifiers; convolution guard as a follow-on.
- Envisioning conflict-graph and review-pattern-graph after the north-star ticket lands.

### Excluded
- Storybook detection/weaving and stacks beyond the three pairs (each later stack is one probe+module pair).
- Porting behaviour from elsewhere wholesale; each borrowed behaviour is re-justified against this design, not assumed to transfer as-is.
- Whole-run replacement by decree: a new graph earns its place one real run at a time.
- A separate regeneration task for the user-facing `/mag:brainstorming` SKILL.md: `compile-skill` already regenerates it from the same modules (`src/skills/installed.ts`), so no additional work is needed here.

## Functional Requirements

### FR-1: One concern, one module
The design prompt's every concern lives in its own file (`plugins/mag/src/skills/design/<concern>.ts`), TS data per the compiled-skill pattern; a variant is an ordered list of concern references.

**Acceptance Criteria:**
- Each core concern (explore-context, principles-stack, no-too-simple, approaches-rubric, seams-ownership, reference-sweep, product-decisions, design-doc-template, write-and-confirm, autonomy, interpretation-rulings, convention-rulings, improvements) is one file; each concern's prose is defined in exactly one module (grep-checkable).
- hard-gate, clarifying-questions, and dialogue-norms exist in no **headless** variant; they survive only as interactive-only modules for the user-facing skill.
- The 13+3 partition is asserted complete against the current compiled prompt; any remainder prose discovered during the split gets an explicit keep-or-cut decision recorded in the split's design record — never a silent drop.

### FR-2: Mechanical stack probes select envisioning
Detect-svelte, detect-effect, and detect-graph-core run as Mechanical nodes; their verdicts select which envisioning modules join the design prompt.

**Acceptance Criteria:**
- Probe definitions: detect-svelte and detect-effect match a `svelte` / `effect` entry in any manifest's dependencies or devDependencies (workspaces included); detect-graph-core matches this repository's identity. A missing manifest is a non-match; an IO error reading one is a probe failure (run dies named). Each verdict is typed data satisfying the node's success schema.
- A repo matching several probes gets every matched module; a repo matching none gets envision-generic.
- The composed prompt for a non-matching stack contains none of that stack's module text (checked by module provenance at assembly, not string search).

### FR-3: Envisioning is one discipline, notation per stack
Every envisioning module teaches the same move — draw the ideal, blind to the current mess — in its stack's notation (component markup / railway pseudo-code / mermaid). The shell is drawn blind as the design doc's own Envisioned Shell section, one shell per matched stack, and the same session then completes the design around it over discover's recon; the seams & ownership table joins the shells, and the plan's resolution table turns the design into tasks.

**Acceptance Criteria:**
- A multi-stack ticket's design carries one vision per matched notation, joined by the seams table.
- No vision references current file paths or "already exists" annotations; what-exists is discover's question, answered independently.

### FR-4: Per-notation vision artifacts, trust-failure/verify-success
Each included notation writes its own vision document. A declared failure (the agent's JSON verdict) errors that notation immediately; a declared success is verified mechanically after all routes complete.

**Acceptance Criteria:**
- Success-without-document (missing or empty-after-trim) is detected mechanically; that notation retries once, independently of siblings, then the run dies named.
- Sibling routes always run to completion and get their checks even when one notation has already failed.
- The check runs against paths the composer expected, never the model's echo of them.

### FR-5: The envision graph
A registered, standalone-runnable graph: envision-mermaid (basic model) → envision-rail-sketch (effect-expert). One job per session, enforced by separate dispatches — the mermaid session never writes rail-sketch, and vice versa.

**Acceptance Criteria:**
- `mag envision --name <name>` accepts the name of a graph that may not exist yet: a Mechanical step creates the graph's folder when absent, and both visions land in it (co-location). Re-runs overwrite; git history is the versioning.
- The raw (mermaid) vision carries: every node at full granularity — branch names, checkouts, worktrees, PRs included — with a one-line job and `type: "Mechanical" | "Model"`; edges as output→input field mappings; every conditional edge naming its probe.
- The rail-sketch carries: every node from the raw vision with a sketched typed input/success shape, its `when`-conditions, and its error channel — enough for an effect-expert to code the graph without re-deriving structure from the mermaid.

### FR-6: Discover — independent recon of what exists
Discover is its own thing, not a pass over the vision: it answers "what currently exists in the repo we're going to be meddling with", driven by the ticket, and can run side by side with envisioning. A model session does the recon and writes a per-ticket `docs/graph/<TICKET>/discover.md` — cited findings, with "genuinely new" claims carrying the empty searches that back them — which brainstorm consumes together with the visions. No repo-wide registry or inventory cache, ever: the map is computed fresh per ticket.

**Acceptance Criteria:**
- Discover is `type: Model`: one read-only recon session writes `docs/graph/<TICKET>/discover.md`, and the node mechanically verifies the file exists.
- Discover consumes the ticket, never the vision; envision and discover can run in parallel with no dependency between them.
- Brainstorm consumes the discover note together with the visions and reconciles them: where a vision element collides with something discover found under a similar name but a different shape, the design records the resolution before build begins — nothing is silently renamed or reused.
- No repo-wide registry, inventory, or generated index file is written or read — per ticket, fresh, by search.
- Discover keeps its recon identity and runs beside envisioning, not after it.

### FR-7: Graph = GraphNode
A graph satisfies the GraphNode contract (typed input/success), so subgraphs compose as single nodes.

**Acceptance Criteria:**
- The design graph replaces the design step of develop-graph as one node.
- A test composes a subgraph into a host graph without editing any file inside the subgraph.

### FR-8: Conditional composition
Graphs declare run-conditions in typed Effect composition (`when(detectSvelte, envisionSvelte)`-style): the declaration is the execution — no YAML, no declaration files, no separate engine interpreting them.

**Acceptance Criteria:**
- A test asserts a conditional node leaves no journal row when its probe says no.
- Railway readability is reviewed at the graph's PR against its co-located vision (the optional Code→Vision review model can later mechanize this; not required here).

### FR-9: Borrow/modify lifecycle
A borrowed subgraph accepts declared modifiers at the borrowing site: Construct → Modify → Finalise → Execute. This iteration's modifier set: `removeWhen` and `replaceNode`. Invalid modifiers surface as TypeScript errors where Effect's types can carry it; Finalise hard-errors for what they cannot.

**Acceptance Criteria:**
- A modifier targeting a nonexistent condition or node fails at compile time, or at Finalise with a named error — never silently no-ops.

### FR-10: New graphs from their own visions
The design graph and develop-graph are envisioned from scratch through the envision graph, then built from those visions by an effect-expert; friction encountered feeds back into the tooling and standards.

**Acceptance Criteria:**
- Both graphs' folders contain their mermaid vision and rail-sketch before their build begins; discover has run for each ticket.
- **North star:** develop-graph runs a ticket that has ACs, from a real tracker, to a PR opened with the declared verification green — with the design subgraph underneath. Merging stays Ian's.
- The installed brainstorming SKILL.md is already regenerated from the same modules by the `compile-skill` node (`src/skills/installed.ts`), never edited by hand.

### FR-11: The graph-core envisioning carries the boundary rule
The envision-graph-core module (selected when the target is this repo) instructs: GraphNode = a step in the run's data flow, any size; `runtime/` = shared machinery only. Designs name every node, its run-condition, and justify every runtime addition against the rule.

**Acceptance Criteria:**
- The module's text requires a boundary justification for every `runtime/` addition, giving reviewers a citable rule.
- The rule's module joins no other stack's composed prompt (same provenance check as FR-2).

### FR-12: Convolution guard (follow-on to FR-9)
Past 3 modifier applications at one borrowing site — counted per application, accumulating through nested borrows — the graph refuses to build: "envision a new graph instead."

**Acceptance Criteria:**
- A fourth application at one site fails Finalise with the guard's message.

## Non-Functional Requirements

### NFR-1: Composed prompt size budget
Assembly enforces a size bound on the composed design prompt (the all-probes-match case is the worst case). Exceeding it dies named at assembly — the prompt is never truncated or silently split (doctrine: an oversized prompt dies at execve).

## Edge Cases & Error States

| Condition | Response |
|---|---|
| No probe matches | envision-generic; not an error |
| Several probes match | all matched modules included; seams table joins |
| A probe itself fails (IO error; distinct from a clean non-match) | hard error, run dies named — never degrade to generic |
| Notation declares failure | error that notation immediately (trust declared failure) |
| Notation declares success, no/empty document | retry once after all routes complete; then run dies named (verify declared success) |
| Discover finds a similar name with a different shape | named conflict; design records the resolution before build |
| Modifier targets nothing | TypeScript error preferred; Finalise hard error fallback |
| >3 modifier applications at one borrowing site | convolution guard: "envision a new graph instead" (FR-12) |
| Re-run of `mag envision` over existing visions | overwrite; git history versions |
| compile-skill regen drift-gate mismatch | suite fails; re-pin is an explicit commit |

## User Flows

1. **Envision a graph (existing or new):** `mag envision --name <name>` → folder created if absent → mermaid vision (ideal, full granularity) → rail-sketch (effect-expert) → discover recons the names → effect-expert builds/rebuilds from the artifacts.
2. **Design lane in develop-graph:** probes run parallel → assemble composes core + matched envisioning modules (size-checked) → one design session writes the design doc + per-notation visions → mechanical per-notation checks; discover runs alongside → brainstorm reconciles visions with discover's recon → plan sequences → build consumes.
3. **Borrow a subgraph:** compose the design graph into a new graph as one node → optionally attach modifiers (`removeWhen` / `replaceNode`) → Finalise typechecks → Execute.

## Priority

| ID | Requirement | Priority |
|----|-------------|----------|
| FR-1 | Concern split | Must |
| FR-2 | Probes + assembly | Must |
| FR-7, FR-8 | Graph=node + conditional composition (land together — one machinery layer) | Must |
| FR-5 | Envision graph | Must |
| FR-6 | Discover recon | Must |
| FR-10 | Design graph + develop-graph | Must |
| FR-4 | Per-notation artifacts + checks | Must |
| FR-3 | One discipline, notation per stack | Must |
| FR-11 | Boundary rule module | Must |
| NFR-1 | Prompt size budget | Must |
| FR-9 | Borrow/modify lifecycle | Should |
| — | Envision conflict-graph + review-pattern-graph (gate: the north-star ticket has landed) | Should |
| FR-12 | Convolution guard | Could |
| — | Code→Vision review model: a session re-derives a vision from shipped graph code; divergence is a finding | Could |
| — | Storybook pair, extra stacks, wholesale behaviour porting | Won't (this time) |

North star: FR-10's ticket — develop-graph, real tracker ticket with ACs, PR open, verification green, design subgraph underneath. Build order: machinery (FR-1/2/7/8) → envision graph (FR-5) + discover (FR-6) → design graph → develop-graph (FR-10). Acceptance targets: this repo, plus one consuming repo exercising the generic/non-core path.

## Assumptions

- Effect's types can carry composition and modifiers; the effect-expert proves it and friction feeds back into the tooling.
- Stack probes are reliably mechanical per FR-2's definitions.
- Fable-class sessions handle the large build items; the cost is time, not feasibility.
- Model tiers: "basic model" = the session default; "effect-expert" = the repo's effect-expert agent definition.

## Dependencies

- **Discover** — FR-6 places it beside envisioning in the spine; its recon purpose is unchanged.
- **Plan lane** — consumes visions + discover results as its task source; its input contract is defined against FR-5's artifact specs.
- The effect-expert agent for rail-sketches and builds.
- `mag compile-skill` — regenerates the installed skill from the same modules.

## Open Questions

- (none — all interview and adversarial-review questions resolved; dismissals recorded inline: success is Ian's judgment, not a metric; the installed SKILL.md is regenerated from the same modules)
