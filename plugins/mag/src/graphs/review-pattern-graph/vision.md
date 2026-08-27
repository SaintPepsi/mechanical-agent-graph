```mermaid
graph TD
  IN[["review-pattern-graph(reportTicket)"]]
  OUT[["{ ticket, manifestPath, reportPath, passes, sendBacks, through, sessions, costUsd }"]]

  GR["gather-reviews · Mechanical<br/>scan every run's journal, select the next unanalysed window of WINDOW_SIZE review passes since the last report (or ANALYSIS_EPOCH), write window.json"]
  AR["analyse-reviews · Model<br/>attribute every send-back in the window under MODEL_ANALYSIS, render the pattern report"]
  CT["comment-ticket · Mechanical<br/>post the report's file contents as a tracker comment"]

  GR -- "manifestPath → manifestPath" --> AR
  AR -- "reportPath → path" --> CT
  IN -- "reportTicket → ticket" --> CT

  GR -. "verdict = window short: WindowNotFull" .-> DEADEMPTY
  GR -. "fails: WindowRunRootMissing | WindowWriteFailed" .-> DEADWIRE
  AR -. "fails: WindowUnreadable | AnalysisRunRootMissing" .-> DEADWIRE
  AR -. "verdict = missing attribution: AnalysisIncomplete" .-> DEADINCOMPLETE
  AR -. "fails: ReportWriteFailed" .-> DEADREPORT
  CT -. "fails: CommentBodyMissing | CommentTrackerUnreachable | CommentFailed" .-> DEADPOST

  DEADEMPTY[/"die: WindowNotFull<br/>kept: nothing — no session dispatched; the ordinary outcome of most invocations, safe to invoke again after the next review pass"/]
  DEADWIRE[/"die: run-root or manifest-schema wiring fault, uncaught<br/>kept: nothing — reached before any session spends a token"/]
  DEADINCOMPLETE[/"die: AnalysisIncomplete<br/>kept: nothing new — report unwritten, watermark unmoved, the same window regathers whole next invocation"/]
  DEADREPORT[/"die: ReportWriteFailed<br/>kept: the session's own ids, for cost accounting — watermark unmoved, same window re-analysed next time"/]
  DEADPOST[/"die: comment-ticket error, uncaught<br/>kept: the report on disk, watermark already advanced — a human reads review-patterns-N.md from the run root and posts it by hand"/]

  GR -- "manifestPath → manifestPath" --> OUT
  GR -- "passes → passes" --> OUT
  GR -- "through → through" --> OUT
  AR -- "reportPath → reportPath" --> OUT
  AR -- "sendBacks → sendBacks" --> OUT
  AR -- "sessions → sessions" --> OUT
  AR -- "costUsd → costUsd" --> OUT
  CT -- "ticket → ticket" --> OUT
```

Gaps flagged, not patched:
- `WINDOW_SIZE`, `ANALYSIS_EPOCH` and `MODEL_ANALYSIS` are policy, not shape — the diagram names that `gather-reviews` and `analyse-reviews` read them and leaves their values to the graph file's own constants, the same way `develop-graph`'s `REVIEW_CAP` and per-node models do.
- Nothing produces the field that would fire this graph on its own cadence. `gather-reviews`'s `WindowNotFull` makes invoking the graph free when there is nothing to do, but no node, cron, or launcher in this repo holds the edge "a review pass just ended → invoke `review-pattern-graph`" — today that edge is a person remembering to run `bun run mag review-pattern-graph`, naming the report ticket by hand. Unresolved.
- `WindowNotFull` exits 1 like any other failed run, so a caller chaining on exit status reads "nothing to analyse yet" the same as a real fault. Whether an automatic invoker needs a different signal for that distinction is undecided.
