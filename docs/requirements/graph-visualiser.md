# Graph Visualiser

> Status: requirements settled; build in progress
> Author: Ian Hogers + Maple
> Basis: `Graph.construct` (`plugins/mag/src/runtime/construct.ts`).

## Overview

A local web view of a graph: every construct as a collapsible group, every node, decision and fork drawn from the shape the graph declares, with a live run overlaid on it (which node is active and for how long, what each attempt cost, which branches were taken). It works without a run, so the network itself can be shown and explored. It replaces nothing: `mag ps` stays the terminal view and `mag topology` is untouched by this ticket set.

## Problem Statement

`mag ps` says where a run is; it cannot say where that is in the whole. Progress, what comes next, which fork branches are in flight and which conditional branches were skipped are invisible until the run ends and the journal is read back. `mag topology` draws a graph's shape from source but cannot see `Graph.construct` at all (`develop-graph` renders as a single box). Nothing lets someone who did not write a graph click through it and understand it, which is what both the marketing use (show the network) and the learning use (inspect it) need.

## Users & Actors

One actor: a developer with the plugin installed, on their own machine, in their own browser, on loopback. For the marketing use the same person drives the view; there is no remote audience and nothing automated consumes it.

## Scope

### Included

- The shape a `Graph.construct` declares, exposed at `finalise` without running the graph
- Decisions (`when`, later `loop` exits) as named shape elements that declare which context fields they read
- A run writing its declared shape at start, a run-level start and end row, and decisions journaling their outcome
- A static view of any registered graph, and a live view of any run on this machine
- Node click panel: description, attempts with cost per attempt, decision outcomes, transcript paths
- Home page: registered graphs, runs on this machine
- `mag view` command, foreground, opens the browser
- The "Arcade Terminal" visual language, as vendored design tokens (`--mk-*` custom properties)
- `.loop` in `Graph.construct`, and `build-under-review` rewritten as a construct

### Excluded (this time)

- Rewriting graphs other than `develop-graph` and `build-under-review` as constructs; the others (`design-graph`, `conflict-graph`, `envision`, `branch-name`, `review-pattern-graph`) draw as opaque boxes (FR-9)
- Project tracking, suggestions, directory picker
- Rendered transcript view: the panel shows the transcript path only
- PR action items and the action rail
- Resume or any run control: the viewer is read-only
- Freshness controls in the UI: the poll interval is fixed
- Decisions made by the probe-based `when` in `plugins/mag/src/runtime/when.ts`: those are nodes and draw as nodes
- An "awaiting human" state: runs go fully autonomously and fails instead
- Windows, auth, remote access

## Functional Requirements

### FR-1: A finalised graph exposes its declared shape

Calling `finalise` on a `Graph.construct` produces, alongside the runnable graph, the shape it declared. The shape is a plain serialisable value, neutral of any UI library, made of these element kinds: **group** (a construct; borrowed constructs nest to any depth), **node**, **decision**, **fork** (with its branches), **loop** (with its body and exit decision); and these edge kinds: **sequence** (stage to next stage), **branch** (decision or fork to the stages it leads to), **data** (the producer of a context field to the decision that reads it). The shape carries no positions. It is obtainable without running the graph.

**Acceptance Criteria:**
- The shape of `develop-graph` lists every stage of every construct it borrows, with no node run
- A `.fork` appears as one fork element with two branch edges; a `.when` appears as a decision with a branch edge to the node it guards
- A borrowed construct appears as a group nested inside the borrowing construct's group
- The shape decodes from JSON and carries a schema version field and no positions

### FR-2: Decisions are named shape elements

A `.when` (and a `.loop` exit, FR-12) is declared with a name, an explicit list of the context fields it reads, and its test. The list is declared, not derived from the test, and not checked against it. Each field's producer is known by construction: a stage with `keep` contributes the fields `keep` declares; a `.then` or `.borrow` without `keep` contributes every field of its success, producer that stage; a `.via` helper contributes its fields under the helper's name; a field seeded by `finalise`'s `seed` has the graph's input as producer, drawn as the graph's entry.

**Acceptance Criteria:**
- A `.when` without a name or without a field list does not typecheck
- A decision declaring a field a stage produced shows one data edge per declared field, from that stage
- A decision reading a seeded field shows a data edge from the graph's entry

Decision names are what a future borrow/modify lifecycle change (not in this set) will target with `removeWhen`.

### FR-3: A run records its shape, its bounds, and its decisions

