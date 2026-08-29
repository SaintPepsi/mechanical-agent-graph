# Principles

Every change to `plugins/mag` is checked against these. The nine checks come from
`docs/rebuild-sketch.md` (the founding document); the structural rules and rulings below stand
alongside them. When a proposed change and a principle collide, the principle wins until the
maintainer rules otherwise.

## The nine checks

- **Second-System Effect** — small, successful systems tend to be followed by overengineered,
  bloated replacements. Every addition here is a candidate second system; watch for it.
- **Gall's Law** — a complex system that works is invariably found to have evolved from a simple
  system that worked.
- **YAGNI** — don't add functionality until it is necessary.
- **Goodhart's Law** — when a measure becomes a target, it ceases to be a good measure. The
  journal's cost numbers and the north-star metric are diagnostics for humans, never targets for
  GraphNodes; the moment a brief is tuned to make the numbers pretty, the numbers lie.
- **Hyrum's Law** — with enough users, all observable behaviors of your system will be depended on
  by somebody. The schema-only contract is the defense: anything else observable (artifact layout,
  journal row shape) will grow dependents, so keep the observable surface deliberately small.
- **Lehman's Laws** — software that reflects the real world must evolve, and that evolution has
  predictable limits. The graph mirrors real dev work, so it will never be finished; keep change
  cheap at the designed seams (registry, graphs-as-files, error tags) instead of aiming for a
  final design.
- **Amdahl's Law** — the speedup from parallelization is limited by the fraction of work that
  cannot be parallelized.
- **The Map Is Not the Territory** — journals, schemas, and verdicts are maps; the repo is the
  territory. A green journal row is not a green build — trust exit codes and the working tree over
  recorded state.
- **Inversion** — design a GraphNode from its outcomes first (success schema and error codes),
  then work backward to what it needs; design a graph from the artifact the run must end with.

## Structural rules (rebuild-sketch)

- **A GraphNode's input schema is its whole contract.** It demands what it needs and never
  references "the previous GraphNode"; any graph that satisfies the schema may run it, in any
  position. No ambient context object — run-scoped constants (`RunInfo`) ride the `R` channel;
  everything else is input.
- **Every GraphNode is just a function.** No `script`/`agent` kinds; what a node needs is its `R`
  channel. Swap the live layer for a stub and the whole graph is unit-testable.
- **Services ride the R channel; arguments carry data.** A helper that needs `Shell` yields it
  from context inside its own Effect — threading a resolved service through parameters is manual
  DI for a dependency the runtime already carries.
- **Follow-up lives in the graph, never in the GraphNode.** A node emits success or tagged errors;
  the edge is the caller's. Split a node only on a contract split, never a routing split.
- **Graphs are files, not data.** A new graph costs one small file. Graphs-as-data (a table, YAML)
  reintroduces a single monolithic interpreter: every new shape needs a new feature of that
  interpreter rather than a new file.
- **A behaviour every node must have belongs in `make`, never in the template.** Template lines
  decay silently; a wrapper in `graph-node.definition.ts` holds for every node by construction —
  `journaled` is applied inside `make` for exactly this reason.
- **Errors are the railway.** Effect's error channel carries failure; escalation is an uncaught
  tagged error reaching one `catchAll`. No Result/two-track wrapper types.
- **Decode at trust boundaries only** — CLI input, files, subprocess output. In-process
  composition calls `run` on already-typed values.
- **The behaviour carries over, never the module.** A ported behaviour is reimplemented in its new
  home and pinned with a test, never imported from wherever it was first written.

## Rulings

- **North star: productivity per token per hour.** Every change is judged on shipped outcome per
  token and per hour of user attention, counting its own instruction-text cost.
- **Mechanical before model.** Before adding a requirement, ask whether a real script — exit
  codes, no judgment — can enforce it. A script costs no tokens and can't be talked out of a rule.
- **Tune a gate before adding a step.** A new need first becomes a tweak to an existing node's
  instructions or gate. A node is added or reordered only when the need genuinely cannot live
  inside an existing one, and the ticket says why. Nodes are expensive; gates are cheap.
