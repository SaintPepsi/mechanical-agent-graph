```ts
// tdd-build, outside: { ticket, base?, worktree?, agent? } → Effect<
//   { prUrl, branch, commits, rounds, escapes, reviewPasses, sessions, costUsd },
//   AcceptanceCriteriaMissing | BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable
//   | TicketNotAddressable | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable
//   | MissingTicketId | WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
//   | DiscoverNoteMissing
//   | DeadTestAtBirth | HarnessError | TestDisputed | PathsTouched | StillRed | VerificationFailed
//   | TddBuildEscapeUnresolved
//   | ReviewDisputeRejected | ReviewBlocked
//   | PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed
//   | PushDirty | PushEmpty | PushRejected | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed>

const Prepare = Graph.construct("prepare")
  .fork(ResolveBase, FetchTicket)
    // { base? } → { base } !BaseRefMissing !BaseRemoteMissing !BaseRemoteUnavailable
    //   ∥   { ticket } → { ticket, title, body } !TicketNotAddressable !TicketNotMaintainerAuthored !EmptyTicket !TrackerFailed !TrackerUnreachable
  .then(RequireAcs)
    // { ticket, title, body } → discarded !AcceptanceCriteriaMissing
    // the gate: refuses a ticket with no acceptance criteria before any spend. Its own criteria text is not drawn
    // flowing anywhere past this gate — see gaps, on how the tdd lane's first-round spec is meant to reach it
  .join(FormatBranchName)
    // { ticket, title } → { branch } !MissingTicketId
  .finalise()
    // outside: { base?, ticket } → { base, ticket, title, body, branch }
    //   !AcceptanceCriteriaMissing | BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable
    //   | TicketNotAddressable | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable | MissingTicketId
    // uncaught failure here dies with nothing kept: no worktree exists yet

const Checkout = Graph.construct("checkout")
  .when(worktree, WorktreeAdd)
    // { base } → { path } !WorktreeAddFailed !WorktreeSetupFailed
    // default true; materializes a detached worktree and runs the setup command, once
    // false skips this node entirely — path stays absent, CheckoutBranch operates on base directly
  .then(CheckoutBranch)
    // { base, branch, path? } → { path } !BranchCheckoutFailed !BranchCreateFailed
    // resume-safe: re-enters an existing checkout of `branch` rather than recreating it
    // gated to start only once WorktreeAdd's path exists, when worktree = true
  .finalise()
    // outside: { base, branch } → { path } !WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
    // uncaught failure from here through publish-tail dies with the worktree kept, for a human

const Discover = Graph.construct("discover")
  .then(DiscoverNote)
    // { title, body } → { discoverPath } !DiscoverNoteMissing
    // read-only recon of the ticket's terrain, cited, gated to start only once checkout's branch exists —
    // this run's own commits land there first
  .finalise()
    // outside: { title, body } → { discoverPath } !DiscoverNoteMissing

const RedLoop = Graph.construct("red-loop")
  .loop(WriteRed, AssertRed, {
    // WriteRed: { plan, addendum? (send-back only) } → { testPaths, redSha }
    //   writes one red test per behaviour on its own assertion, commits, declares which paths are tests
    // AssertRed: { testPaths, redSha } → verdict, classifying each declared path red, green or broken
    //   allRed: { redSha, testPaths } → exits the loop as { headSha, testPaths }
    //   green | broken: { addendum } → feedback to WriteRed against the same plan
    feedback: AssertRed.addendum -> WriteRed.addendum,
    until: AssertRed.verdict === "allRed",
    cap: RED_LOOP_CAP,   // send-back cap, policy
  })
  .onCap(die(DeadTestAtBirth | HarnessError))
    // verdict still green (a dead test) or broken (a harness fault) when the cap is spent:
    // the red commit is kept, for a human to rewrite
  .finalise()
    // outside: { plan } → { testPaths, headSha } !DeadTestAtBirth | HarnessError

const GreenLoop = Graph.construct("green-loop")
  .loop(Implement, PathsUntouched, AssertRed, {
    // Implement: { headSha, testPaths, addendum? (send-back only) } → { headSha } !TestDisputed
    //   makes the declared tests pass, source only, commits — or disputes a test as wrong instead of fixing it
    //   (verdict = dispute: escalates past this loop entirely; disagreement recorded to disk, headSha kept, a human settles it)
    // PathsUntouched: { headSha } → (gate: the commit range touched none of the declared test paths) !PathsTouched
    //   (verdict = touched: the offending range is kept, for a human)
    // AssertRed: { headSha, testPaths } → verdict, the same red/green/broken classification red-loop's own runs
    //   allGreen: { headSha } → exits the loop
    //   stillRed: { addendum, sessionRef } → feedback to Implement, resuming its own session against the addendum
    feedback: AssertRed.addendum -> Implement.addendum,
    until: AssertRed.verdict === "allGreen",
    cap: GREEN_LOOP_CAP,   // send-back cap, policy
  })
  .onCap(die(StillRed))
    // verdict still red or broken when the cap is spent: the tree is kept mid-fix, for a human to finish
  .finalise()
    // outside: { headSha, testPaths } → { headSha } !TestDisputed | PathsTouched | StillRed

const RedGreen = Graph.construct("red-green")
  .borrow(RedLoop)     // { plan } → { testPaths, headSha } !DeadTestAtBirth | HarnessError
  .borrow(GreenLoop)   // { headSha, testPaths } → { headSha } !TestDisputed | PathsTouched | StillRed
  .finalise()
    // outside: { plan } → { headSha } !DeadTestAtBirth | HarnessError | TestDisputed | PathsTouched | StillRed

const DetectSmells = Graph.construct("detect-smells")
  .then(DetectJsTests)
    // { srcPaths, testPaths } → { testPaths, verdict }, classifies whether the touched tests are JS-shaped at all
  .when(DetectJsTests.verdict === "jsTests", TestSmells)
    // (condition reads the node just wired in, not an outside flag) { testPaths } → { smells },
    // text-decidable flaws a grep can find, no model session
    // verdict = other: smells stays empty, TestSmells never runs
  .finalise()
    // outside: { srcPaths, testPaths } → { smells }

const BreakEscapes = Graph.construct("break-escapes")
  .map(Break)
    // { srcPaths, testPaths } → { claims[] }, one blind breaker per branch (breakers read from R, not carried
    //   as data), each claiming a mutation the tests would miss, no breaker sees another's claim
    // a breaker's own failure is isolated to its own slot: the remaining breakers' claims still reach
    //   verify-escapes — the vision never decided this either way, flagged in gaps
    // fan-out width is policy, not shape
  .then(VerifyEscapes)
    // { claims[], command } → { escapes[] }, applies each claim and keeps what the suite misses and a probe confirms
  .then(JudgeSeverity)
    // { escapes[] } → { rated, verdict, escapeSpec? }, blind category lookup: severity is a table on the category;
    //   verdict.maxSeverity ≥ 2 also produces escapeSpec, the worst escape formatted as the next round's spec
  .finalise()
    // outside: { srcPaths, testPaths, command } → { rated, verdict, escapeSpec? }

const Adversarial = Graph.construct("adversarial-review")
  .fork(DetectSmells, BreakEscapes)
    // { srcPaths, testPaths } → { smells }
    //   ∥   { srcPaths, testPaths, command } → { rated, verdict, escapeSpec? }
  .finalise()
    // outside: { srcPaths, testPaths, command } → { smells, rated, verdict, escapeSpec? }
    // the two lanes never combine: smells rides along to write-summary untouched, verdict alone gates the tdd-lane loop

const TddLane = Graph.construct("tdd-lane")
  .loop(TestPlan, RedGreen, Verification, DiffSinceBase, Adversarial, {
    // TestPlan: { discoverPath, spec } → { plan }, one red test per behaviour, each naming the bug it catches
    //   spec = the acs on the first round, the routed escape on every round after — see gaps, on how the acs
    //   actually reaches here
    // RedGreen: { plan } → { headSha } !DeadTestAtBirth | HarnessError | TestDisputed | PathsTouched | StillRed
    // Verification: { headSha } → (gate: the repo's declared suite passes; command read from R) !VerificationFailed
    //   a red run here dies immediately, no repair resume — unlike outer-review's own verification below, see gaps
    // DiffSinceBase: { headSha, base } → { srcPaths, testPaths, command }, base..HEAD paths not declared as tests;
    //   command is the probe verify-escapes runs per claim, read from R here and handed downstream as data
    // Adversarial: { srcPaths, testPaths, command } → { smells, rated, verdict, escapeSpec? }
    //   verdict.maxSeverity < 2: exits the loop carrying { rated, plan, smells } toward write-summary
    //   verdict.maxSeverity ≥ 2, rounds ≤ cap: escapeSpec feeds back as next round's spec
    feedback: Adversarial.escapeSpec -> TestPlan.spec,
    until: Adversarial.verdict.maxSeverity < 2,
    cap: TDD_ROUND_CAP,   // round cap, policy
  })
  .onCap(die(TddBuildEscapeUnresolved))
    // maxSeverity still ≥ 2 when the cap is spent: headSha kept, the worst unresolved escape named
  .finalise()
    // outside: { discoverPath, spec, base } → { headSha, rated, plan, smells }
    //   !DeadTestAtBirth | HarnessError | TestDisputed | PathsTouched | StillRed | VerificationFailed | TddBuildEscapeUnresolved

const OuterReview = Graph.construct("outer-review")
  .loop(Simplify, Verification2, ReviewDiff, {
    // Simplify: { headSha, base } → { headSha }, reduces the diff to the same behaviour in less code, commits
    // Verification2: { headSha } → (gate, re-run only when Simplify actually moved HEAD; command read from R)
    //   red, repairs ≤ cap: resumes the head's own producer against the report, report → addendum,
    //     shares this loop's own cap
    //   red, cap spent or no producer to resume: dies !VerificationFailed, reportPath kept for a human to repair
    // ReviewDiff: { headSha, base, ticket, title, body } → verdict, adversarial read of the whole diff against the ticket
    //   clean: { headSha } → exits the loop
    //   findings, sendbacks ≤ cap: { findingsPath } → feedback to a resumed build session; that session either
    //     answers with a new headSha (feeding back into Simplify) or disputes, which re-invokes ReviewDiff itself,
    //     adjudicating: { headSha, findingsPath, disputePath } → verdict
    //       adjudicated clean: exits the loop; rejected: dies !ReviewDisputeRejected, the byte-identical tree kept
    //   findings, sendbacks > cap: dies, findings and headSha both kept
    feedback: ReviewDiff.findingsPath -> Simplify.findingsPath,
    until: ReviewDiff.verdict === "clean",
    cap: OUTER_REVIEW_CAP,   // send-back cap, policy
  })
  .onCap(die(ReviewBlocked))
  .finalise()
    // outside: { headSha, base, ticket, title, body } → { headSha } !VerificationFailed | ReviewDisputeRejected | ReviewBlocked

const Terseness = Graph.construct("terseness")
  .then(PromptTerseness)
    // { headSha } → { headSha, moved }, rewrites verbose prompt text on the branch as one-liners,
    // commits only if it changed something
  .when(PromptTerseness.moved, ReverifyTerse)
    // { headSha } → { headSha }, re-runs the suite over the terse head (command read from R)
    // moved = false: ReverifyTerse never runs, headSha passes through unchanged
    // no failure edge is drawn off this node in the vision, though it is the same suite run as Verification2 
    // above, which does die on failure — see gaps
  .finalise()
    // outside: { headSha } → { headSha }

const PublishTail = Graph.construct("publish-tail")
  .fork(WritePrBody, PushBranch)
    // { headSha, base } → { body } !PrBodyRunRootMissing !PrBodyGitFailed !PrBodyDiffWriteFailed
    //   ∥   { branch, base } → { source } !PushDirty !PushEmpty !PushRejected
  .join(CreatePr)
    // { body, source, base, ticket, title } → { url } !CreatePrFailed !UnsupportedHost
  .when(worktree, WorktreeRemove)
    // { path, url } → { url } !WorktreeRemoveFailed, success-only, retires the worktree Checkout made
    // false: skipped entirely, url passes through unchanged
  .finalise()
    // outside: { headSha, base, branch, ticket, title, path } → { url: prUrl }
    //   !PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed | PushDirty | PushEmpty | PushRejected
    //   | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed

const TddBuild = Graph.construct("tdd-build")
  .borrow(Prepare)
    // { base?, ticket } → { base, ticket, title, body, branch }
    //   !AcceptanceCriteriaMissing | BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable
    //   | TicketNotAddressable | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable | MissingTicketId
  .borrow(Checkout)
    // { base, branch } → { path } !WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
  .borrow(Discover)
    // { title, body } → { discoverPath } !DiscoverNoteMissing
  .borrow(TddLane)
    // { discoverPath, spec, base } → { headSha, rated, plan, smells }
    //   !DeadTestAtBirth | HarnessError | TestDisputed | PathsTouched | StillRed | VerificationFailed | TddBuildEscapeUnresolved
    //   spec's acs source is the gap flagged on prepare's require-acs, above
  .then(WriteSummary)
    // { rated, plan, smells } → { summaryPath }, one section per round: plan, escapes, smells
    // "per round" implies this node holds every round's own triple, not just the loop's last — whether tdd-lane
    // accumulates across rounds or hands this only the final one is undecided, see gaps
  .borrow(OuterReview)
    // { headSha, base, ticket, title, body } → { headSha } !VerificationFailed | ReviewDisputeRejected | ReviewBlocked
  .borrow(Terseness)
    // { headSha } → { headSha }
  .borrow(PublishTail)
    // { headSha, base, branch, ticket, title, path } → { url: prUrl }
    //   !PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed | PushDirty | PushEmpty | PushRejected
    //   | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed
  .finalise()
    // outside: { ticket, base?, worktree?, agent? } → { prUrl, branch, commits, rounds, escapes, reviewPasses, sessions, costUsd }
    //   !AcceptanceCriteriaMissing | BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable
    //   | TicketNotAddressable | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable
    //   | MissingTicketId | WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
    //   | DiscoverNoteMissing
    //   | DeadTestAtBirth | HarnessError | TestDisputed | PathsTouched | StillRed | VerificationFailed
    //   | TddBuildEscapeUnresolved | ReviewDisputeRejected | ReviewBlocked
    //   | PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed
    //   | PushDirty | PushEmpty | PushRejected | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed
    // rounds/escapes/reviewPasses reaching OUT is this vision's own choice, not read off write-summary's shape — see gaps
```

