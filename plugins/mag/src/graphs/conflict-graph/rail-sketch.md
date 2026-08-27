```ts
// conflict-graph, outside: { ticket, target, base?, verification?, worktreeSetup? } → Effect<
//   { ticket, target, base, conflicts, resolved, headSha, sessions, costUsd, pushed },
//   BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable | TargetRefMissing | ConflictProbeFailed
//   | WorktreeAddFailed | WorktreeSetupFailed | MergeWithoutConflict | MergeStartFailed
//   | <resolve-cap escalation, untitled> | PushDirty | PushEmpty | PushRejected | WorktreeRemoveFailed>

const Prepare = Graph.construct("prepare")
  .then(ResolveBase)        // { base? } → { base } !BaseRefMissing !BaseRemoteMissing !BaseRemoteUnavailable
  .then(DetectConflicts)    // { target, base } → { conflicts, verdict, targetSha, baseSha } !TargetRefMissing !ConflictProbeFailed
  .finalise()                // { ticket, target, base? } → { conflicts, verdict, targetSha, baseSha }
                              // a failure anywhere in this part keeps nothing: no worktree exists yet

const OpenTheMerge = Graph.construct("open-the-merge")
  .then(WorktreeAdd)         // { target, targetSha, setup? } → { path } !WorktreeAddFailed !WorktreeSetupFailed
  .then(StartMerge)          // { base, baseSha } → { paths } !MergeWithoutConflict !MergeStartFailed, (gate: runs inside the worktree WorktreeAdd just materialized)
  .finalise()                // { target, targetSha, base, baseSha, setup? } → { path, paths }
                              // from here on, a failure in any later part leaves this worktree standing, for a human

const ResolveUnderVerification = Graph.construct("resolve-under-verification")
  .loop(Resolve, StageCheck, Verify, {
    // Resolve: Model, dispatches the conflict-resolver agent at the live unmerged paths on the first pass,
    //   or at the prior attempt's findings on a retry; stages every file it resolves
    // StageCheck: Mechanical, proves no unmerged paths and no leftover conflict markers remain staged
    // Verify: Mechanical, runs the declared suite against the staged tree
    feedback: [StageCheck.findings, Verify.output] → Resolve.findings,   // either source retries with its own detail
    until: StageCheck.verdict === "clean" && Verify.verdict === "passed",
    cap: RESOLVE_CAP,
  })
  .onCap(die(<resolve-cap escalation, untitled>))   // worktree left standing; no dispute/recovery arm is drawn here
  .finalise()   // { paths, command } → { headSha, sessions, costUsd }

const Finish = Graph.construct("finish")
  .then(CommitMerge)         // { headSha, sessions, costUsd, base } → { headSha, sessions, costUsd }
  .then(PushBranch)          // { base } → { pushed } !PushDirty !PushEmpty !PushRejected, (gate: the merge is committed)
  .then(WorktreeRemove)      // { path } → { resolved: true } !WorktreeRemoveFailed, (gate: pushed) — success only; every failure above leaves the worktree standing
  .finalise()   // { headSha, sessions, costUsd, base, path } → { headSha, sessions, costUsd, pushed, resolved }

const ConflictGraph = Graph.construct("conflict-graph")
  .borrow(Prepare)
  .branch(Prepare.verdict, {
    clean: exit({ headSha: Prepare.targetSha, resolved: false, sessions: [], costUsd: 0 }),   // conflicts, ticket, target, base already ride the envelope
    conflicted: continue,
  })
  .borrow(OpenTheMerge)
  .borrow(ResolveUnderVerification)
  .borrow(Finish)
  .finalise()
```

Gaps flagged, not patched:
- `RESOLVE_CAP`'s value, the declared verification command's default, and the resolver's hardwired agent/model are policy, not shape — named here as inputs and a symbolic cap, left to configuration, same as the sibling develop-graph loop.
- The resolve-loop's cap-exceeded escalation carries no named error tag anywhere in the vision. `.onCap(die(...))` needs a real closed-union member to compile; `<resolve-cap escalation, untitled>` marks the slot rather than guessing one, since a wrong guess would silently become the answer.
- Whether `Resolve`'s retry dispatch continues the prior attempt's own agent session or starts fresh each time is undrawn; `feedback` here only says which detail travels back, not whether the conversation does.
- `PushBranch`'s rejection is drawn as a die, worktree kept for a human — matching the sibling graphs' precedent. Whether a stale local base (the remote moved mid-run) should instead re-enter `detect-conflicts` rather than die is left open by the vision, not by this sketch.
