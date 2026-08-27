```mermaid
graph TD
  IN[["design(ticket, title, body)"]]
  OUT[["{ designPath, visionPaths, discoverPath }"]]

  subgraph Probes["probes · parallel, no ticket dependency"]
    PS["detect-svelte · Mechanical<br/>manifest walk for a svelte dependency"]
    PE["detect-effect · Mechanical<br/>manifest walk for an effect dependency"]
    PG["detect-graph-core · Mechanical<br/>root manifest names this repository"]
  end

  ASM["assemble-brainstorm-prompt · Mechanical<br/>compose core + matched envisioning modules, no match falls back to generic; enforce the size budget"]
  PS -- "stack, matched → verdicts[]" --> ASM
  PE -- "stack, matched → verdicts[]" --> ASM
  PG -- "stack, matched → verdicts[]" --> ASM
  ASM -. "bytes > budget: bytes, modules → bytes, modules" .-> DEADSIZE[/"die: DesignPromptOversized<br/>kept: nothing — no artifact written, worktree untouched"/]

  DS["design-session · Model<br/>write the design doc plus one vision file per matched notation, declare a verdict per notation"]
  IN -- "ticket, title, body → ticket, title, body" --> DS
  ASM -- "promptPath, modules → promptPath, matchedStacks" --> DS

  subgraph Verify["verify-visions · parallel, one branch per matched notation"]
    CHK["check-vision · Mechanical<br/>declared verdict + file exists non-empty, checked against this node's own expected path"]
    RETRY["retry-vision · Model<br/>regenerate this one notation's vision alone"]
    CHK2["recheck-vision · Mechanical<br/>same check, second and final pass"]
  end

  DS -- "visions[].stack, visions[].visionPath, visions[].verdict → stack, visionPath, verdict" --> CHK
  CHK -. "verdict = failure: stack, visionPath → stack, visionPath" .-> DEADFAIL[/"die: NotationDeclaredFailure<br/>kept: worktree, uncommitted, for a human"/]
  CHK -. "verdict = success, file missing or empty: stack, visionPath → stack, visionPath" .-> RETRY
  RETRY -- "visionPath → visionPath" --> CHK2
  CHK2 -. "still missing or empty: stack, visionPath → stack, visionPath" .-> DEADRETRY[/"die: VisionUnverified<br/>kept: worktree, uncommitted, for a human"/]

  CMT["commit-design-artifacts · Mechanical<br/>copy design.md and every checked vision into the run root; under records = committed also git add + commit them on the current branch"]
  DS -- "designPath → designPath" --> CMT
  CHK -- "verdict = success, file present: visionPath → visionPaths[]" --> CMT
  CHK2 -- "present: visionPath → visionPaths[]" --> CMT

  subgraph Discover["discover · parallel to the whole probe / assemble / design / verify chain"]
    DISC["discover · Model, borrowed whole<br/>read-only recon of what already exists; ticket only, never the vision"]
  end
  IN -- "ticket, title, body → ticket, title, body" --> DISC
  DISC -. "note missing or empty: discoverPath → discoverPath" .-> DEADDISC[/"die: DiscoverNoteMissing<br/>kept: worktree, nothing committed"/]

  BS["brainstorm · Model<br/>reconcile the visions against discover's recon; record every collision's resolution before build begins"]
  CMT -- "designPath, visionPaths → designPath, visionPaths" --> BS
  DISC -- "discoverPath → discoverPath" --> BS

  BS -- "designPath, visionPaths, discoverPath → designPath, visionPaths, discoverPath" --> OUT
```

Gaps flagged, not patched:
- One design session writes every matched notation's vision plus the design doc in a single dispatch (this drawing's reading of "one design session") versus "routes ... checked and retried independently of siblings," which reads as one dispatch per notation. Both satisfy the acceptance criteria; which one is real needs a ruling.
- `retry-vision`'s scoped prompt has no named producer: whether it re-enters `assemble-brainstorm-prompt` filtered to the one failing stack, or is composed some other way, is undecided.
- The timing of `NotationDeclaredFailure` is undecided: whether the run waits for every parallel notation branch (checks and retries alike) to resolve before dying, so a human sees every problem at once, or dies as soon as one branch's own siblings-in-flight finish. The requirement guarantees siblings still get their checks, not the exact moment of death.
