# Design sketch

How the graph is built as individual Effect modules, one per GraphNode.

## Principles

Every design decision is checked against these nine.

- **Second-System Effect** — small, successful systems tend to be followed by overengineered, bloated replacements. Guard against that in every addition here.
- **Gall's Law** — a complex system that works is invariably found to have evolved from a simple system that worked.
- **YAGNI** — don't add functionality until it is necessary.
- **Goodhart's Law** — when a measure becomes a target, it ceases to be a good measure. The journal's cost numbers and the north-star metric are diagnostics for humans, never targets for GraphNodes; the moment a brief is tuned to make the numbers pretty, the numbers lie.
- **Hyrum's Law** — with enough users, all observable behaviors of your system will be depended on by somebody. The schema-only contract is the defense: anything else observable (artifact layout, journal row shape) will grow dependents, so keep the observable surface deliberately small.
- **Lehman's Laws** — software that reflects the real world must evolve, and that evolution has predictable limits. The graph mirrors real dev work, so it will never be finished; keep change cheap at the designed seams (registry, graphs-as-files, error tags) instead of aiming for a final design.
- **Amdahl's Law** — the speedup from parallelization is limited by the fraction of work that cannot be parallelized.
- **The Map Is Not the Territory** — our representations of reality are not the same as reality itself. Journals, schemas, and verdicts are maps; the repo is the territory. A green journal row is not a green build — trust exit codes and the working tree over recorded state.
- **Inversion** — solving a problem by considering the opposite outcome and working backward from it. Design a GraphNode from its outcomes first — success schema and error codes — then work backward to what it needs; design a graph from the artifact the run must end with.

## Layout

```
plugins/mag/src/
  runtime/
    graph-node.definition.ts  # the shape
    shell.ts                  # Shell service — real subprocess, real exit codes
    journal/                  # the journaled wrapper + row shape
    run-root.ts               # the artifact-root path composers
  graph-nodes/
    branch/    discover/    brainstorm/    build/    simplify/
    review-diff/    verification/    fetch-ticket/    push-branch/    create-pr/    worktree-add/
      graph-node.ts           # schemas + run
      errors.ts               # tagged error classes
      examples.ts             # fixture data: conformance regression + worked documentation
      graph-node.test.ts
  registry.ts                 # Record<name, GraphNode>, built from graph-nodes/*/graph-node.ts
  graphs/
    develop-graph/    conflict-graph/
      graph.ts                # each a per-ticket selection over the registry
```

## The registry is the unit, not the graph

Graphs vary per ticket — one may be 6 GraphNodes, another 14. GraphNodes are addressed **by name** in the
registry; a graph is just a selection over it. Two rules make that hold:

- **A GraphNode's input schema is its whole contract.** It demands artifact paths and never references
  "the previous GraphNode" — any graph that satisfies the schema may run it, in any position.
- **Journal entries key by GraphNode name + attempt** (review GraphNodes loop), never by position.

The runner, conformance suite, and authoring skill all iterate the registry and never see a
graph. Typed composition still imports concrete GraphNodes directly; only tooling goes through the
registry.

## Decisions

1. **No `script`/`agent` kinds — every GraphNode is just a function.** What a GraphNode needs is its R
   channel: `verification` requires `Shell`, `build` requires `ClaudeAgent`. The payoff is testing:
   swap `ClaudeAgentLive` for a stub layer and the whole graph is unit-testable without
   spawning `claude -p`.

2. **Retry and escalation between two GraphNodes live inside one composite GraphNode**, not as
   routing in the graph file: `build-under-review` holds the build → verification → simplify →
   review-diff cycle, capped. Blocked findings are the reviewer's tagged error payload, fed back as
   the producer's input. The backward edge is written once, inside the composite, so every graph
   that composes it reads as a straight line.

3. **Escalation is an uncaught tagged error** reaching the runtime's single `catchAll`, which
   writes the run record and maps tag → exit code, one exit code per error class.

4. **Resume = a `journaled(graphNode)` wrapper**: check the run record for a recorded success and
   return it instead of running. ~20 lines, one place.