At start, a run writes its declared shape to `shape.json` in its run directory, next to `journal.jsonl`. The run writes a run-level `start` row before its first node and a run-level `end` row (outcome `ok`, `fail`, `die` or `interrupt`) after its last, so a run's state can be read without inferring it from node rows. Each decision writes a journal row with its outcome (taken or not taken) when it resolves. These are new row kinds and bump the journal schema; journals of the previous schema are dropped by the existing precedent (`runtime/journal/row.ts`: readers accept the current `schema` literal and nothing else, so a journal written under any other version is unreadable rather than half-understood) and do not appear in the viewer. A resumed run writes its own `shape.json`; replayed nodes are placed on that shape.

**Acceptance Criteria:**
- After a run starts, its run directory holds `shape.json`, decoding to the same shape FR-1 exposes for that graph at the run's `pipelineSha`
- A run's journal begins with a run-level start row and, when it finishes for any reason the journal's exit finalizer sees, ends with a run-level end row carrying the outcome
- A resolved `.when` has a journal row naming the decision and its outcome
- Nothing in the runtime reads `shape.json` back; it is a projection, never an input

### FR-4: Static mag view

From the home page the user opens any registered graph and sees its full declared shape: every group, node, decision and branch, with nothing run. Clicking a node opens its panel (FR-6) with name and description; clicking a decision shows the fields it reads and their producers.

**Acceptance Criteria:**
- Every graph the registry lists as runnable is listed and opens; a graph that is not a construct opens as one opaque box (FR-9); composite nodes appear only as groups inside a graph, never as top-level entries
- A construct graph draws with every branch of every decision visible
- Opening the static view triggers no run and writes no file

### FR-5: Live mag view

Opening a run shows its recorded shape with the journal overlaid. Each node shows one of: **not reached**, **running** (highlighted, elapsed timer ticking, attempt badge when the attempt is 2 or more), **succeeded** (done mark, duration), **failed** (error tag shown on the node), **replayed** (done mark plus a replayed marker). When attempts disagree, the latest attempt's outcome is the node's state. Under a fork, both branches draw side by side with their own timers. A decision that resolved "not taken" collapses its untaken branch into the decision boundary, which stays visible with its outcome; an unresolved decision shows both branches. The view refreshes from disk once per second.

**Acceptance Criteria:**
- A node with an unmatched `start` row is shown running, its timer counting from that row's timestamp, and it stops when the `end` row lands
- A node whose attempt 1 failed and attempt 2 succeeded shows succeeded, with both attempts in its panel
- Two nodes under a fork both show running at the same time
- A decision journaled "not taken" hides the node it guarded and shows its outcome on the decision element
- A `replayed: true` end row marks the node replayed; its panel reads "replayed from run <id>" with the cost that run paid
- A new journal row is reflected within the next refresh tick

### FR-6: Node panel

Clicking a node or decision opens a panel. For a node: name, description; each attempt with start, end, duration, outcome and error tag, and that attempt's own cost; the session transcript paths from the attempt's success; the input and success payloads, collapsed by default. For a decision: the fields it reads, the stages that produced them, and its outcome this run. A group's cost is its own end row's cost; its children are shown as a breakdown and never added on top. A null or absent cost displays as "unpriced"; totals are floors, as in `mag ps`.

**Acceptance Criteria:**
- A node that ran three times shows three attempt rows, each with its own cost, never one summed figure
- A replayed attempt reads "replayed from run <id>" with that run's cost
- A node without a `costUsd` field reads "unpriced"
- Each transcript path is shown as a path; the viewer does not render the transcript
- Payloads are hidden until expanded

### FR-7: Home

`mag view` opens on a home page with two sections. **Graphs**: every registered graph, click to open its static view. **Runs**: one row per run on this machine with project, ticket, graph, state (Running, Stalled, Failed, Interrupted, Complete), current node and time in node (blank once the run has ended), run elapsed, cost and a stale marker. Live runs list first; every other run sits behind one "show finished" toggle. Clicking a run opens its live view.

**Acceptance Criteria:**
- The live rows agree with `mag ps --once` for the same moment
- Finished runs (Failed, Interrupted, Complete) are hidden until the toggle is on; Stalled runs are shown as live with the marker, matching `ps --stale`
- A run row opens that run's live view

### FR-8: Collapsible groups

Each construct is a group. Groups start collapsed; in the live view the group containing the active node starts expanded, and its ancestors with it. A collapsed group shows its name and, in the live view, its aggregate state: running if any child is running, else failed if any child failed, else succeeded if all reached children succeeded, else not reached.

**Acceptance Criteria:**
- Opening `develop-graph` static shows its top-level groups, collapsed
- Opening a live run whose active node is inside a borrowed group shows that group, and every group above it, expanded
- Nesting three deep (`develop-graph` > `publish-tail` > `write-body`) renders correctly; deeper nesting is best effort
- Expanding and collapsing a group never changes the run's data

