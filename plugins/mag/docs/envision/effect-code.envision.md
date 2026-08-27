# Effect code — envisioning

An ideal imagination exercise: before writing any Effect code, envision the ideal program as if from nothing — what exists today has no vote. Outside rail first, then the services it leans on, then the body as pure wiring. The failure it prevents: error handling improvised stage by stage as the code is typed, services threaded through parameters because nobody decided they were ambient, and a "design" that is really the first draft of the implementation wearing a different font.

## Notation

The outside rail as one line, the services as a short cast, the body as an `Effect.gen` mock-up that must not compile — names, tags and services are invented for the ideal, and finding or building the real ones is a later, separate job:

```ts
// outside: { input } → Effect<{ success }, ErrorA | ErrorB, ServiceA | ServiceB>

// services, ambient, never parameters:
//   ServiceA — one line on the job it does: { x } → { y } !YFailed

const program = ({ input }) =>
  Effect.gen(function* () {
    const a = yield* ServiceA
    const y = yield* a.do({ x: input.x })      // !YFailed { fields a real step computed }
    return { success: y }
  })
```

## What counts as one stage

A stage earns its own `yield*` line when something on the rail changes: the success shape, the error set, or the service it needs. A step that only reshapes data rides inside the stage before or after it. Recovery is part of the stage that earns it, declared at the call site (`Effect.retry`, a `catchTag` naming what the rail rejoins as) — never a policy blanket over the whole body.

## Do this

- Draw the artifact, never instructions about the artifact. The body either shows the wiring or the thing isn't in the sketch.
- Envision the ideal: invent the services, stages and error tags the program deserves. The current codebase is banned from the frame; nothing sketched needs to exist yet.
- State the outside rail first: `{ input } → Effect<{ success }, Errors, Services>`, one line, before any body.
- Yield every dependency from context; a service passed as a parameter is a decision dodged. The body names *what* it needs, never *which one* it gets — a stub and the real thing must be indistinguishable to it.
- Name every failure as its own tag, carrying only fields a real prior step computed, with the tag riding the stage that raises it as a trailing `!Tag` comment.
- Keep the happy body pure wiring: no try/catch, no if-error-then. Where a rail rejoins, declare it at the call site of the one stage that earns it. Branching on a success value is wiring, not error handling — a plain early return on a normal outcome is fine.
- A pure computation never earns a service invented to host it; gate it inline (`Effect.filterOrFail` over the plain value). Only a real dependency on the world goes in the Requirement slot.
- Put outcome tone into the type: an outcome the caller must react to rides the error channel as a tag; an outcome the caller absorbs quietly is a normal success value. "Loud" and "silent" are shapes, not log levels.
- Verify what matters mechanically inside the sketch's own flow — a declared success is a claim, evidence is a check the program performs (a snapshot compared, a file read back) — and make the check a stage, not a comment.
- Never cite a bare requirement or ticket ID; state the rule in the sketch's own words. Flag anything undecided as a gap needing a ruling instead of quietly inventing the answer.

## Worked example

```ts
// dispatch-session, outside:
// { prompt, destination } → Effect<{ sessionId, costUsd }, SessionDied | ArtifactMissing | ArtifactStale, ClaudeAgent | Snapshots>

// The services it leans on, ambient, never parameters:
//   ClaudeAgent   — runs one session to completion: { prompt } → { sessionId, costUsd } !SessionDied
//   Snapshots     — remembers what a path held before:  take(path) → Snapshot ; changed(snapshot) → boolean

const dispatchSession = ({ prompt, destination }) =>
  Effect.gen(function* () {
    const agent = yield* ClaudeAgent
    const snapshots = yield* Snapshots

    const before = yield* snapshots.take(destination)        // taken BEFORE dispatch: presence alone lies on a re-run

    const session = yield* agent.run({ prompt })             // !SessionDied { sessionId, stderrTail }

    yield* snapshots.changed(before).pipe(                   // the session's word is never the evidence
      Effect.filterOrFail(
        (changed) => changed,
        () => new ArtifactStale({ path: destination, sessionId: session.sessionId })
      )
    )

    return { sessionId: session.sessionId, costUsd: session.costUsd }
  })

// And a caller that pays for nothing it can't use:
const envisionNode = Effect.gen(function* () {
  const vision = yield* dispatchSession({ prompt: visionPrompt, destination: visionPath })
  const sketch = yield* dispatchSession({ prompt: sketchPrompt(visionPath), destination: sketchPath })
    // runs only because vision settled clean; a dead vision session never buys a sketch session

  return { sessions: [vision.sessionId, sketch.sessionId], costUsd: sum(vision, sketch) }
})
// costUsd: one unpriced session makes the total unpriced, never silently zero
```

## Done when

- [ ] The outside rail is stated as one line before any body appears.
- [ ] Every dependency is yielded from context; none arrives as a parameter.
- [ ] Every failure is a named tag on the stage that raises it, carrying only fields a real step computed.
- [ ] The happy body reads as pure wiring; recovery is declared at the one call site that earns it.
- [ ] Nothing in it compiles, mirrors a current file, or cites an ID the reader can't resolve from the sketch.