Gaps flagged, not patched:
- **`require-acs`'s criteria never reaches `test-plan`.** The vision draws `RequireAcs` computing acceptance criteria only to gate `FormatBranchName`; the tdd lane's own subgraph label says a round's `spec` is "acs then the routed escape," but no edge carries the criteria text out of `prepare` at all. Whether `require-acs` should output it as a real field threaded through checkout and discover into the lane, or the lane re-fetches it itself, is undecided.
- **The tdd lane's own `verification` has no repair loop**, unlike `outer-review`'s. This is the vision's own flagged gap, carried forward unresolved: whether a red whole-suite result this early is a wiring problem (immediate death is correct) or deserves the same resumed-session repair as `outer-review`'s verification is a ruling this sketch does not make.
- **`rounds`, `escapes`, `reviewPasses` reaching `OUT`**, and **whether `write-summary` sees every round's triple or only the loop's last one**, are both the vision's own flagged gap about what the loop actually accumulates versus what only its final iteration carries forward. Neither this sketch nor the vision decides it.
- **The loop caps** (`red-loop`, `green-loop`, `tdd-lane`'s own round cap, `outer-review`'s send-back cap), **the breaker fan-out's width**, and **the two suite commands** (the whole-suite `command`, the per-path probe `verify-escapes` runs) are named throughout as read from configuration, with no stated value — policy, not shape, exactly as the vision's own gap note says.
- **A breaker's own failure is drawn here as isolated** (the rest of the fan-out still reaches `verify-escapes`), matching how `design-graph`'s `verify-visions` fan-out isolates a branch's own retry. The vision never states this either way for `break`; the choice above is this sketch's own, not sourced.
- **`checkout`, `discover`, and `publish-tail`'s error tags are assumed identical to `develop-graph`'s and `design-graph`'s own rail-sketches.** The tdd-build vision draws these boxes with the same labels and the same "every branch, checkout, worktree and PR step" framing but states none of their tags itself; this sketch borrows the sibling sketches' vocabulary rather than inventing fresh ones, on the assumption they are the same nodes reused, not new ones.
- **`review-diff`'s dispute-and-adjudicate path is folded into its own comment**, the way `develop-graph`'s equivalent loop folds `Verification`'s repair-resume without a separate drawn part. The tdd-build vision draws `build (resume)` twice as distinct boxes (`BRES` for review findings, `BREP` for verification reports) with their own labels; this sketch treats both as the same class of resumed-session repair `develop-graph` already established, rather than declaring two new loop parts. Whether they are really one dispatch shape or two genuinely different ones is undecided.
- **`prompt-terseness-evaluator`'s re-verify (`ReverifyTerse`) has no drawn failure edge**, though it runs the identical suite `Verification` and `Verification2` both die on when red. Whether that is a real asymmetry or an omission in the diagram is undecided.
- **`agent?` on the outside input is never wired to a node in the diagram.** Every model-dispatched node above (`test-plan`, `write-red`, `implement`, `break`, `judge-severity`, `simplify`, `review-diff`, `prompt-terseness-evaluator`) is written assuming it reads this field to select its underlying agent, but the vision states only that the field exists on `IN`, not which nodes consume it or what a missing value defaults to.