5. **Requirements as Layers** gives just-in-time GraphNodes for free: a stack probe such as
   `detect-svelte` runs once, memoized; GraphNodes requiring its stack never build when it fails.

6. **Transport errors cross one boundary, typed.** `ClaudeAgentLive` emits a small closed union
   (`IdleTimeout | StartupSilence | NullVerdict | UsageLimit`); one runtime policy wrapper (the
   `journaled` chokepoint) handles it for every GraphNode — retry/resume once, then escalate. Graphs
   route on domain errors only and never see the transport. Per-GraphNode timeout bounds are a GraphNode
   option; process-group reaping lives in the layer's finalizer, encoded once.

7. **Where a run executes is a requested mode, not an emergent side effect.** A worktree-resolution step
   that only ever offers "adopt a worktree whose branch carries the ticket id, else create one" makes
   running in the live checkout reachable only by hand-seeding that state first. Execution location
   should be a mode a graph requests explicitly.

## Graphs

A graph is a file, not a config: `graphs/develop-graph/graph.ts`, `graphs/design-graph/graph.ts`,
`graphs/envision/graph.ts` — each a program composing GraphNodes. A new graph
costs one small file, so there is no parameterized mega-graph with heavy/light flags. Graphs
as data (a table, YAML) need an engine to interpret them: every new shape then needs an engine
feature, not just a new file.

- **Follow-up lives in the graph, never in the GraphNode.** A GraphNode emits success or tagged errors;
  the edge is the caller's. develop-graph: `review-diff` blocked → back to `build`, inside the
  `build-under-review` composite. conflict-graph is a straight line of its own — `resolve-base` →
  `detect-conflicts` → `worktree-add` → `branch` → `resolve-conflicts` → `push-branch` (only when
  the conflicts resolved) → `worktree-remove`.
- **Split a GraphNode only on a contract split, never a routing split.** Same GraphNode, different
  follow-ups → routing, already free. Different halves of the work wanted (different input/output
  schemas between the two uses) → two GraphNodes.
- **A shared run of GraphNodes is itself a GraphNode**: `design-graph` composes envision ∥ discover
  → brainstorm and any graph may borrow it. GraphNode → graph → host graph — same shape at every
  level.

## Debugging a GraphNode

- **Nodes are subcommands, no per-GraphNode harness**: `bun run mag <node> --<flag> …` — looks
  the GraphNode up in the registry, decodes its flags against the input schema (garbage fails at the door as a ParseError), provides the live layers, prints the success value or tagged error. `bun run mag --help` lists them.
- **Layer swaps are the debug dials**: `graph-node.test.ts` per GraphNode dir swaps in a stub `ClaudeAgent` layer that feeds back a recorded transcript, under plain `bun test` — no `claude -p` spawned.
- **Tracing for free**: wrap each GraphNode in `Effect.withSpan(name)` for per-GraphNode timing and structured logs.

## Tracking (runtime, cost, session ids, artifacts)