- **Instructions say what to do, not what to avoid.** State the action ("commit each task
  serially, one commit per task"). Prompt text a model re-executes reads as direction, and naming
  a thing to avoid tends to surface it instead of suppressing it.
- **Prune on the ledger, not on vibes.** A review node earns its place by catching things; its
  verdicts are its ledger in the run journal. One that tallies zero blocking catches across a
  multi-run window goes on probation, resolved kept-or-merged-away only by the next runs' numbers.
- **Working shape through model, extract what's mechanical afterwards.** Don't design a step's
  mechanical split before a model has proven the shape by doing the whole thing; mechanize what
  turns out to be pure computation.
- **No guards for failures never experienced.** A defensive check for a failure mode no run has
  ever exhibited is not built, however cheap — the issue closes not-planned with its reopen
  condition (the first observed instance) written down. For example: no `modelUsage` assert is
  built, because the pinned CLI binary is the de-facto guard until a mismatch is ever seen.
- **Graphs read straight-line; loop-backs become composite GraphNodes.** A graph file is a
  top-to-bottom pipe. Retry/review cycles live inside a made composite node
  (`build-under-review`), not as routing in the graph.
- **Codebase agnostic.** The pipeline assumes nothing about a target repo's language or layout and
  seeds no files into it; anything it needs it learns fresh per run.
- **Unfit paths should error; don't brute force.** A failure means the inputs are wrong until
  proven otherwise: adjust the inputs, never widen the system to make them fit (execve/E2BIG).
- **Cold-start meaning.** An artifact — code comment, prompt text, design doc, vision — never
  names an identifier its reader can't resolve from the artifact itself. A requirement or ruling
  that drives a shape is restated in the artifact's own words, or cited by the path that defines
  it; a bare `FR-x`/`NFR-x` is a reference to nothing.
- **A vision names GraphNodes; `runtime/` additions are justified at review.** Envisioning is
  blind — an envisioning prompt never instructs about the current runtime boundary. The rule it
  protects is review's to enforce: a GraphNode is a step in the run's data flow, any size;
  `runtime/` is shared machinery only, and every addition to it carries its own justification — a
  shared reader, a generic error, a boundary no single node can own alone (`runtime/git.ts`'s doc
  comment is the citable precedent). A change that reaches for `runtime/` without saying why is
  unreviewable, not shorthand.
- **An exported `runtime/` type ships with a compile-time pin on what it promises.** A change to a
  public type in `runtime/` (a builder's return type, a declared error union) is invisible to every
  runtime test, since the type never becomes a value; the only script that can catch its regression
  is `tsc`. So the change carries a type assertion in the module's test file that fails typecheck if
  the promise is erased (`construct.test.ts`'s `.finalise` pin is the precedent: it fails typecheck
  if `.finalise`'s error union drops a run-layer tag or collapses to `never`).
- **A ruling outranks a blocker.** When a maintainer ruling collides with a tooling obstacle,
  surface the collision — never adapt the design around the obstacle and ship the adaptation.
- **Probe before claiming runtime behaviour.** A signature, doc comment, or plausible reading is a
  contract, not evidence; run the real thing and read what came back before wiring on it
  (`runtime/claude/spawn.ts`'s `--model` probe: the same call with and without the flag, compared on the result
  message's `modelUsage` field rather than on the model's own self-report).
- **No throwaway verification harnesses.** Anything worth verifying is worth a test in the suite;
  a one-off script that composes the runtime by hand proves nothing durable and gets deleted
  unread.
- **Where a run executes is declared, not defaulted.** Every graph states its execution shape on
  `RunScope.worktree`, required, no absent-means-primary path; develop-graph's shape is worktree
  isolation, unconditionally. Nested: a graph composed as a
  node inside a host inherits the host's already-minted scope — its own declared `scope` is inert
  while borrowed, by construction (`RunScoped`), never by the borrowing site remembering to
  skip anything.
- **Tickets that touch GraphNodes name them up top**, first line of the body:
  `GraphNodes: [+] \`added\` [%] \`modified\` [-] \`removed\``.
- **Artifacts state the present; history lives in git and the journal.** A diff reads as "name,
  shape, problem it solved". Comments are one line and state what the code cannot show; record
  corrections are in-place rewrites, never dated annotation blocks or collision diaries; a PR body
  is a one-line executive summary, the remaining facts grouped by behaviour changed, a contract-delta
  section when a contract moved, plus the closing linkage. Reviewer cognitive load is the
  bottleneck, and process narration is its main cost.
- **A blocked sibling import promotes the helper to `mag/runtime/`; it never copies it.** The
  import allowlist is a signpost to the shared seam, not a license to duplicate with a
  justification comment.
- **Skill text is cold-startable and repo-agnostic.** Compiled skill content states its rules as
  terse imperatives a session in any repo can follow: no ticket numbers, no repo file references,
  no decision archeology, no argued rationale.
- **The ticket and every model-produced string is a run-root file that schemas name by path.**
  Agents can't remember, they can only reference: text spliced into a prompt lasts exactly one
  context window, while a file is a cited baseline every later session reopens on the same terms,
  and the journal records a path instead of a copy per node. `fetch-ticket` writes
  `<runRoot>/ticket.md` once and no node changes it afterwards; a ticket-driven prompt opens with
  the id and title, then `Read the ticket at <path>` (`runtime/ticket.ts`), and nothing else from
  the ticket. A session's own prose (a build summary, a dispute, a PR description, a declared
  block) lands as `<prefix>-N.md` and its success or error carries the path. Two inputs still carry
  text between nodes, deliberately: the assembled brainstorm prompt (`brainstorm.input.prompt`,
  budget-checked by `assemble-brainstorm-prompt`) and the caller-authored addenda
  (`build.addendum`, `review-diff.addendum`). Precedent: v1's ingest step
  wrote the immutable ticket doc once and every later step read it as the fixed baseline.
- **An autonomous design decides.** Every ambiguity becomes a ruling with a basis; a user-visible
  choice the ticket does not settle keeps existing behaviour and says so. A run that cannot decide
  has failed, not asked. Reason: the two trial runs' open questions were hedges already answered in
  the same document, each costing a design, plan and review pass.
- **Two channels, one gate.** A review verdict is two lists: blocking and notes. Only blocking
  gates; notes land in the findings record and never send anything back. Blocking is an acceptance
  criterion unmet or behaviour wrong, cited; a note is everything else, including whatever the
  toolchain catches. There is no questions channel: nobody in an autonomous run answers one, so the
  reviewer judges instead. Reason: the GH-332 trial's reviewer asked the same two questions on both
  passes, each already ruled in the design, and the plan resume answered neither (`skills/review-brief.ts`).
- **A finding is a defect, a dispute is a denial.** A finding states the defect and its evidence,
  never a fix; the author owns the remedy. A dispute is for a finding whose defect is denied; an
  accepted defect is fixed, whatever the reviewer suggested. An adjudicating pass rules on the
  disputed findings alone, and everything else it blocks on routes as on any pass. Reason: the
  GH-373 trial's reviewer proposed a mechanism, the design accepted the defect and disputed the
  mechanism, the adjudicating pass upheld it and the run still died `PLAN_DISPUTE_REJECTED` on two
  fresh findings (`graph-nodes/review-plan`, `graph-nodes/design-under-review`).
- **A node's required inputs are the ticket plus the one artifact of the stage before it; a second
  artifact needs a ruling naming why, listed in the conformance rule's exceptions.** Loop state
  (`findingsPath`, `disputePath`, `priorFindingsPath`, `resume`) is not a stage input. The design is
  the plan's input and nothing else's: the plan is the reviewer's input and the builder's, and it
  carries whatever design decisions and principles it applies, in its own words — a decision the
  plan never states is a plan finding on that ground alone. The plan is the builder's only input:
  the builder never reads the ticket, so the plan quotes the acceptance criteria it proves, and a
  build pass is judged against the plan rather than re-deriving the work from the ticket. The rule
  is `input-boundary` (`graph-nodes/conformance/rules.ts`): it walks every node, counts the required
  `...Path` fields beside `ticketPath`, and fails a second one unless the node is in
  `INPUT_BOUNDARY_EXCEPTIONS` with its ruling: `plan` (the plan resolves names against the repo,
  v1's Resolution Table position). Reason: both trial designs paid a reconciliation tax for a
  second artifact, a nine-row Vision Reconciliation table on one and three invented nodes refused
  on the other; the shell drawn as a section of the design, in the design's own session, got the
  value without it.
- **Quiet on green.** A green run reports the PR and nothing else; a failure gets the full report.
  Passing detail in a transcript is re-read on every later turn, pure context burn, and a gate's
  evidence never needs more than the count line.
- **One concern per session.** A node's prompt asks one question and the session writes one
  artifact; a second question is a second node. A session given two concerns degrades on both, in
  the maintainer's words the agent goes BONK mode. Precedent: `discover` (what exists) is one
  node and one note; what a design reuses is `recycle-scan`, a script over the design's own names,
  never a second section of that note.
- **Prompts are terse one-liners.** A prompt is written by a model, for models, and terse,
  concise language is the only style observed to survive a model change: one instruction, one
  line, scope stated exactly. Enforced before build by `prompt-terseness-evaluator`.
- **Per-repo commands reach a run as launch inputs, never as files this pipeline seeds into the
  target.** A run's verification suite and worktree setup command are per-repository facts:
  `develop-graph` keeps `VERIFICATION_COMMAND`/`WORKTREE_SETUP` as its own default (unchanged for
  this repository's own runs) and accepts `--verification`/`--worktree-setup` to override them for a
  repository that is not this one. Run records are the one thing a run writes into the target, and
  only on the target's declared terms: every record is copied into the run root, and it is committed
  into the target's own checkout only where that repository declares `Run records: committed to the
  branch` (`records.ts`'s `record`, gated on `RunInfoService.records`).
