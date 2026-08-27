# mechanical-agent-graph

The home of `mag`: a ticket worked end to end as a graph of typed nodes. Every edit to the
pipeline happens here; per-repo behaviour comes in as launch flags, never from edited copies. A
consuming repo's `CLAUDE.md` Repo policy block is where a launcher reads which flags to pass.

- **North star: productivity per token per hour.** Every change is judged on shipped outcome per
  token and per hour of user attention, counting its own instruction-text cost. Authoring rules
  live in `plugins/mag/PRINCIPLES.md`, Rulings.
- **Codebase agnostic.** The pipeline assumes nothing about a target repo's language, layout, or
  export syntax, and seeds no files into it. Anything it needs to know about a codebase it learns
  fresh per run, by targeted search derived from the artifact at hand.
- **Mechanical before model.** Before adding a requirement or check, ask whether it can run as a
  real script (a shell test, a grep, an exit code) with zero model judgment. A script costs no
  tokens, can't rationalize, and can't be talked out of a rule; a model session is for the part
  that genuinely needs judgment. Precedent: `detect-svelte` and `detect-effect` answer "does this
  ticket touch that stack" by reading the repo's manifests, with no model session at all.
- **Extend the definition, not every node.** A behaviour that must hold for *every* GraphNode goes
  in the one thing every node already passes through: `make` in `graph-node.definition.ts`, the
  conformance suite, the registry walk. Per-node edits and `mag node create` template lines are
  prohibited homes for it. Precedent: `journaled` is applied inside `make`, and the conformance
  rule `journaled-construction` enforces construction through `make`.
- **Unfit paths should error; don't brute force a solution.** A failure means the inputs are wrong
  until proven otherwise: adjust the inputs, never widen the system to make them fit. Precedent:
  an oversized prompt dies at `execve` rather than the transport growing a stdin channel.
- **A ruling outranks a blocker.** When a maintainer ruling collides with a platform or tooling
  obstacle, stop and surface the collision; never adapt the design around the obstacle and ship
  the adaptation. Precedent: the sensitive-file guard refuses agent writes under `~/.claude/**`, so
  a record-writing session writes into a tree it is allowed to write, and the node — this process,
  which the guard doesn't bind — copies the record into the run root.
- **Working shape through model, extract what's mechanical afterwards.** This orders the rule
  above, it doesn't contradict it. Don't design a step's mechanical split before a model has proven
  the shape by doing the whole thing, even clumsily. Mechanize only what turns out to be pure
  computation.
- **Effect code.** Before writing any Effect code, read `node_modules/effect/AGENTS.md` completely;
  for any API it doesn't cover, search `node_modules/effect/src` directly.
- **POSIX only; on Windows the supported path is WSL.** The launcher refuses `win32` outright and
  CI runs `ubuntu-latest` only. Don't add Windows compatibility back: tests use shebang execution,
  process groups and `chmod` semantics directly, and half-running on Windows once produced dozens
  of permanently-red tests that hid a real, platform-independent regression for weeks.

## Repo policy (this repo as a pipeline target)

- Tracker: GitHub issues via `gh`; issue `#4` = ticket `GH-4`.
- Tickets are filed with `bun run mag ticket-writer --what … --why … --how … [--criteria-path …]`:
  the graph renders the house-style body (`.github/ISSUE_TEMPLATE/ticket.md` is the hand-filed
  starting point; the renderer adds a Context section and puts the Depends/Blocks line last) and files it via `gh`.
- Base branch: trunk-based (`main`).
- Publishing: autonomous push and PR creation; merging stays the user's.
- Verification suite: `bun run typecheck && bun run test` from the repo root, so what's declared
  here and what the `verification` node runs are the same string.
- Run records: run-root only. The run root under `~/.claude/graph/<project-key>/<ticket>/<run>/` is the
  record of a run; this repository ignores `docs/graph/`, so `committed` is for target repositories
  that track it — here it would fail at `git add`. A repo that declares
  `Run records: committed to the branch` is launched with `--records committed`, and each
  record-writing node then also commits its repo copy, on its own current branch.
