```mermaid
graph TD
  IN[["conflict-graph(ticket, target, base?, verification?, worktreeSetup?)"]]
  OUT[["{ ticket, target, base, conflicts, resolved, headSha, sessions, costUsd, pushed }"]]

  subgraph Prepare["prepare · no worktree yet"]
    RB["resolve-base · Mechanical<br/>pin the base ref's tip, locally and on the remote"]
    DC["detect-conflicts · Mechanical<br/>probe base's tip against target's tip; name the paths if they truly conflict"]
  end
  IN -- "base? → base?" --> RB
  IN -- "target → target" --> DC
  RB -- "base → base" --> DC
  RB -. "fails: BaseRefMissing | BaseRemoteMissing | BaseRemoteUnavailable" .-> DEADPRE
  DC -. "fails: TargetRefMissing | ConflictProbeFailed" .-> DEADPRE

  DEADPRE[/"die: prepare-stage error, uncaught<br/>kept: nothing — no worktree exists yet"/]

  DC -- "verdict = clean: targetSha → headSha, (resolved = false, sessions = [], costUsd = 0)" --> OUT

  subgraph Open["open-the-merge · conflicted path only"]
    WA["worktree-add · Mechanical<br/>materialize an isolated worktree checked out on target's existing tip, run the setup command"]
    SM["start-merge · Mechanical<br/>begin merging base into the checked-out worktree; conflict markers land in the tree, unmerged paths named"]
  end
  DC -- "verdict = conflicted: target, targetSha → target, targetSha" --> WA
  IN -- "worktreeSetup? → setup" --> WA
  WA -- "path → (gate: the merge starts inside this worktree)" --> SM
  RB -- "base → base" --> SM
  DC -- "baseSha → baseSha" --> SM
  WA -. "fails: WorktreeAddFailed | WorktreeSetupFailed" .-> DEADTREE
  SM -. "fails: MergeWithoutConflict | MergeStartFailed" .-> DEADTREE

  DEADTREE[/"die: open-through-finish error, uncaught<br/>kept: the worktree, for a human"/]

  subgraph Loop["resolve-under-verification · loop, cap = RESOLVE_CAP attempts"]
    RSV["resolve · Model<br/>dispatch the conflict-resolver agent at the live unmerged paths, or the prior attempt's findings; stage each file it resolves"]
    STC["stage-check · Mechanical<br/>prove no unmerged paths and no leftover conflict markers remain on the staged tree, compute the tree's own id"]
    VER["verify · Mechanical<br/>run the declared suite against the staged tree; exit code is the verdict"]
  end
  SM -- "paths → paths" --> RSV
  RSV -- "(gate: the resolver's attempt is staged)" --> STC
  STC -- "clean stage: treeSha → headSha" --> VER
  IN -- "verification? → command" --> VER
  STC -. "unresolved paths or markers left, attempts < cap: detail → findings" .-> RSV
  VER -. "verdict = failed, attempts < cap: output → findings" .-> RSV
  STC -. "unresolved paths or markers left, attempts = cap: detail → (escalates)" .-> DEADTREE
  VER -. "verdict = failed, attempts = cap: output → (escalates)" .-> DEADTREE

  subgraph Finish["finish · clean verdict only"]
    CM["commit-merge · Mechanical<br/>commit the verified, staged tree; two parents, one session trailer per resolve attempt"]
    PB["push-branch · Mechanical<br/>push target's new merge commit to the remote"]
    WR["worktree-remove · Mechanical<br/>retire the worktree, success only"]
  end
  VER -- "verdict = passed → (gate)" --> CM
  RSV -- "sessions, costUsd → sessions, costUsd" --> CM
  RB -- "base → base" --> CM
  CM -- "headSha, sessions, costUsd → headSha, sessions, costUsd" --> OUT
  CM -- "(gate: the merge is committed)" --> PB
  RB -- "base → base" --> PB
  PB -. "fails: PushDirty | PushEmpty | PushRejected" .-> DEADTREE
  PB -- "(gate: pushed) → pushed" --> WR
  WA -- "path → path" --> WR
  WR -. "fails: WorktreeRemoveFailed" .-> DEADTREE
  WR -- "(gate: worktree retired) → pushed" --> OUT

  IN -- "ticket → ticket" --> OUT
  IN -- "target → target" --> OUT
  RB -- "base → base" --> OUT
  DC -- "conflicts → conflicts" --> OUT
  WR -- "(gate) → (resolved = true)" --> OUT
```

Gaps flagged, not patched:
- `RESOLVE_CAP` (the resolve-loop's attempt bound), the declared verification command's default, and the resolver's hardwired agent/model (`merge-conflict-resolver`, a stronger-than-default model — a resolution with no design and no test to check it against, and picking wrong silently discards someone's work) are policy, not shape — the diagram names `verification?` as an input and leaves the rest to configuration, the same way the sibling develop-graph vision's loop cap does.
- What `findings` carries on a loop-back — `stage-check`'s marker/unmerged detail and `verify`'s suite output are drawn as the same field name, but whether the resolver's next dispatch also needs the prior attempt's own session continued (same conversation) or starts fresh each time is undecided.
- `push-branch`'s rejection is drawn as a death (`PushRejected`), matching the sibling graphs' precedent, but whether a stale local base — the remote moved while this run was resolving — should instead trigger a fresh `detect-conflicts` pass rather than dying is a ruling this vision leaves open.
