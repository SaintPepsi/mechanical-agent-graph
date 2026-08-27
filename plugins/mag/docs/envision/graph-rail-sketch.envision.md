# Graph rail-sketch — envisioning

An ideal imagination exercise: after the mermaid vision draws a graph's shape, the rail-sketch imagines its ideal construction as if from nothing — what exists today has no vote. It envisions: these are the graphs and graph nodes, and here is how they are all tied together. It is a mock-up of an ideal, composable Effect-based graph — never a whole file, never a real function, and never a description of how to draw one. The failure it prevents: an implementer coding straight from a box-and-arrow diagram and inventing the typed shapes as they go, or a sketch that mirrors the current implementation so faithfully it envisions nothing.

## Notation

Outside shape first, as one rail. Then the cast of parts. Then the construction, as pseudo-code whose constructors are invented for the ideal:

```ts
const Thing = Graph.construct("thing")
  .fork(LoadA, LoadB)        // { id } → { a } !ANotFound   ∥   { } → { b }
  .join(Combine)             // { a, b } → { combined }
  .then(Persist)             // { combined } → { path } !WriteRejected
  .finalise()                // outside: { id } → { path }
```

A borrowed graph joins whole, and is bent at the borrowing site with declared modifiers, never forked:

```ts
const Variant = Graph.construct("variant")
  .borrow(Thing)
    .replaceNode(LoadA, LoadAFromJira)   // same { id } → { a } rail, different world behind it
  .finalise()
```

## What counts as one part

A part is anything with its own outside rail: a node, or a whole graph borrowed as one node. If a stretch of nodes stands on its own — its first input and last success make sense without the rest — it is its own graph and the spine borrows it, rather than inlining its nodes. A loop is one part: its body nodes, its feedback edge, its exit condition and its cap are declared together at one site, not scattered.

## Do this

- Draw the artifact, never instructions about the artifact. If a paragraph is explaining how to read the sketch, delete it — the sketch either shows it or it isn't there.
- Invent the constructors the ideal needs (`.fork`, `.join`, `.loop`, `.onCap`, `.borrow`, whatever the shape asks for). The current implementation is banned from the frame: sketch what the graph should be, not what the repo's runtime offers today.
- State the outside shape before any inside part: one line, `{ input } → Effect<{ success }, ErrorA | ErrorB>`.
- Give every node line its rail inline, as a trailing comment: `{ input } → { success } !ErrorTag`. One tag per distinct failure.
- Attach a condition exactly where the node is wired in — a loop's `until`/`cap`/`feedback`, an `onCap` branch, the comment on its edge. A node with no condition at its wiring site runs unconditionally, and says nothing.
- Bend a borrowed graph only with declared modifiers at the borrowing site; past three at that site the sketch refuses: envision a new graph instead.
- A fan-out over a collection (`.map(Part)`) declares at its wiring site what one item's failure does to the rest: bubbles and ends the run, or is isolated — the item's error surfaced in the success shape while its siblings finish. Never leave that unstated; a fan-out whose sketch says nothing has silently chosen "one stubborn item kills everything." The fan-out's width is policy, not shape — name that it exists, leave the value to configuration.
- Never cite a bare requirement or ticket ID as the reason for a shape; state the rule in the sketch's own words so it stands alone.
- When the sketch surfaces something the vision never decided — a cap's value, a verification command, a field nothing upstream produces — flag it plainly as a gap needing a ruling. Do not quietly invent the answer and fold it in. A gap note states the undecided thing in its own words; the no-bare-ID rule holds there too.

## Worked example

```ts
// develop-graph, outside: { ticket, base? } → Effect<{ prUrl, branch, commits, costUsd },
//   TicketNotFound | DesignFailed | VerificationFailed | ReviewDisputeRejected | PublishRejected>

const Prepare = Graph.construct("prepare")
  .fork(ResolveBase, FetchTicket)   // { base? } → { baseSha }   ∥   { ticket } → { title, body } !TicketNotFound
  .join(FormatBranchName)           // { ticket, title } → { branch }
  .then(WorktreeAdd)                // { baseSha, branch } → { workdir } !WorktreeCollision
  .finalise()

const BuildUnderReview = Graph.construct("build-under-review")
  .loop(Build, Verification, Simplify, ReviewDiff, {
    feedback: ReviewDiff.findingsPath → Build.findingsPath,
    until: ReviewDiff.verdict === "clean",
    cap: 3
  })
  .onCap(Dispute, {
    upheld: exit(clean),            // findings were moot; loop exits as clean
    rejected: die(ReviewDisputeRejected)   // findings stand; worktree kept
  })
  .finalise()                       // { designPath, workdir } → { headSha }

const PublishTail = Graph.construct("publish-tail")
  .then(WritePrBody)                // { workdir, branch } → { bodyPath }
  .then(Publish)                    // { branch, bodyPath } → { prUrl, commits } !PublishRejected
  .then(WorktreeRemove)             // success only; every failure path leaves the worktree standing
  .finalise()

const DevelopGraph = Graph.construct("develop-graph")
  .borrow(Prepare)
  .borrow(DesignGraph)              // the design graph whole; its designPath is the contract the loop holds the diff to
  .borrow(BuildUnderReview)
  .borrow(PublishTail)
  .finalise()

// A repo with a different tracker bends it at the borrowing site, never forks it:
const DevelopJira = Graph.construct("develop-jira")
  .borrow(DevelopGraph)
    .replaceNode(FetchTicket, FetchJiraTicket)
  .finalise()
```

Gap flagged, not patched: the loop's cap and the verification command are policy, not shape — the sketch names that they exist and leaves their values to configuration.

## Done when

- [ ] The sketch is the drawing itself; no paragraph teaches the reader how to read it.
- [ ] The outside shape is stated as one rail before any inside part appears.
- [ ] Every part's line carries `{ input } → { success }` and its error tags inline.
- [ ] Every condition sits where its node is wired; unconditional nodes carry none.
- [ ] Nothing in it compiles, names a current file, or cites an ID the reader can't resolve from the sketch itself.
