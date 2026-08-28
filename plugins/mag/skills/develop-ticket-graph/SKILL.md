---
name: develop-ticket-graph
description: Run one ticket through `bun run mag develop-graph`, wait on the run's own signal, and read the record honestly when it ends. USE WHEN asked to develop, run, or ship a ticket through the graph, "run GH-123", "continue developing the ticket graph", or implementing plugins/mag nodes.
---

# develop-ticket-graph

How a session runs a ticket through the graph and reacts to how the run ended. The work is
starting the right run, waiting without spending model calls, and reading the record afterward
instead of assuming the run went well.

Run this in the session that owns the run, not in a subagent. Waiting for a run is a background
task whose completion notification wakes the session back up; a subagent that ends its turn is
finished, and nothing re-invokes it, so a subagent watchdog silently stops watching.

## Inputs

The ticket comes from the user: an id (`GH-123`), or a short ordered list to run one after
another. Nothing here decides what to work on; a session that has no ticket asks for one and
stops.

A ticket that does not exist yet is filed first: `bun run mag ticket-writer --what <sentence>
--why <sentence> --how <sentence> [--criteria-path <file>]` turns three one-sentence inputs into
a house-style ticket filed with `gh`.

## Running a ticket

1. **Confirm it is runnable**: the ticket is open, has acceptance criteria, and has no branch
   anywhere yet (`git branch -a | grep -i <TICKET>`, local and remote, which covers a previous
   attempt). If any of those fails, report it and stop.
2. **Start it, stacked on the previous ticket if there is one:**
   `bun run mag develop-graph --ticket <TICKET> [--base <previous ticket's branch>]`.
   Every run executes in its own isolated checkout, so there is no worktree to find or
   `cd` into first: the run materializes and retires it itself. `--base` alone carries the stack:
   name the branch of the ticket immediately before this one in the list, and the run branches
   from its tip instead of `main`. Omit `--base` for the first ticket, or once the previous
   branch is already merged into `origin/main`.
   Add `--records committed` only when the target repo's `CLAUDE.md` Repo policy says
   `Run records: committed to the branch`; the default keeps records in the run root.
3. **Watch it** (below) until it reaches a terminal state.
4. **Read the outcome and react** (below). With more tickets in the list, go back to 1.

## Waiting for a run (the "during" half)

Wait on the run's own signal rather than guessing how long a node "should" take. Start the run
command in the background (`run_in_background`), then **end your turn**. That is the whole
mechanism: the command is the run, foreground for its whole duration, and its completion
notification brings you back to read the record. A run takes hours, and none of that time needs a
model in it.

Ending the turn is correct here, not a lapse — resist the pull to keep the session busy. Blocking
on a foreground run buys nothing (the harness converts a long foreground command into a background
task anyway) and re-issuing foreground runs to stay "on" just leaves a pile of stalled processes,
none of which is the one you end up reading. Equally, don't poll once per turn: that spends a
model call to learn a node is still running.

### Useful work during the wait — Fable advises, Sonnet does the legwork

Ending the turn is the default, but the hours a run takes are also the cheapest time to prepare
what comes after it. Two roles, never mixed:

- **Fable is the advisor.** Consult it for judgment: is the queue in a sensible order, what will
  hurt in a month, what should be cut, what is nobody thinking about. Prompt it as a colleague
  giving advice, not as a reviewer producing a report, and ask it to take positions and
  disagree. Fable is expensive, and only judgment a cheaper model can't produce justifies it.
- **Sonnet is the work hand.** Everything with a verifiable right answer: cross-checking a
  ticket's acceptance criteria and line citations against what the repo actually says now,
  finding overlaps between two tickets' proposed nodes, mapping `docs/rebuild-sketch.md`
  against what exists, gathering evidence. Never send this to Fable — legwork is exactly where
  the expensive model buys nothing, and spending it there is a straight hit to the north-star
  metric.

The staleness check is the highest-value Sonnet errand here: a ticket ranked from its *text*
rather than the repo's *state* is usually wrong about what still needs doing. Catching a stale citation before a run starts saves hours of pipeline time.

Neither of these is the watchdog. The backgrounded run above is still the thing that wakes the
session, a subagent never watches a run (see the note at the top of this file), and prep work must
not turn into a reason to keep polling in the foreground.

## Reading the outcome (the "after" half)

One run emits four things:

- **stdout, success only**: one JSON line, `{ ticket, branch, summaryPath, commits, costUsd,
  sessions, reviewPasses, prUrl }`.
- **stderr, always**: `mag: [develop-graph] entered`, then one closing line drawn from
  `runtime/trace/console-sink.ts`'s `CLOSE_LINE` table, all four rows: `mag: [develop-graph] ok
  <secs>`, `mag: [develop-graph] FAIL <TAG> <secs>`, `mag: [develop-graph] DIE <TAG> <secs>`,
  or `mag: [develop-graph] INTERRUPT <secs>`. FAIL and DIE print one more line, `<TAG>:
  <message-or-compact-JSON-of-the-error's-fields>`. Only the outer graph prints `mag:` lines;
  per-node progress lives in `journal.jsonl`, not on the console.
- **exit code**: 0 on `ok`, 1 on `FAIL` or `DIE` (`render.ts`'s `renderFailure` mutates
  `process.exitCode` rather than failing the effect, so `NodeRuntime.runMain` exits naturally on
  the mutated code), 130 on `INTERRUPT` (`run-cli.ts` catches neither interruption, so `effect`'s
  own `Runtime.defaultTeardown` exits it).
