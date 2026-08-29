```ts
// design, outside: { ticket, title, ticketPath } → Effect<{ designPath, planPath, headSha, discoverPath },
//   DesignGraphTicketUnreadable | ShellBlocked | ShellMissing | DiscoverNoteMissing | BrainstormPromptOversized
//   | DesignMissing | RecycleScanDesignUnreadable | PlanMissing | PlanBlocked | PlanDisputeRejected>

const Probes = Graph.construct("probes")
  .then(ReadTicket)
    // { ticketPath } → { text }   !DesignGraphTicketUnreadable (the ticket file is a trust boundary, read once here)
  .fork(DetectSvelte, DetectEffect, DetectGraphCore)
    // { text } → { stack, matched }   ∥ ×3, manifest walk only; graph-core also needs the ticket's GraphNodes line to name a node
  .join(MatchedStacks)
    // { verdicts: [{ stack, matched }] } → { notations[] }, the matched ids in probe order; empty draws the generic notation downstream
  .finalise()   // outside: { ticketPath } → { notations[] } !DesignGraphTicketUnreadable

const OpenDesign = Graph.construct("open-design")
  .fork(EnvisionShell, Discover, AssembleBrainstormPrompt)
    // { ticket, title, ticketPath, notations[] } → { designPath, sessionRef, modules[] }
    //   !ShellBlocked (the session declared it cannot draw; the reason lands as vision-blocked-N.md, trusted, no retry)
    //   !ShellMissing (design missing, blank, or unchanged from its snapshot)
    //   one session, every matched notation's body, the design doc's Envisioned Shell section alone; blind by schema: no field can carry the discover note
    // ∥ { ticket, title, ticketPath } → { discoverPath }   !DiscoverNoteMissing
    //   read-only recon of what already exists; sees the ticket only, never the shell
    // ∥ { } → { prompt, bytes }   !BrainstormPromptOversized (composed bytes exceed the budget; nothing written, no session spent)
  .finalise()   // outside: { ticket, title, ticketPath, notations[] } → { sessionRef, discoverPath, prompt } !ShellBlocked !ShellMissing !DiscoverNoteMissing !BrainstormPromptOversized

const DesignUnderReview = Graph.construct("design-under-review")
  .then(Brainstorm)
    // { ticket, title, ticketPath, prompt, discoverPath, resume } → { designPath, headSha, sessionRef, changed }
    //   resumes the shell's session: the design completed in place around the shell already in the file
    //   !DesignMissing (design missing, blank, or unchanged and silent)
  .then(RecycleScan)
    // { designPath } → { recycleScanPath }, mechanical: every backticked name in the design grepped across git's tracked files, kebab, camel and snake case
    //   !RecycleScanDesignUnreadable !RecycleScanFileUnreadable !RecycleScanWriteFailed
  .then(Plan)
    // { ticket, title, ticketPath, designPath, recycleScanPath } → { planPath, headSha, sessionRef }   !PlanMissing
    //   the second artifact by ruling: the plan resolves the design's names against the repo
  .then(ReviewPlan)
    // { ticket, title, ticketPath, planPath, headSha } → { findingsPath }, never designPath: the design is the plan's input and nothing else's
    //   !PlanBlocked (a blocking finding, tagged design or plan; the loop resumes that artifact's session, at most cap times per producer)
    //   !PlanDisputeRejected (an adjudicating pass rejected a disputed finding; never routed back)
    // a design finding resumes Brainstorm over the findings, then RecycleScan and Plan fresh when the design changed
    // a plan-only finding resumes Plan over the findings, the design and its scan untouched
    // a dispute from Brainstorm makes the next ReviewPlan adjudicating: it decides the disputed findings only
  .finalise()   // outside: { ticket, title, ticketPath, prompt, discoverPath, resume, cap } → { designPath, planPath, headSha, reviewPasses }
                //   !DesignMissing !RecycleScanDesignUnreadable !PlanMissing !PlanBlocked !PlanDisputeRejected

const DesignGraph = Graph.construct("design")
  .borrow(Probes)          // { ticketPath } → { notations[] } !DesignGraphTicketUnreadable
  .borrow(OpenDesign)      // { ticket, title, ticketPath, notations[] } → { sessionRef, discoverPath, prompt }
  .borrow(DesignUnderReview)
    // { ticket, title, ticketPath, prompt, discoverPath, resume: sessionRef, cap } → { designPath, planPath, headSha }
  .finalise()
    // outside: { ticket, title, ticketPath } → { designPath, planPath, headSha, discoverPath }
    //   !DesignGraphTicketUnreadable | ShellBlocked | ShellMissing | DiscoverNoteMissing | BrainstormPromptOversized
    //   | DesignMissing | RecycleScanDesignUnreadable | PlanMissing | PlanBlocked | PlanDisputeRejected
```

Gaps flagged, not patched:
- `ReadTicket` and `MatchedStacks` are drawn as steps for the sketch's own readability; in the shipped graph both are a file read and a `filter`/`map` inside the pipeline, not nodes, since neither has a contract of its own worth a journal row.
- The blind ordering (shell ∥ discover) is drawn as a fork; the property the graph relies on is the shell's schema, which cannot name the discover note. A sequential drawing would be equally blind.
- `cap` is a policy value named in the sketch and left to the graph file; it has no default here.
