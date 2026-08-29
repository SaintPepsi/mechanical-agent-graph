```ts
// design, outside: { ticket, title, body } → Effect<{ designPath, visionPaths, discoverPath },
//   DesignPromptOversized | NotationDeclaredFailure | VisionUnverified | DiscoverNoteMissing>

const PrepareDesignPrompt = Graph.construct("prepare-design-prompt")
  .fork(DetectSvelte, DetectEffect, DetectGraphCore)
    // { } → { stack, matched }   ∥ ×3, one per candidate stack, no ticket dependency, manifest walk only
  .join(AssembleBrainstormPrompt)
    // { verdicts: [{ stack, matched }] } → { promptPath, matchedStacks }
    //   !DesignPromptOversized (composed bytes exceed the size budget; nothing written, worktree untouched)
  .finalise()   // outside: { } → { promptPath, matchedStacks } !DesignPromptOversized

const VerifyOneVision = Graph.construct("verify-one-vision")
  .then(CheckVision)
    // { stack, visionPath, verdict } → { stack, visionPath, present }
    //   !NotationDeclaredFailure (verdict = failure, independent of whether the file exists; worktree kept, uncommitted, for a human)
  .then(RetryVision)
    // { visionPath } → { visionPath }, only when verdict = success and present = false; skipped once the first check already found the file
  .then(RecheckVision)
    // { visionPath } → { visionPath }
    //   !VisionUnverified (still missing or empty after the one retry, second and final pass; worktree kept, uncommitted, for a human)
  .finalise()   // outside: { stack, visionPath, verdict } → { visionPath } !NotationDeclaredFailure !VisionUnverified

const VerifyVisions = Graph.construct("verify-visions")
  .map(VerifyOneVision)
    // { visions[] } → { visionPaths[] }, one branch per matched notation, isolated from its siblings' own retries
    // a branch's die bubbles and ends the run rather than surfacing in the success shape; every branch already
    // in flight still resolves its own check/retry first, so a human sees every notation's outcome, not just the first to die
    // !NotationDeclaredFailure !VisionUnverified
    // how many branches run concurrently is a policy value, not fixed by this shape
  .finalise()   // outside: { visions[] } → { visionPaths[] } !NotationDeclaredFailure !VisionUnverified

const BuildDesign = Graph.construct("build-design")
  .borrow(PrepareDesignPrompt)   // { } → { promptPath, matchedStacks } !DesignPromptOversized
  .then(DesignSession)
    // { ticket, title, body, promptPath, matchedStacks } → { designPath, visions[] }
    // one dispatch writes the design doc and every matched notation's vision together, each with its own declared verdict
  .borrow(VerifyVisions)         // { visions[] } → { visionPaths[] } !NotationDeclaredFailure !VisionUnverified
  .then(CommitDesignArtifacts)
    // { designPath, visionPaths[] } → { designPath, visionPaths[] }, git add + commit onto the ticket's own branch, success only
  .finalise()   // outside: { ticket, title, body } → { visionPaths[] } !DesignPromptOversized !NotationDeclaredFailure !VisionUnverified

const DiscoverGraph = Graph.construct("discover")
  .then(Discover)
    // { ticket, title, body } → { discoverPath }
    //   !DiscoverNoteMissing (note missing or empty; worktree kept, nothing committed)
    // read-only recon of what already exists; sees the ticket only, never the vision or the design doc
  .finalise()   // outside: { ticket, title, body } → { discoverPath } !DiscoverNoteMissing

const DesignGraph = Graph.construct("design")
  .fork(BuildDesign, DiscoverGraph)
    // { ticket, title, body } → { designPath, visionPaths[] } !DesignPromptOversized !NotationDeclaredFailure !VisionUnverified
    //   ∥   { ticket, title, body } → { discoverPath } !DiscoverNoteMissing
  .join(RecycleMap)
    // { discoverPath } → { recycleMapPath } !RecycleMapMissing
  .borrow(DesignUnderReview)
    // { visionPaths[], discoverPath, recycleMapPath } → { designPath, planPath, headSha }
    //   brainstorm → plan → review-plan; a blocking finding resumes the session that owns the artifact it names
    //   (design → brainstorm, then plan fresh if the design changed; plan only → the plan session), at most cap times per producer
    //   an adjudicating pass decides the disputed findings only; its other blocking findings route as above
    //   !DesignMissing !PlanMissing !PlanBlocked (cap spent) !PlanDisputeRejected (a disputed finding rejected)
  .finalise()
    // outside: { ticket, title, body } → { designPath, planPath, headSha, visionPaths, discoverPath, recycleMapPath }
    //   !DesignPromptOversized | NotationDeclaredFailure | VisionUnverified | DiscoverNoteMissing | RecycleMapMissing
    //   | DesignMissing | PlanMissing | PlanBlocked | PlanDisputeRejected
```

Gaps flagged, not patched:
- `DesignSession` is drawn as one dispatch that writes every matched notation's vision plus the design doc, then declares a verdict per notation. A per-notation dispatch reads equally plausibly from the same source material, and would reshape `DesignSession` into a `.map(DesignOneNotation)` fan-out instead of a single `.then()`. Which of the two is real needs a ruling.
- `RetryVision`'s input is drawn as the bare `visionPath` it must overwrite, with no prompt of its own. Whether it re-enters `AssembleBrainstormPrompt` scoped down to its one failing stack, or is composed some other way, is undecided; the sketch cannot invent that producer.
- `VerifyVisions`'s die timing is drawn as "every in-flight branch resolves its own check and retry before the run ends," so a human sees every notation's outcome at once. Whether that is really the rule, versus the run ending as soon as one branch's own siblings-in-flight (not the whole fan-out) finish, is undecided.
- The size budget `AssembleBrainstormPrompt` enforces, and how many `VerifyOneVision` branches run concurrently, are both named as policy values in the sketch and left to configuration; neither has a stated default.