All graph data lives in a machine-central root, since the plugin runs against many consuming repos and cost/usage questions are cross-project. Segmented project-key → ticket → run (ticket ids collide across repos, so the project segment is required) — see [Addendum: the artifact root](#addendum-the-artifact-root) for the exact layout.

GraphNode **outputs** (design docs, plans, tickets) land where repo policy puts them. The graph root holds the data _about_ the run, not the work the run produced: whatever a GraphNode makes is tracked at the one place it lives, so each fact has a single source of truth. Because the graph data is detached from the checkout, every journal row carries `repoRoot` and the git SHA the GraphNode ran against.

One JSONL journal per run, two entries per GraphNode attempt: a `start` written before the work
begins and an `end` written on whichever of `ok`, `fail`, `die` or `interrupt` it reaches. A start
with no matching end is then a precise statement — that node was running when the run stopped
recording — which a single row carrying both timestamps could never make.

```json
{
  "schema": "graph/journal@3",
  "event": "start",
  "timestamp": "...",
  "runId": "...", "ticket": "GH-98", "graph": "develop-graph",
  "repoRoot": "...", "sha": "...", "pipelineSha": "...",
  "node": "build", "attempt": 1,
  "input": { "...": "..." }
}
{
  "schema": "graph/journal@3",
  "event": "end",
  "timestamp": "...",
  "runId": "...", "ticket": "GH-98", "graph": "develop-graph",
  "repoRoot": "...", "sha": "...", "pipelineSha": "...",
  "node": "build", "attempt": 1,
  "replayed": false,
  "outcome": "ok",
  "success": { "summaryPath": "build-1.md", "sessions": ["..."], "costUsd": 0.42 }
}
```

The journal is internal: it is read by the resume check (`runtime/resume.ts`, and
`journal/service.ts` for the replay itself), by `mag ps`, by `usage-report.ts` and by the
`gather-reviews` GraphNode, all inside this package. `schema` pins the row shape and every reader
accepts that literal and nothing else, so the shape stays free to change: a journal written under
another version is unreadable rather than half-understood. How each fact lands:

- **Runtime**: the `journaled` wrapper is already around every GraphNode, and it stamps both
  entries with an ISO timestamp. An attempt's wall-clock is the gap between its pair, which
  `usage-report.ts` recovers by pairing entries on node and attempt — zero per-GraphNode code.
- **Cost + session ids**: `ClaudeAgent` sums `total_cost_usd` and collects `session_id` over every
  spawn one call makes — the nudge and the corrective resume included, counted once each — and
  hands them back on the reply as `costUsd` and `sessions`. A GraphNode puts those on its own
  success value, so they reach the journal exactly as any other success field does, inside the
  `end` entry's `success`. Session ids enable `claude --resume <id>` to reopen the exact agent
  session behind a bad verdict.
- **Artifacts**: the success schema already carries the paths; the `end` entry records the encoded
  success value. Tracking falls out of the contract.
- **Aggregation across runs**: a dumb script over journal files — `usage-report.ts`.

## Authoring GraphNodes (Sonnet-safe)

Mechanical before model — the contract is enforced by scripts a lesser model can't rationalize
past; the skill only carries the judgment parts.

1. **Scaffolder**: `bun run mag node create --name <name> --description <description>` creates a folder for the name (errors if already existing) and emits `graph-node.ts` / `errors.ts` / `graph-node.test.ts` / `examples.ts` from a template. The model fills in schemas and error classes — it never invents structure. NO BARREL EXPORTS
2. **Generic conformance suite**: one test walks every registry entry — exports exist, at least one tagged error, `examples.ts` fixtures decode against the GraphNode's own schemas. Exit codes, not judgment.

`examples.ts` pulls double duty: conformance regression data and the worked documentation a model
reads before editing a GraphNode.

**A behaviour every node must have belongs in `make`, never in the template.** The scaffolder
writes a node once; the node is then edited, copied, and hand-written for years, and nodes that
predate a template change never see it at all. So a line the template emits is a convention that
decays, and it decays silently — the node still compiles, still passes conformance, and just
quietly lacks the behaviour. `make` (`graph-node.definition.ts`) is the single seam every node,
phase and graph passes through, so a wrapper applied there holds for all of them by construction
and stays true for nodes written after the fact. `journaled` is applied this way: a node
leaves a run record by being built, and there is no per-node line to forget. Reach for the template
only for what a node genuinely gets to choose.

Future metrics to track: what a run costs against what the same change would have cost a person,
counting the person's time to launch and supervise it, and whether the result was better, or only
possible, this way.

---

# Addenda: three rulings that come before code

Each of the three is a decision the first line of code would otherwise make by accident, so each
is settled here rather than by whichever module reaches it first.

## Addendum: the artifact root

**Ruling: the graph writes into the root that already exists, and the graph name is a field, not a directory.**

```
~/.claude/graph/                      <- configDir(), honours CLAUDE_CONFIG_DIR
  mechanical-agent-graph-<8 hex>/    <- projectKey: basename + sha256(fullPath)[0..8]
    GH-98/
      20260817121246/                 <- runId
        journal.jsonl                 <- this run writes here, alongside any artifacts
                                         (design.md, build-<pass>.md, review-diff-<pass>.md)
                                         its agent-bearing GraphNodes produce
```

See "Artifact references are the default output" in `core-definitions.md` for how those artifacts are recorded.

The path functions (`configDir()`, `projectKey`, `runId`) live in `plugins/mag/` and are pinned
by a test against captured values, so the run-root layout stays stable across changes elsewhere in
the package. `plugins/mag` is its own package with its own `exports` map and typecheck, so it
computes these paths itself rather than importing them from anywhere else.

This layout has three properties:

- **`configDir()` honours `CLAUDE_CONFIG_DIR`**, normalising backslashes so a Windows value cannot survive into a downstream bash glob.
- **`projectKey` carries an 8-character hash of the full path**, so two checkouts of one repo — a worktree, a second clone — stay distinct instead of merging. This is not hypothetical: worktree checkouts of the same repo have produced distinct keys in practice.
- **There is a `runId` level.** Without one, two runs of the same ticket collide, and resumes write a new run id by design.

The graph name (`develop-graph`, `conflict-graph`) is recorded as a **field on the row**, not a path segment. A segment forces the decision at write time and turns "what did every run cost" into a cross-directory glob; a field answers the same questions and keeps the observable surface small, which is the Hyrum's Law argument this document already makes.

This root is the only home for the journal. Records are a separate question, settled by the target
repository's declared policy (`runtime/records.ts`): every record-writing GraphNode copies its
record into this root whichever policy is in force, and under `--records committed` it *also* stages
and commits the checkout's copy, on that checkout's own current branch. This repository declares the
default `run-root` and ignores `docs/graph/`, so here the run root is in fact the only copy.

## Addendum: graph zero

**Ruling: four nodes.**

```
fetch-ticket   (Shell — shells `gh issue view`)
     ↓
branch         (Shell — resume-safe checkout)
     ↓
build          (ClaudeAgent)
     ↓
verification   (Shell — the repo policy's declared suite)
```

It ends with a branch whose commits pass verification; `develop-graph` adds the publish tail on top.

What it is for, in order: it is agent-bearing, so it exercises `ClaudeAgentLive` and `journaled` for real rather than against a stub; it composes four nodes, so context-passing stops being speculative; and it stops short of `push-branch`/`create-pr`, so no host detection gets written before a graph has demanded it.

The review cycle is deliberately absent. Gall's Law: get the simple system working, then add the backward edge.

Target for the first run: a real, tiny, trivially verifiable bug fix — one file, a genuine bug.

The nodes this graph needs are built on demand, from what each node's job actually requires, rather than by running full tickets through the pipeline to discover it.

## Addendum: what a GraphNode is given

**Ruling: a node is given only what it needs, nothing more.**

If the entirety of node 1's success is the exact shape of node 2's input, node 2 gets it directly — composition is a straight pipe. Where the shapes do not line up, the graph file performs one small, visible transform. That visibility is the point: a transform in a graph file is the seam where a node is asking for something no node produces, and it should be obvious rather than absorbed.

**There is no ambient context object.** No `RunContext`, no shared state bag threaded through the run. Such an object hands every node facts it never asked for, which is the exact opposite of "a GraphNode's input schema is its whole contract".

This puts real design pressure on schemas: adjacent nodes should be shaped so they line up. That is the Inversion principle already in this document — design a GraphNode from its outcomes first, and a graph from the artifact the run must end with.

### The one exception: run-scoped constants

`runId`, `repoRoot` and the ticket id are needed by most nodes and produced by none of them. Threading them through every input schema would put fields on nodes that do not use them, which breaks the rule in the name of following it, and turns straight pipes into plumbing well before a graph reaches its eighth node.

**They go in the `R` channel as a Layer, not in input schemas.** Requirements are already Layers in this design, so this needs no new mechanism.

The split, stated once:

- **Input schema** — this node's work.
- **`R` channel** — the run this node is part of.

Settle any new case against that split deliberately. If it is left to be decided by whichever code needs it first, `journaled` will settle it by accident.

### Decoding

**Decode at trust boundaries only:** CLI input, and anything read back from a file or a subprocess. In-process composition calls `run` on already-typed values.

`execute` (`runtime/graph-node.definition.ts`) is the untrusted-edge path and stays exactly as it is. Composition simply does not go through it — re-decoding what the type system already proved is ceremony, paid per node per run.