### FR-9: Opaque graphs and composites

A graph or composite node that is not a construct has no declared inner shape. It draws as one box marked opaque. In the live view its inner nodes, known only from the journal, render as an unplaced list beside the box, in journal order. Which graphs are constructs is a property of the checkout, not the viewer; an opaque box is tracked as codebase debt.

**Acceptance Criteria:**
- Before its rewrite (FR-12), `build-under-review` draws as one opaque box and its inner `build`, `review-diff`, `verification`, `simplify` rows appear unplaced beside it
- `design-graph`, borrowed by `develop-graph`, draws as one opaque group with its journal nodes unplaced inside it
- After FR-12, the only opaque boxes in `develop-graph` are borrowed non-construct graphs

### FR-10: `mag view` command

`mag view` takes no arguments except `--port`, starts the viewer in the foreground (like `mag ps`), binds to loopback on a fixed default port, opens the browser at the home page and prints the URL. Ctrl-C stops the server; the browser it opened is not the viewer's to close. If the port is taken, by a second `mag view` or anything else, the command errors and exits; it never picks another port.

**Acceptance Criteria:**
- `mag view` prints a loopback URL and exits on Ctrl-C with no server process left behind
- When no browser can be opened, the URL is printed and the server keeps serving
- The server is unreachable from any non-loopback interface
- A second `mag view` on the same port exits with an error naming the port

### FR-11: Visual language

The viewer uses the vendored "Arcade Terminal" design tokens: obsidian surfaces, purple accent, amber alt accent, Space Grotesk display over JetBrains Mono, sharp corners, border-based elevation, `--mk-*` custom properties with `-fg` foreground pairs. The tokens file is vendored into the viewer in the first commit that styles it; a maintainer-only re-vendor command overwrites it from a local checkout whose path it takes as an argument. Node states map to the feedback family: success, error, warning (stale), info (replayed), the green marker for alive.

**Acceptance Criteria:**
- A grep over the viewer's components finds no hex colour and no font family; every value resolves from a `--mk-*` token
- The vendored tokens file is present in the repository and the re-vendor command overwrites it from the given checkout path

### FR-12: Loops in constructs

`Graph.construct` gains `.loop`, and `build-under-review` is rewritten as a construct that uses it, so its review cycle appears in the shape as a loop with a named exit decision. Attempts are counted as the journal counts them (per node per run); a loop re-entry is a new attempt. The rewrite changes no behaviour: same nodes, same order, same cap, same errors; its existing tests pass unchanged.

**Acceptance Criteria:**
- `build-under-review`'s shape shows `build`, `review-diff`, `verification`, `simplify` inside a loop with an exit decision named for what ends it
- Its journal rows place onto that shape in the live view

## Edge Cases & Error States

Governing rule: degrade per file, never abort a view because one source is broken.

