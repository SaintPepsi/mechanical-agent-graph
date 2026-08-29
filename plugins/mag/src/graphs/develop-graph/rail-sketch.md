```ts
// develop-graph, outside: { ticket, base?, worktree?, verification?, worktreeSetup? } →
//   Effect<{ ticket, branch, summaryPath, commits, reviewPasses, sessions, costUsd, prUrl },
//     BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable
//     | TicketNotAddressable | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable
//     | MissingTicketId | WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
//     | DesignPromptOversized | NotationDeclaredFailure | VisionUnverified | DiscoverNoteMissing
//     | BuildWorkdirDirty | BuildNoCommits | BuildHeadMoved | BuildGitFailed | BuildCommitFailed | BuildSummaryEmpty
//     | VerificationFailed | ReviewDisputeRejected | SendbacksExhausted
//     | PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed
//     | PushDirty | PushEmpty | PushRejected | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed>

const Prepare = Graph.construct("prepare")
  .fork(ResolveBase, FetchTicket)
    // { base? } → { base } !BaseRefMissing !BaseRemoteMissing !BaseRemoteUnavailable
    //   ∥   { ticket } → { ticket, title, body } !TicketNotAddressable !TicketNotMaintainerAuthored !EmptyTicket !TrackerFailed !TrackerUnreachable
  .then(RequireAcs)
    // { ticket, title, body } → discarded !AcceptanceCriteriaMissing — the gate: refuse before anything spends
  .join(FormatBranchName)
    // { ticket, title } → { branch } !MissingTicketId
  .finalise()
    // outside: { base?, ticket } → { base, ticket, title, body, branch }
    //   !BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable | TicketNotAddressable
    //   | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable
    //   | AcceptanceCriteriaMissing | MissingTicketId
    // uncaught failure here dies with nothing kept: no worktree exists yet

const Checkout = Graph.construct("checkout")
  .when(worktree, WorktreeAdd)
    // { base, worktreeSetup? } → { path } !WorktreeAddFailed !WorktreeSetupFailed
    // default true; materializes a detached worktree and runs the setup command, once
    // false skips this node entirely — path stays absent, CheckoutBranch operates on base directly
  .then(CheckoutBranch)
    // { base, branch, path? } → { path } !BranchCheckoutFailed !BranchCreateFailed
    // resume-safe: re-enters an existing checkout of `branch` rather than recreating it
    // gated to start only once WorktreeAdd's path exists, when worktree = true
  .finalise()
    // outside: { base, branch, worktreeSetup? } → { path }
    //   !WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
    // uncaught failure from here through publish-tail dies with the worktree kept, for a human

const WriteBody = Graph.construct("write-body")
  .then(WritePrBody)
    // { headSha, base } → { description } !PrBodyRunRootMissing !PrBodyGitFailed !PrBodyDiffWriteFailed
    // describes the branch's own merge-base diff; gated to start only once ReviewDiff's verdict is clean
  .then(ComposePrBody)
    // { description } → { body }
    // appends "Closes #n" and the run id; yields RunContext { ticket, runId } from R, never threaded as a parameter
  .finalise()
    // outside: { headSha, base } → { body } !PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed

const BuildUnderReview = Graph.construct("build-under-review")
  .loop(Build, Verification, Simplify, ReviewDiff, {
    // Build: { headSha, ticket, branch, planPath } → { headSha }
    //   implements the plan, or answers ReviewDiff's own standing findings on a send-back;
    //   the plan is the whole brief — never the ticket, whose criteria the plan quotes, and
    //   never designPath — the design is the plan's input and nothing else's;
    //   ticket is the id alone, for the salvage commit's subject
    //   !BuildWorkdirDirty !BuildNoCommits !BuildHeadMoved !BuildGitFailed !BuildCommitFailed !BuildSummaryEmpty
    //   (verdict not disputed)
    skip: {
      from: Build, when: "verdict = disputed",
      to: ReviewDiff, carrying: { headSha, findingsPath, disputePath },
      // Build itself judges the last findings meritless and raises a dispute instead of a fix;
      // Verification and Simplify never run this pass
    },
    // Verification: { headSha, command } → (gate: tree is green)
    //   red: repairs by resuming the session that produced headSha, report → addendum (shares
    //   this loop's own cap); cap spent or no session to resume: !VerificationFailed
    // Simplify: { headSha, base } → { headSha }, re-verified only when it moved HEAD (a condition on
    //   this edge alone), a red re-verify repairs the same way, resuming Simplify's own session
    //   strips what Build added but the plan never asked for
    // ReviewDiff: { headSha, base, ticket, title, body } → verdict
    //   or, on Build's dispute: { headSha, findingsPath, disputePath } → verdict, adjudicating instead of reviewing
    //   clean: { summaryPath, commits, reviewPasses, sessions, costUsd } → exits the loop
    //   blocked, not disputed, sendbacks < cap: { findingsPath } → feedback to Build
    //   blocked, disputed, adjudication rejects the dispute: die(ReviewDisputeRejected)
    feedback: ReviewDiff.findingsPath → Build.findingsPath,   // blocked, not disputed, sendbacks < cap
    until: ReviewDiff.verdict === "clean",
    cap: REVIEW_CAP,   // send-backs; value is policy, left to configuration
  })
  .onCap(die(SendbacksExhausted))
    // blocked, cap exhausted, not disputed: findingsPath stays uncommitted on the tree
  .finalise()
    // outside: { headSha, ticket, title, body, branch, planPath, command } →
    //   { headSha, summaryPath, commits, reviewPasses, sessions, costUsd }
    //   !BuildWorkdirDirty | BuildNoCommits | BuildHeadMoved | BuildGitFailed | BuildCommitFailed | BuildSummaryEmpty
    //   | VerificationFailed | ReviewDisputeRejected | SendbacksExhausted

const PublishTail = Graph.construct("publish-tail")
  .fork(WriteBody, PushBranch)
    // { headSha, base } → { body } !PrBodyRunRootMissing !PrBodyGitFailed !PrBodyDiffWriteFailed
    //   ∥   { branch, base } → { source } !PushDirty !PushEmpty !PushRejected (push with upstream tracking set)
  .join(CreatePr)
    // { body, source, base, ticket, title } → { url } !CreatePrFailed !UnsupportedHost
    // title composed as "{ticket}: {title}"; opens the PR, or returns the one already open for this branch
  .when(worktree, WorktreeRemove)
    // { path, url } → { url } !WorktreeRemoveFailed
    // success-only tail, gated to start only once CreatePr succeeds; retires the worktree WorktreeAdd created
    // false skips this node entirely — url passes through unchanged
  .finalise()
    // outside: { headSha, base, branch, ticket, title, path } → { url: prUrl }
    //   !PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed | PushDirty | PushEmpty | PushRejected
    //   | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed

const DevelopGraph = Graph.construct("develop-graph")
  .borrow(Prepare)
    // { base?, ticket } → { base, ticket, title, body, branch }
    //   !BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable | TicketNotAddressable
    //   | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable | MissingTicketId
  .borrow(Checkout)
    // { base, branch, worktreeSetup? } → { path } !WorktreeAddFailed | WorktreeSetupFailed | BranchCheckoutFailed | BranchCreateFailed
  .borrow(DesignGraph)
    // { ticket, title, body } → { designPath, planPath, discoverPath, headSha }
    //   !DesignPromptOversized | NotationDeclaredFailure | VisionUnverified | DiscoverNoteMissing
    // gated to start only once CheckoutBranch's path exists: design writes and commits on this checkout, not before
  .borrow(BuildUnderReview)
    // { headSha, ticket, title, body, branch, planPath, command } → { headSha, summaryPath, commits, reviewPasses, sessions, costUsd }
    //   !BuildWorkdirDirty | BuildNoCommits | BuildHeadMoved | BuildGitFailed | BuildCommitFailed | BuildSummaryEmpty
    //   | VerificationFailed | ReviewDisputeRejected | SendbacksExhausted
  .borrow(PublishTail)
    // { headSha, base, branch, ticket, title, path } → { url: prUrl }
    //   !PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed | PushDirty | PushEmpty | PushRejected
    //   | CreatePrFailed | UnsupportedHost | WorktreeRemoveFailed
  .finalise()

// A repo whose tracker, remote, or PR host differ bends the borrow at the site, never forks it:
const DevelopGenericRepo = Graph.construct("develop-generic-repo")
  .borrow(DevelopGraph)
    .replaceNode(FetchTicket, FetchTicketFromRepoPolicy)
    .replaceNode(ResolveBase, ResolveBaseFromRepoPolicy)
    .replaceNode(CreatePr, CreatePrFromRepoPolicy)
  .finalise()
```