- **on disk**: `journal.jsonl` in the run root
  (`<CLAUDE_CONFIG_DIR>/graph/<project-key>/<ticket>/<run-id>/`), its artifacts beside it
  (`ticket.md` first, the fetched ticket every session read by path; a resumed run cites the
  predecessor run's copy), and on failure the run's worktree, kept. Its end row is written on all
  four outcomes (`journal/row.ts`).

**Success**: exit 0 and the stdout JSON line. Its `prUrl` is the PR — `create-pr` schema-encodes
it from `gh`'s own output, so there is nothing to re-confirm with a second `gh` call. That is the
ticket done for this loop; repo policy is autonomous push and PR, merge stays the user's. Report it and stop, or take the next
ticket you were given.

**Killed**: exit 130, the `INTERRUPT` closing line, and nothing else — no tag, no payload. The
process was killed (`SIGINT`/`SIGTERM`) before it finished, not a node failing. Relaunch if the
kill wasn't intentional.

**Failure**: exit 1 and a `<TAG>: <payload>` line. A `FAIL` is a declared error; a `DIE` is a
defect, a raw throw `run-cli.ts`'s `Effect.catchDefect` routes through the same renderer, tagged
with the thrown value's own `_tag` when it has one and `UNKNOWN_ERROR` otherwise
(`trace/outcome.ts`'s fallback) — a defect's fix is almost always in the node's own code rather
than the run's input. Decide on what the payload carries:

- **A path field** (`findingsPath`, `disputePath`): the run wrote a document saying what it
  concluded. Read that file in the run root before anything else — it is the argument, the tag is
  only its headline. The review errors also carry `headSha`, `sessions` and `costUsd`, so the
  spend is on the line even though the journal has no cost column. (`build`'s own `BuildDisputed`
  also carries a `summaryPath`, but that tag never reaches this line — `build-under-review`
  catches it itself and turns it into either a success or a `reviewDiff` failure, so a
  develop-graph failure line never shows `summaryPath`.)
- **`VERIFICATION_FAILED`**: the repository's own declared suite went red — `{ command, exitCode,
  outputTail, reportPath }`. This one's `exitCode` is the suite's exit code, not a subprocess
  condition to fix outside the repo; `outputTail` (capped at 4000 chars) names the failing test and
  the tail of its output directly, and `reportPath` is the same three fields written to the
  run root, for a repair session resumed later to read instead of this line's own copy. Fix the code
  the suite is failing on, not the environment, then relaunch.
- **A host field** (`stderrTail`, `exitCode` on `CLAUDE_AGENT_EXIT`, `signal`, `resetAt`): the
  subprocess's own words are already printed on the failure line, no separate log to open. If they
  name a condition outside the repo (a CLI refusing to run as root, a missing binary, an unreadable
  credential, a spent five-hour window), fix the condition and relaunch, and say plainly in the
  report what changed. A spent window is `CLAUDE_USAGE_LIMIT` with a best-effort `resetAt`: hand
  off to the `loop` skill with the continuation prompt ("continue developing the ticket graph") so
  the session wakes itself at the reset, rather than polling.
- **Neither**: it is a relaunch-or-stop call, decided by the two Boundaries rules below on
  unfit input and on repeated evidence.

Forensics, in order of what they answer:

- `journal.jsonl`'s last rows: which node was in flight, and its `outcome`/`tag`. A trailing
  `start` with no matching `end` names the node that was running when the process stopped.
- `bun run usage-report <run dir>`: what each node cost in time and money.
- the run's kept worktree, at `<repo-parent>/<repo>-worktrees/<ticket>-<runId>`: the tree as the
  failure left it.
- `plugins/mag/src/**/errors.ts`: what a tag means, authoritative. Never restated here.

## Boundaries

- Never merge a PR. "Done" here means open, not merged: that is the user's call.
- **Unfit paths should error; don't brute force a solution.** Things dying and failing means the
  inputs are wrong, or at least that is the first assumption. When a run, node, or spawn dies
  hard, read the failure as a statement about what was fed in and adjust the input upstream,
  never widen a bound, add a channel, or build an accommodation so the bad input fits. (An
  oversized prompt dies at `execve` rather than the transport growing a stdin channel to carry it.)
- **Relaunch while the evidence changes; stop when it repeats.** Compare the new failure line
  against the previous one: same tag, same fields, same node. Identical is deterministic, so
  relaunching again cannot change it: stop and report both lines. A different tag, different
  fields, or a failure at a later node means the run advanced: relaunch again. Every relaunch
  re-pays the whole run from `resolve-base`; there is nothing cheaper. Don't count attempts: a
  fixed limit stops progress still happening and keeps re-running what never could work.
- **Report what shipped; never decide what's next.** The PR, the cost, and how the run ended are
  yours to report. Which ticket comes next, or whether one should be dropped, is the user's;
  if the run's findings suggest the plan is wrong, say so and stop.
- **No process narration in anything you write** (`plugins/mag/PRINCIPLES.md`, "Artifacts state the
  present"). Code comments: one line, only what the code cannot show. Records: rewritten in
  place, no revision markers. PR bodies: a one-line executive summary, the remaining facts
  grouped by behaviour changed, a contract-delta section when a contract moved, then
  `Closes #n`, nothing else. History lives in git and the run journal.
