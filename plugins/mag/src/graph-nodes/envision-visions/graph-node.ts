import { Effect, Result, Schema } from "effect"
import { envisionNotation } from "mag/graph-nodes/envision-notation/graph-node"
import { make } from "mag/runtime/graph-node.definition"

type NotationOutcome = Effect.Success<ReturnType<typeof envisionNotation.run>>
type NotationFailure = Effect.Error<ReturnType<typeof envisionNotation.run>>

/** One route's whole dispatch, isolated in `Effect.result` — `build-under-review`'s own idiom for a
 * child pass — so a route's failure can never interrupt a sibling still drawing.
 * `notation` rides alongside the `Result` because a failure doesn't always carry it back
 * (`NotationVisionGitFailed`/`NotationVisionCommitFailed` don't), and the retry pass below needs to
 * know which route to re-dispatch regardless of which tag it failed with. */
const dispatchOne = (input: {
  readonly ticket: string
  readonly title: string
  readonly body: string
  readonly agent?: string
  readonly model?: string
}) =>
(
  notation: string
): Effect.Effect<{ readonly notation: string; readonly result: Result.Result<NotationOutcome, NotationFailure> }> =>
  Effect.result(
    envisionNotation.run({
      notation,
      ticket: input.ticket,
      title: input.title,
      body: input.body,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      ...(input.model === undefined ? {} : { model: input.model })
    })
  ).pipe(Effect.map((result) => ({ notation, result })))

/**
 * The visions from every route, once every result is a success — folds `sessions` and
 * `costUsd` from each route's own final dispatch, `build-under-review`'s `charge()` precedent
 * (`null` poisons the total). A surviving failure fails with that route's own tag: the composite
 * mints nothing (`errors.ts`'s re-export).
 */
const collect = (
  entries: readonly { readonly notation: string; readonly result: Result.Result<NotationOutcome, NotationFailure> }[]
): Effect.Effect<
  { readonly visions: readonly { readonly notation: string; readonly visionPath: string }[]; readonly sessions: readonly string[]; readonly costUsd: number | null },
  NotationFailure
> =>
  Effect.gen(function* () {
    let visions: { readonly notation: string; readonly visionPath: string }[] = []
    let sessions: readonly string[] = []
    let costUsd: number | null = 0
    for (const entry of entries) {
      if (Result.isFailure(entry.result)) return yield* Effect.fail(entry.result.failure)
      const success = entry.result.success
      visions = [...visions, { notation: success.notation, visionPath: success.visionPath }]
      sessions = [...sessions, ...success.sessions]
      costUsd = costUsd === null || success.costUsd === null ? null : costUsd + success.costUsd
    }
    return { visions, sessions, costUsd }
  })

/**
 * The one loop-back this graph has. Fans `envision-notation` out
 * over the resolved notation list, `concurrency: "unbounded"`, each route wrapped in `Effect.result`
 * so a failing route never interrupts a sibling still drawing (enforced by the combinator rather
 * than by ordering luck). A second pass re-dispatches exactly the routes whose
 * failure is `NotationVisionMissing`, once each, again concurrently and again isolated; a `blocked`
 * route is trusted and never retried. `visions` is built from each route's own node-computed path,
 * never from a session's echo — `envision-notation`'s own success payload, read straight through.
 * Unregistered: `notations` is an array (`schema-flags.ts` derives flags for string/number/boolean
 * only).
 */
export const envisionVisions = make({
  name: "envision-visions",
  description: "Fan out envision-notation over the matched notations, keep siblings running, retry a missing document once.",
  input: Schema.Struct({
    notations: Schema.Array(Schema.String),
    ticket: Schema.String,
    title: Schema.String,
    body: Schema.String,
    /** A named agent to run every route's session as, same convention as `discover`'s field. */
    agent: Schema.optional(Schema.String),
    /** `--model` for every route's dispatch, same convention as `agent`. */
    model: Schema.optional(Schema.String)
  }),
  success: Schema.Struct({
    visions: Schema.Array(Schema.Struct({ notation: Schema.String, visionPath: Schema.String })),
    sessions: Schema.Array(Schema.String),
    costUsd: Schema.NullOr(Schema.Number)
  }),
  run: (input) =>
    Effect.gen(function* () {
      const dispatch = dispatchOne(input)
      const first = yield* Effect.forEach(input.notations, dispatch, { concurrency: "unbounded" })

      // Exactly the routes that failed `NotationVisionMissing` dispatch once more, isolated the
      // same way. Every other route — a success, or a trusted `blocked` declaration — passes
      // through untouched: "trust a declared failure" means no retry, not one more chance.
      const retried = yield* Effect.forEach(
        first,
        (entry) =>
          Result.isFailure(entry.result) && entry.result.failure._tag === "NOTATION_VISION_MISSING"
            ? dispatch(entry.notation)
            : Effect.succeed(entry),
        { concurrency: "unbounded" }
      )

      return yield* collect(retried)
    })
})