Gaps flagged, not patched:
- `resolve-base`'s remote, `fetch-ticket`'s tracker identity, `publish-tail`'s PR host, and the build agent every `Build`/`Simplify`/`ReviewDiff` dispatch are drawn above as fixed behind those nodes, not as fields on `develop-graph`'s input. `DevelopGenericRepo`'s three `.replaceNode` calls are one plausible shape for a second target repo, but whether that's really per-repo policy read some other way, or fields threaded on `IN` alongside `base`/`verification`/`worktreeSetup`, is undecided. A fourth `.replaceNode` at that borrowing site is a refusal, not a signal: the guard fails Finalise, and the generic case needs its own graph instead.
- The loop's cap-exhausted exit has no name in the vision: the diagram draws `findingsPath → (escalates)` with no tag, next to a dispute-rejected exit that is named (`ReviewDisputeRejected`). `SendbacksExhausted` above is invented for this sketch to keep the error union closed; it is not sourced from the vision and needs a ruling on its real name, or confirmation it should collapse into an existing tag instead.
- `REVIEW_CAP` (the loop's send-back bound), the per-node model assignment (`opus` for `design-graph`/`Simplify`/`ReviewDiff`, `sonnet` for `Build`/`WritePrBody`), and the default `verification`/`worktreeSetup` commands are named above as configuration the relevant nodes read, with no value stated — policy, not shape.
- `design-graph`'s own internal gaps (single-dispatch-vs-per-notation, `RetryVision`'s scoped-prompt producer, `NotationDeclaredFailure`'s exact death timing) live in that graph's own rail-sketch and are not repeated here; this drawing only borrows the box.
