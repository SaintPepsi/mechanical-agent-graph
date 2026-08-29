```mermaid
graph TD
  IN[["develop-graph(ticket, base?, worktree?, verification?, worktreeSetup?)"]]
  OUT[["{ ticket, branch, summaryPath, commits, reviewPasses, sessions, costUsd, prUrl }"]]

  subgraph Prepare["prepare · parallel, no data dependency between them"]
    RB["resolve-base · Mechanical<br/>verify the run's base exists locally and on the remote"]
    FT["fetch-ticket · Mechanical<br/>the tracker's maintainer-authored title and body"]
  end
  IN -- "base? → base" --> RB
  IN -- "ticket → ticket" --> FT
  RB -. "fails: BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable" .-> DEADPRE
  FT -. "fails: TicketNotAddressable | TicketNotMaintainerAuthored | EmptyTicket | TrackerFailed | TrackerUnreachable" .-> DEADPRE

  FBN["format-branch-name · Mechanical<br/>compute the ticket's branch name"]
  FT -- "ticket, title → ticket, title" --> FBN
  FBN -. "fails: MissingTicketId" .-> DEADPRE

  DEADPRE[/"die: prepare-stage error, uncaught<br/>kept: nothing — no worktree exists yet"/]

  subgraph Checkout["checkout · worktree = true is the default"]
    WA["worktree-add · Mechanical<br/>materialize a detached worktree, run the setup command"]
    BR["branch · Mechanical<br/>resume-safe checkout of the ticket branch"]
  end
  RB -- "worktree = true (default): base → base" --> WA
  IN -- "worktreeSetup? → setup" --> WA
  RB -- "worktree = false: base → base" --> BR
  WA -- "path → (gate: run continues inside the worktree)" --> BR
  FBN -- "branch → branch" --> BR
  RB -- "base → base" --> BR
  WA -. "fails: WorktreeAddFailed | WorktreeSetupFailed" .-> DEADTREE
  BR -. "fails: BranchCheckoutFailed | BranchCreateFailed" .-> DEADTREE

  DG[["design-graph · borrowed whole<br/>probes → envision-shell ∥ discover → design-under-review (brainstorm → recycle-scan → plan → review-plan, findings sent back into the design)"]]
  FT -- "ticket, title, body → ticket, title, body" --> DG
  BR -- "branch → (gate: design writes on this checkout, and commits here too under records = committed)" --> DG
  DG -. "fails: DesignPromptOversized | NotationDeclaredFailure | VisionUnverified | DiscoverNoteMissing | RecycleMapMissing | DesignMissing | PlanMissing | PlanBlocked (cap spent) | PlanDisputeRejected" .-> DEADTREE

  PTE["prompt-terseness-evaluator · Model<br/>rewrite verbose prompt text the run wrote — the build's included — and commit the repair; a moved head re-runs the declared suite"]
  RB -- "base → base" --> PTE
  FT -- "ticket → ticket" --> PTE
  PTE -. "fails: TersenessWorkdirDirty | TersenessHeadMoved | TersenessCommitFailed | TersenessGitFailed" .-> DEADTREE

  subgraph Loop["build-under-review · loop, cap = REVIEW_CAP send-backs"]
    B["build · Model<br/>implement the plan, or answer the standing findings"]
    V["verification · Mechanical<br/>the repo's declared suite; exit code is the verdict"]
    S["simplify · Model<br/>remove what build added but the plan never asked for"]
    RD["review-diff · Model<br/>adversarial read of the diff, or adjudicate a build's own dispute"]
  end
  DG -- "headSha → (gate: build starts from the designed tree)" --> B
  FT -- "ticket → ticket (the id alone, for the salvage commit's subject: build reads no ticket)" --> B
  FBN -- "branch → branch" --> B
  DG -- "planPath → planPath (the builder's whole contract, never designPath: the design is the plan's input and nothing else's)" --> B
  B -- "headSha → headSha" --> V
  IN -- "verification? → command" --> V
  V -- "command → (gate: tree is green)" --> S
  V -. "red: repairs by resuming the session that produced headSha, report → addendum (shares this loop's own cap)" .-> B
  RB -- "base → base" --> S
  S -- "headSha → headSha (re-verified only when simplify moved HEAD; a red re-verify repairs the same way)" --> RD
  RB -- "base → base" --> RD
  FT -- "ticket, title, body → ticket, title, body" --> RD
  B -. "verdict = disputed: headSha, findingsPath, disputePath → headSha, findingsPath, disputePath" .-> RD
  RD -. "verdict = blocked, sendbacks < cap: findingsPath → findingsPath" .-> B
  B -. "fails (not disputed): BuildWorkdirDirty | BuildNoCommits | BuildHeadMoved | BuildGitFailed | BuildCommitFailed | BuildSummaryEmpty" .-> DEADTREE
  V -. "fails, repairs spent or no session to resume: VerificationFailed" .-> DEADTREE
  RD -. "verdict = blocked, cap exhausted: findingsPath → (escalates)" .-> DEADTREE
  RD -. "adjudicating pass rejected: ReviewDisputeRejected → (escalates)" .-> DEADTREE

  subgraph Publish["publish-tail · clean review verdict only"]
    WPB["write-pr-body · Model<br/>describe the branch's own merge-base diff"]
    PRB["compose-pr-body · Mechanical<br/>append Closes #n and the run id to the written description"]
    PB["push-branch · Mechanical<br/>push with upstream tracking set"]
    CPR["create-pr · Mechanical<br/>open the PR, or return the one already open"]
    WR["worktree-remove · Mechanical<br/>retire the worktree, success only"]
  end
  RD -- "verdict = clean: headSha → headSha" --> PTE
  PTE -- "headSha → (gate: the description covers the terse tree)" --> WPB
  RB -- "base → base" --> WPB
  WPB -- "description → description" --> PRB
  IN -- "ticket → (R channel: ticket, runId)" --> PRB
  PRB -- "body → body" --> CPR
  FBN -- "branch → branch" --> PB
  RB -- "base → base" --> PB
  PB -- "branch → source" --> CPR
  RB -- "base → base" --> CPR
  FT -- "ticket, title → title (composed: '{ticket}: {title}')" --> CPR
  WPB -. "fails: PrBodyRunRootMissing | PrBodyGitFailed | PrBodyDiffWriteFailed" .-> DEADTREE
  PB -. "fails: PushDirty | PushEmpty | PushRejected" .-> DEADTREE
  CPR -. "fails: CreatePrFailed | UnsupportedHost" .-> DEADTREE

  CPR -- "worktree = true: url → (gate)" --> WR
  WA -- "path → path" --> WR
  WR -. "fails: WorktreeRemoveFailed" .-> DEADTREE

  DEADTREE[/"die: checkout-through-publish error, uncaught<br/>kept: the worktree, for a human"/]

  FT -- "ticket → ticket" --> OUT
  FBN -- "branch → branch" --> OUT
  RD -- "verdict = clean: summaryPath, commits, reviewPasses, sessions, costUsd → summaryPath, commits, reviewPasses, sessions, costUsd" --> OUT
  CPR -- "worktree = false: url → prUrl" --> OUT
  WR -- "worktree = true: (gate) → prUrl" --> OUT
```

Gaps flagged, not patched:
- `resolve-base`'s `remote`, `fetch-ticket`'s `maintainer`, `publish`'s `host`/`slug`, and the `effect-expert` agent every session dispatches are today's hardwired constants for this repo alone — none of them are fields on `IN`. Running this same drawing against a consuming/generic repo too needs somewhere that repo's own remote, tracker identity, PR host, or build agent come from, and nothing here names it. Whether they join `base`/`verification`/`worktreeSetup` as run inputs, or stay repo-declared policy read from somewhere else, needs a ruling before a second target repo can run this graph.
- `REVIEW_CAP` (the loop's send-back bound), the per-node model assignments (`opus` for design/simplify/review, `sonnet` for build/write-pr-body), and the verification/worktree-setup command defaults are policy, not shape — the diagram names that they exist as inputs to the nodes that use them and leaves their values to configuration, the same way the worked example's loop cap does.
- `design-graph`'s own internal gaps (the single-dispatch-vs-per-notation question, `retry-vision`'s scoped-prompt producer, `NotationDeclaredFailure`'s exact death timing) live in `graphs/design-graph/vision.md` and are not repeated here — this drawing only borrows the box.
