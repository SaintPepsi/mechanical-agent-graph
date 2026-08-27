# Graph mermaid vision — envisioning

An ideal imagination exercise, and the first drawing: a graph's ideal shape as a mermaid diagram, imagined as if from nothing — what exists today has no vote. One node per step in the run's data flow, edges as output-to-input field mappings, conditions written on the edges they fire. The failure it prevents: arrows labeled with prose nobody can implement, and diagrams that mirror the current code so faithfully they envision nothing.

The notation itself — what a box, an edge, a condition and a death mean — is spliced in immediately below this document, kept separate so a session drawing from code alone can read the grammar without also being told to draw the ideal, which its own job forbids.

## Do this

- Draw the ideal: nodes and edges may not exist yet — that is the point. The current implementation is banned from the frame.

## Worked example

```mermaid
graph TD
  IN[["develop-graph(ticket, base?)"]]
  OUT[["{ prUrl, branch, commits, costUsd }"]]

  subgraph Prepare["prepare"]
    RB["resolve-base · Mechanical<br/>pin the commit everything builds on"]
    FT["fetch-ticket · Mechanical<br/>the tracker's truth, never a paraphrase"]
    FBN["format-branch-name · Mechanical"]
    WA["worktree-add · Mechanical<br/>isolated checkout, branch created"]
  end

  IN -- "base? → base?" --> RB
  IN -- "ticket → ticket" --> FT
  RB -- "baseSha → baseSha" --> WA
  FT -- "title → title" --> FBN
  FBN -- "branch → branch" --> WA

  DG[["design · borrowed whole<br/>probes → prompt → session → verified visions"]]
  WA -- "workdir → workdir" --> DG
  FT -- "title, body → title, body" --> DG

  subgraph Loop["build-under-review · loop, cap 3"]
    B["build · Model<br/>implement the design, or fix the standing findings"]
    V["verification · Mechanical<br/>the repo's declared suite; exit code is the verdict"]
    S["simplify · Model<br/>remove what build added but the design never asked for"]
    RD["review-diff · Model<br/>adversarial read of the whole diff"]
    DSP["dispute · Model<br/>the builder's one chance to argue the findings are moot"]
  end

  DG -- "designPath → designPath" --> B
  B -- "headSha → headSha" --> V
  V -- "passed → (gate)" --> S
  S -- "headSha → headSha" --> RD
  RD -. "verdict = findings: findingsPath → findingsPath" .-> B
  RD -. "3rd findings verdict: findingsPath → findingsPath" .-> DSP
  DSP -. "upheld = true: exits as clean" .-> WPB
  DSP -- "upheld = false" --> DEAD[/"die: ReviewDisputeRejected<br/>worktree kept for a human"/]

  subgraph Publish["publish-tail · clean verdict only"]
    WPB["write-pr-body · Model"]
    PB["publish · Mechanical<br/>push + open PR; merging stays the maintainer's"]
    WR["worktree-remove · Mechanical<br/>success only"]
  end

  RD -- "verdict = clean: headSha → headSha" --> WPB
  WPB -- "bodyPath → bodyPath" --> PB
  PB -- "prUrl, commits → prUrl, commits" --> WR
  WR --> OUT
```

Gap flagged, not patched: the loop's cap and the verification command are policy, not shape — the diagram names that they exist and leaves their values to configuration.

## Done when

- [ ] The diagram is the drawing itself; surrounding prose only carries what the notation can't.
- [ ] Every edge is a field mapping; every conditional edge names its firing field and value.
- [ ] Every step carries a one-line job and a Mechanical/Model type; borrowed graphs are single boxes.
- [ ] Every death is a terminal stating the error and what survives.
- [ ] Nothing in it mirrors a current file or cites an ID the reader can't resolve from the diagram.
