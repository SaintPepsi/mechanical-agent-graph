```mermaid
graph TD
  IN[["design(ticket, title, ticketPath)"]]
  OUT[["{ designPath, planPath, headSha, discoverPath }"]]

  subgraph Probes["probes · parallel, read the ticket file once"]
    PS["detect-svelte · Mechanical<br/>manifest walk for a svelte dependency"]
    PE["detect-effect · Mechanical<br/>manifest walk for an effect dependency"]
    PG["detect-graph-core · Mechanical<br/>root manifest names this repository and the ticket's GraphNodes line names a node"]
  end

  IN -- "ticketPath → text" --> PS
  IN -- "ticketPath → text" --> PE
  IN -- "ticketPath → text" --> PG

  subgraph Open["envision-shell ∥ discover ∥ assemble · parallel, the shell blind by schema"]
    ES["envision-shell · Model<br/>the design doc's Envisioned Shell alone, one shell per matched notation, generic when none matched; the ticket is all it is handed"]
    DISC["discover · Model, borrowed whole<br/>read-only recon of what already exists; ticket only, never the shell"]
    ASM["assemble-brainstorm-prompt · Mechanical<br/>compose the design skill with the shell-drawn concern in the envisioning slot; enforce the size budget"]
  end
  PS -- "stack, matched → notations[]" --> ES
  PE -- "stack, matched → notations[]" --> ES
  PG -- "stack, matched → notations[]" --> ES
  ES -. "verdict = blocked: reason → vision-blocked-N.md" .-> DEADSHELL[/"die: ShellBlocked<br/>kept: the reason in the run root, nothing else written"/]
  ES -. "design missing, blank or unchanged: designPath → designPath" .-> DEADMISSING[/"die: ShellMissing<br/>kept: worktree, nothing committed"/]
  DISC -. "note missing or empty: discoverPath → discoverPath" .-> DEADDISC[/"die: DiscoverNoteMissing<br/>kept: worktree, nothing committed"/]
  ASM -. "bytes > budget: bytes, budget → bytes, budget" .-> DEADSIZE[/"die: BrainstormPromptOversized<br/>kept: nothing, no session spent"/]

  subgraph Loop["design-under-review · loop, cap send-backs per producer"]
    BS["brainstorm · Model<br/>resume the shell's session over the discover note and complete the design around the shell in place; every ambiguity a ruling with a basis, or answer the design-tagged findings"]
    RS["recycle-scan · Mechanical<br/>grep the repo for every backticked name in the design, kebab, camel and snake case; the table the plan resolves against"]
    PL["plan · Model<br/>the build as small ordered tasks over the design; fresh when the design changed, resumed over plan-tagged findings otherwise"]
    RP["review-plan · Model<br/>adversarial read of design and plan against the ticket, no code; or adjudicate the design's own dispute"]
  end
  ES -- "sessionRef → resume" --> BS
  DISC -- "discoverPath → discoverPath" --> BS
  ASM -- "prompt → prompt" --> BS
  BS -- "designPath → designPath" --> RS
  RS -. "design unreadable, a tracked file unreadable, or the table unwritable: designPath → designPath" .-> DEADRS[/"die: RecycleScanDesignUnreadable | RecycleScanFileUnreadable | RecycleScanWriteFailed<br/>kept: worktree, the records so far"/]
  BS -- "designPath → designPath" --> PL
  RS -- "recycleScanPath → recycleScanPath" --> PL
  PL -- "planPath, headSha → planPath, headSha" --> RP
  RP -. "verdict = blocked, a finding targets design, design sendbacks < cap: findingsPath → findingsPath" .-> BS
  RP -. "verdict = blocked, every finding targets plan, plan sendbacks < cap: findingsPath → findingsPath" .-> PL
  BS -. "verdict = disputed: findingsPath, disputePath → findingsPath, disputePath" .-> RP
  BS -. "design missing or unchanged and silent: designPath → designPath" .-> DEADLOOP[/"die: DesignMissing | PlanMissing | PlanBlocked (cap spent) | PlanDisputeRejected<br/>kept: worktree, the records so far"/]
  RP -. "verdict = blocked, cap exhausted: findingsPath → (escalates)" .-> DEADLOOP
  RP -. "adjudicating pass rejects a disputed finding: PlanDisputeRejected → (escalates); its other blocking findings route as above" .-> DEADLOOP

  RP -- "verdict = clean: designPath, planPath, headSha → designPath, planPath, headSha" --> OUT
```

Gaps flagged, not patched:
- The shell pass and the discover session run side by side, so the shell is blind by two mechanisms: its schema cannot name the discover note, and the note is still being written while it draws. Only the schema is the mechanism the graph relies on; the ordering is a wall-clock convenience, and a future graph that ran discover first would still be blind by schema.
- `recycle-scan` reads whatever the design puts in backticks; a design that names nothing in backticks yields an empty table, which the plan cites as an empty prior-art search rather than a failure. Whether an empty scan should die is undecided; the drawing treats it as an answer.