| # | Condition | Response |
|---|---|---|
| 1 | Journal names a node the shape lacks | Node rendered unplaced, marked "not in shape"; nothing errors |
| 2 | Shape names a node the journal never reaches | Stays not reached; on a Complete run it is marked not reached |
| 3 | Torn or malformed journal line, or a decision whose producer's row is missing | Skipped this tick, retried next; raw line visible in the panel; a data edge with no producer row is marked "producer unknown" |
| 4 | Fork with one side finished, the other running | Run is Running; the done side shows its duration, the other keeps ticking |
| 5 | No journal write for 45 minutes while the run is open | Run is Stalled: banner on the view, marker on the home row; an open node's timer turns the warning colour and keeps counting |
| 6 | Run-level end row with outcome `fail` or `die` | Run is Failed; the failing node shows the error tag |
| 7 | Run-level end row with outcome `interrupt` (Ctrl-C, supervisor kill; written by the journal's exit finalizer) | Run is Interrupted |
| 8 | Run-level start row, no run-level end row, silent past the stale threshold | Stalled, for as long as the journal stays silent; death is never inferred (a hard kill leaves nothing) |
| 9 | Run open, no node open (between stages) | Running |
| 10 | Two live runs for the same ticket, or a run and its resumption | Both listed on home, each with its own view and its own shape |
| 11 | A registered graph fails to load its shape | Listed with an error state; other graphs unaffected |
| 12 | Journal unreadable (permissions) | That run degrades; home still lists every other run |
| 13 | Journal of a schema older than FR-3's | Not listed; the existing drop-old-schema precedent applies |
| 14 | Browser cannot be opened (SSH, headless) | URL printed; server keeps running |

Run states: Running, Stalled, Failed, Interrupted, Complete. Node states: not reached, running, succeeded, failed, replayed.

## Non-Functional Requirements

### NFR-1: Freshness
One poll per second, reading only what changed (tail from the last offset; an unchanged journal is never re-read), one render per tick.

### NFR-2: Security posture
Binds to `127.0.0.1` only. With no state-changing endpoint, the loopback bind is the whole boundary.

### NFR-3: Read-only
The viewer never writes to run directories, journals or repositories. `shape.json` and the new journal rows are written by the run, not by the viewer.

### NFR-4: Platforms and runtime
Bun on macOS or Linux. Windows fails with a clear message. Current Chrome, Firefox, Safari.

### NFR-5: One process, no database
A single foreground process. Nothing persisted by the viewer.

### NFR-6: Where it lives
A SvelteKit project at `plugins/mag/projects/graph-viewer`, launched by `mag view`, covered by the repository's declared suite (`bun run typecheck && bun run test` from the root). Its server side imports one shared reader from `mag/runtime` for journal decode and run summary, the same reader `mag ps` uses; there is never a second reader. The UI is a function of one state value (shape plus journal rows); no view state that is not derived from it. The viewer maps FR-1's neutral shape to its rendering library's model; the runtime knows nothing of that library.

### NFR-7: Shape file contract
`shape.json` is a versioned, small, read-only projection. It is never an input to running anything. Its schema is kept deliberately small because it will grow dependents.

### NFR-8: Footprint and retention
The viewer lists what is on disk and deletes nothing. Retention is the filesystem's problem.

## User Flows

**Show the network (marketing, learning):** `mag view` → home → click `develop-graph` under Graphs → top-level groups, collapsed → expand `build-under-review` → its loop and exit decision → click the decision → fields read and their producers.

**Watch a live run:** `mag view` → home → Runs shows the run with its current node and cost → click the row → the recorded shape, active group expanded, running node ticking → click the running node → attempts so far, cost per attempt, transcript paths.

**Read back a finished run:** home → show finished → click the run → untaken branches collapsed into their decisions, every node with duration and cost → click any node for its attempts.

## Priority

| ID | Requirement | Priority |
|---|---|---|
| FR-1 | Shape exposed at finalise | Must |
| FR-2 | Named decisions with declared fields | Must |
| FR-4 | Static mag view | Must |
| FR-9 | Opaque graphs and composites | Must |
| FR-8 | Collapsible groups | Must |
| FR-10 | `mag view` command | Must |
| FR-3 | Run records shape, bounds, decisions | Must |
| FR-5 | Live mag view | Must |
| FR-7 | Home | Must |
| FR-6 | Node panel | Must |
| FR-11 | Visual language | Should |
| FR-12 | Loops in constructs, `build-under-review` rewrite | Should |
| — | Rendered transcript view | Won't (this time) |
| — | PR items and rail; resume; project tracking | Won't (this time) |
| — | Freshness controls in the UI | Won't |
| — | Rewriting the other graphs as constructs | Won't (this time) |

Build order is the table's order: static first, live second. Cut line if forced, first to go: FR-12 → FR-11 → FR-6's payload display (attempts and cost stay).

## Assumptions

- Journals are append-only; concurrent reads are safe, worst case a torn tail line
- One user, one machine, one viewer at a time (a second instance fails on the port)
- The registry can list graphs and load a graph module without running it
- A graph's shape is fixed at `finalise`: any future borrow/modify lifecycle modifiers apply before finalise, never during a run
- The stale threshold is `mag ps`'s 45 minutes

## Dependencies

Runtime work, all inside this ticket set:

1. `Graph.construct` records its shape and exposes it at `finalise` (FR-1)
2. `.when` takes a named decision with declared fields; producers known per stage kind (FR-2)
3. The run writes `shape.json` at start, run-level start and end rows, and decision outcome rows; journal schema bump (FR-3)
4. `.loop` in `Graph.construct`; `build-under-review` as a construct (FR-12)

Viewer dependencies:

- `@xyflow/svelte` (Svelte Flow) for rendering: groups via `parentId`, custom node components
- A layout library for positions, computed client-side (elkjs or dagre; the writing-plans step picks after a spike on nested groups with forks)
- Vendored `tokens.css`: the `--mk-*` design tokens

## Open Questions

- Layout library choice (elkjs or dagre) behind Svelte Flow: the writing-plans step decides after a spike on nested groups with forks
- Whether an opaque composite's unplaced nodes should also draw their journal-order edges, or only list: decide when the first live run with FR-9 in effect is watched
