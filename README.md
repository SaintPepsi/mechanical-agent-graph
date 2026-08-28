# mechanical-agent-graph

`mag` works a tracker ticket end to end: from its acceptance criteria to a reviewed, verified,
open pull request, with no human in the loop until the PR needs a merge.

Every step is a `GraphNode`: a typed input, a success schema and a closed set of tagged errors,
composed into graphs on [Effect](https://effect.website). Anything mechanical (fetching the ticket,
probing manifests, running the test suite, pushing) is a real subprocess or a plain file read, with
a real exit code. A model session is spent only where judgement is needed, and every session's cost
lands in the run's journal, so a failed run resumes from its last success.

**The metric everything here answers to: productivity per token per hour.** Every node, gate and
instruction line exists because it moves that ratio; anything that can't show what it buys gets
pruned.

## What a run does

```
prepare                     fetch the ticket, refuse it without acceptance criteria, verify the
                            base branch
checkout                    a detached worktree per run, setup command run inside it
design-graph                envision ∥ discover → brainstorm: a design record before any code
build-under-review          build → verification → simplify → review-diff, findings sent back into
                            the same session until the diff is clean or the cap is spent
prompt-terseness-evaluator  rewrite any verbose prompt text the build added, re-verify if it
                            moved HEAD
publish-tail                PR body from the merge-base diff, push, open the PR
```

## Install the skills

The plugin ships this repository's skills (brainstorming, discover, envision, writing-plans, …)
into Claude Code:

```sh
/plugin marketplace add SaintPepsi/mechanical-agent-graph
/plugin install mag@mag
```

## Run the pipeline

The pipeline itself is a Bun CLI, not the installed plugin. Clone it once and install its
dependencies:

```sh
git clone https://github.com/SaintPepsi/mechanical-agent-graph
cd mechanical-agent-graph
bun install
```

A run works on the repository it is *started in*: the repo root is `git rev-parse --show-toplevel`
from the process's directory, `fetch-ticket` shells `gh issue view` there and writes the ticket
once to the run root as `ticket.md` (every later session reads it from that path, never from its
prompt; a resumed run cites the predecessor run's copy), and every agent session runs there. So
launch it from a checkout of the target repository, naming the CLI by path:

```sh
cd /path/to/your-repo
bun /path/to/mechanical-agent-graph/plugins/mag/src/cli.ts develop-graph --ticket GH-123 \
  --slug <owner>/<repo> --maintainer <github-user> \
  --verification "<your test command>" --worktree-setup "<your install command>" \
  --agent <an agent defined in your repo's .claude/agents/>
```

`--slug` is the `<owner>/<repo>` the pull request is opened against (`gh pr create --repo`), not
where the run happens. `--agent` names an agent from the target repository's `.claude/agents/`,
because that is the directory the session runs in; the default names this repository's own
`effect-expert`.

Requirements: [Bun](https://bun.sh), `git`, `gh` for the tracker and PR host, Claude Code on
the `PATH`, and `bunx playwright install chromium` once for the viewer's browser test. POSIX
only; on Windows use WSL.

Every per-repo fact is a flag; `develop-graph --help` lists them all. From inside this clone the
same CLI is `bun run mag <subcommand>` — the form the bullets below use, and the one that targets
this repository when the pipeline itself is the work.

- `bun run mag ps` watches every run active on this machine, repainting the table (current node,
  elapsed time, spend) every `--interval` seconds until you interrupt it; `--once` prints a single
  snapshot and exits.
- `--resume` continues the prior run of the same ticket with the most replayable nodes: journaled
  successes replay, the rest runs live.
- Nodes are subcommands too (`fetch-ticket`, `review-diff`, …): `bun run mag --help` lists them,
  `bun run mag node create --name <name> --description <text>` scaffolds a new one that the conformance
  suite immediately checks.
- Journals and records live under `~/.claude/graph/<project-key>/<ticket>/<runId>/`, where the
  project key is the repo's directory name plus a short hash of its path.

## Parameterised per repo, never forked

The pipeline assumes nothing about a target repository's language or layout. What legitimately
differs per repo (tracker and ticket-id convention, base branch, verification command, whether run
records are committed, how much of publishing is autonomous) is declared in that repo's
`CLAUDE.md` under **Repo policy** and passed as launch flags. This repository's own section is the
worked example.

## Principles

- Mechanical before model: a script that can decide never asks a model to.
- A node's input schema is its whole contract; no node references "the previous node".
- Follow-up lives in the graph, never in the node: a node emits success or tagged errors.
- Graphs are files, not data: a new shape is a new small file, never a feature of an interpreter.
- Unfit paths error; the inputs get adjusted, the system never widens to fit them.

The full list, with the reasoning behind each, is `plugins/mag/PRINCIPLES.md`; `docs/rebuild-sketch.md`
is the design the pipeline is built toward and `docs/core-definitions.md` defines the terms.

## Working on the pipeline

`bun run typecheck && bun run test` is the verification suite, the same command every run's
`verification` node executes here. Tickets are GitHub issues in the house shape
(`.github/ISSUE_TEMPLATE/ticket.md`), filed by hand or with `bun run mag ticket-writer`.

## Licence

AGPL-3.0-or-later. See `LICENSE`.
