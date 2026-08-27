```ts
// review-pattern-graph, outside: { reportTicket } → Effect<
//   { ticket, manifestPath, reportPath, passes, sendBacks, through, sessions, costUsd },
//   WindowNotFull | WindowRunRootMissing | WindowWriteFailed
//   | WindowUnreadable | AnalysisRunRootMissing | AnalysisIncomplete | ReportWriteFailed
//   | CommentBodyMissing | CommentTrackerUnreachable | CommentFailed>

const ReviewPatternGraph = Graph.construct("review-pattern-graph")
  .then(GatherReviews)
    // { } → { manifestPath, passes, through }
    //   !WindowRunRootMissing !WindowWriteFailed
    //     (wiring fault, uncaught: dies with nothing kept, reached before any session spends a token)
    //   !WindowNotFull
    //     (verdict = window short: nothing dispatched yet, the ordinary outcome of most invocations,
    //     safe to invoke again after the next review pass)
    // reads every run's journal itself, off the R channel — no field of IN feeds this node
  .then(AnalyseReviews)
    // { manifestPath } → { reportPath, sendBacks, sessions, costUsd }
    //   !WindowUnreadable !AnalysisRunRootMissing
    //     (wiring fault, uncaught: dies with nothing kept, reached before any session spends a token)
    //   !AnalysisIncomplete
    //     (verdict = missing attribution: report unwritten, watermark unmoved, the same window regathers whole next invocation)
    //   !ReportWriteFailed
    //     (dies keeping only this session's own ids, for cost accounting; watermark unmoved, same window re-analysed next time)
    // attributes every send-back in the window under MODEL_ANALYSIS, renders the pattern report
  .then(CommentTicket)
    // { path, ticket } → { ticket }
    //   !CommentBodyMissing !CommentTrackerUnreachable !CommentFailed
    //     (uncaught: dies with the report already on disk and the watermark already advanced —
    //     a human reads review-patterns-N.md from the run root and posts it by hand)
    // path is analyse-reviews' own reportPath; ticket is carried from outside (reportTicket),
    // never produced by an earlier node; posts the report's file contents as a tracker comment
  .finalise()
    // outside: { reportTicket } → { ticket, manifestPath, reportPath, passes, sendBacks, through, sessions, costUsd }
    //   !WindowNotFull | WindowRunRootMissing | WindowWriteFailed
    //   | WindowUnreadable | AnalysisRunRootMissing | AnalysisIncomplete | ReportWriteFailed
    //   | CommentBodyMissing | CommentTrackerUnreachable | CommentFailed
```

Gaps flagged, not patched:
- `WINDOW_SIZE`, `ANALYSIS_EPOCH` and `MODEL_ANALYSIS` are policy, not shape — `gather-reviews` and `analyse-reviews` read them above with no stated value, the same way `develop-graph`'s `REVIEW_CAP` is left to configuration.
- Which run root, or set of run roots, `gather-reviews` scans for journals is undrawn. `WindowRunRootMissing` names a way that lookup can fail but nothing upstream of this graph supplies a root as an input field, so the sketch cannot say whether it is one fixed location, every root under some collection, or something else the node resolves on its own.
- Nothing in this graph produces the edge that would fire it on its own cadence. `WindowNotFull` makes invoking the graph free when there is nothing to analyse, but no node here holds "a review pass just ended, invoke this graph" — that trigger lives outside the sketch entirely, unresolved.
- `WindowNotFull` sits in the same closed error union as every real fault above it, so a caller reading only exit status cannot tell "nothing to analyse yet" apart from a genuine wiring or write failure. Whether an automatic invoker needs a distinct signal for that one verdict, separate from the rest of the union, is undecided.
