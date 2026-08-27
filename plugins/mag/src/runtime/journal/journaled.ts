import { Cause, DateTime, Effect, Exit, Option } from "effect"
import type { GraphNode } from "mag/runtime/graph-node.definition"
import { canonicalJson } from "mag/runtime/journal/canonical"
import { ranEndRow, replayedEndRow, startRow } from "mag/runtime/journal/row"
import { Journal, type JournalService } from "mag/runtime/journal/service"
import { RunInfo } from "mag/runtime/run-info"
import { decodeBestEffort, encodeBestEffort } from "mag/runtime/schema-codec"

/**
 * `journaled` turns a GraphNode into the same GraphNode that leaves a record. Every node run
 * appends a start entry and an end entry to the run's journal, and a run resumed from a
 * predecessor returns that predecessor's recorded success instead of doing the work again.
 *
 * It calls `node.run` directly. Spans and trace events stay the sole property of `tracedRun`
 * (`trace/boundary.ts`) and `execute` (`graph-node.definition.ts`) — the trace stream answers
 * "what happened inside this process", the journal answers "what has this run completed", and the
 * two files never import each other's writers.
 *
 * `make` (`graph-node.definition.ts`) applies the wrap, so a node is journalled by being built and
 * no node module carries a line that could be forgotten. A graph file composes bare `.run()` calls
 * and stays as it is.
 */

/** `Symbol.for`, not a fresh symbol: two copies of this module loaded under different paths still agree. */
const JournaledMarker = Symbol.for("mag/runtime/journal/journaled")

/**
 * Exported for the conformance suite: `make` is what applies the wrap, and this is how a rule can
 * tell that a registered node actually went through it rather than being assembled by hand.
 */
export const isJournaled = (node: object): boolean => JournaledMarker in node

/**
 * A schema-encoded value enters a row only if `JSON.stringify` can also render it — the journal's
 * append is a JSON write, and `JSON.stringify`'s domain is strictly narrower than a schema's (a
 * `Schema.Unknown` happily encodes a bigint that `stringify` throws on). Without this guard that
 * throw landed inside the append and killed the run the row was recording; with it, the row lands
 * with the field absent, exactly as it does for a value the schema itself refused.
 */
const renderable = (encoded: Option.Option<unknown>): Option.Option<unknown> =>
  Option.filter(encoded, (value) => Option.isSome(canonicalJson(value)))

/** `DateTime.formatIso` is sync, so the Effect is built once and `yield*`-ed per row. Exported for `run-layers.ts`, which stamps a resume record outside this wrapper's own path. */
export const nowIso = Effect.map(DateTime.now, DateTime.formatIso)

/**
 * A write failure ends the run as a defect: a run whose record is incomplete has lost the one thing
 * it was keeping, and continuing would produce a journal that reads as authoritative and is not.
 * `PlatformError` is nowhere in a node's own error channel, so a caller could never have handled it.
 */
const appendRow = (journal: JournalService, row: Parameters<JournalService["append"]>[0]) =>
  journal.append(row).pipe(Effect.orDie)

/**
 * When the append itself fails inside the finalizer, the node's own cause must survive. A failing
 * finalizer REPLACES the exit (`onExit`'s continuation is `flatMap(finalizer, () => exit)` — the
 * flatMap short-circuits and the original exit is discarded),
 * so the journal defect is re-raised with the node's reasons joined in front of it. The run still
 * dies, per the rule on `appendRow`, but the diagnostic that mattered — why the node itself
 * failed — reaches the operator instead of being erased by a full disk.
 */
const joiningCause = <A, E>(exit: Exit.Exit<A, E>) => (journalCause: Cause.Cause<never>) =>
  Effect.failCause(
    Cause.fromReasons<E>([...(Exit.isSuccess(exit) ? [] : exit.cause.reasons), ...journalCause.reasons])
  )

export const journaled = <I, A, E, R>(node: GraphNode<I, A, E, R>): GraphNode<I, A, E, R> => {
  if (isJournaled(node)) return node

  const run = (input: I): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const journal = yield* Journal
      const runInfo = yield* RunInfo
      const encodedInput = renderable(yield* encodeBestEffort(node.input, input))
      const attempt = yield* journal.attempt(node.name)

      // A recorded success replays only after it decodes against the node's *current* success
      // schema. Reading a file is a trust boundary, and a schema that has changed since the
      // predecessor ran makes the recorded value the wrong shape — decoding is what turns that
      // into a fresh run rather than a wrong answer.
      const recorded = yield* journal.recorded(node.name, attempt, encodedInput)

      if (Option.isSome(recorded)) {
        const replayed = yield* decodeBestEffort(node.success, recorded.value)
        if (Option.isSome(replayed)) {
          // Uninterruptible: a supervisor kill arriving mid-append would otherwise end the run
          // with a torn pair, or none at all. The fresh-run path gets this protection from
          // `onExit`'s own semantics for its end entry; the replay path has to ask for it, and it
          // asks for it across BOTH appends, so a kill between them can never leave a start entry
          // with no matching end (a predecessor's start-without-end re-runs fresh, and a replay
          // must never look like that to the run resumed from it).
          yield* Effect.uninterruptible(
            Effect.gen(function* () {
              const startedAt = yield* nowIso
              yield* appendRow(
                journal,
                startRow({ run: runInfo, node: node.name, attempt, input: encodedInput, timestamp: startedAt })
              )
              const endedAt = yield* nowIso
              yield* appendRow(
                journal,
                replayedEndRow({
                  run: runInfo,
                  node: node.name,
                  attempt,
                  input: encodedInput,
                  timestamp: endedAt,
                  success: recorded.value
                })
              )
            })
          )
          return replayed.value
        }
      }

      // The entered entry lands before the node's own work starts, so a process killed mid-node
      // still names the node it died inside. A failed append here dies exactly
      // like a failed exit append below — an incomplete record cannot read as authoritative.
      // Left interruptible, unlike the replay pair above: wrapping this in `Effect.uninterruptible`
      // was tried and probed (an interrupt requested during the write is masked until the region
      // ends, then fires at that exact boundary — before `node.run` is ever entered, so its `onExit`
      // finalizer never registers). That trades one gap for a worse one: the write either lands
      // whole or not at all, either way before `node.run` starts, so the start-without-end case
      // covers it — the next resume just re-runs the node fresh.
      const startedAt = yield* nowIso
      yield* appendRow(
        journal,
        startRow({ run: runInfo, node: node.name, attempt, input: encodedInput, timestamp: startedAt })
      )

      // The exit entry is written by a finalizer, which is what makes the record survive an
      // interrupt arriving from outside — a supervisor killing the run, the CLI being signalled.
      // `Effect.exit` does not help there: an external interrupt unwinds straight past it and
      // nothing after it runs (probed against this Effect version), so a run killed mid-node would
      // end with no entry saying it was killed. `Effect.onExit` runs on all four outcomes,
      // uninterruptibly by construction, and the node's own
      // outcome reaches the caller untouched whenever the append lands; when the append itself
      // fails, `joiningCause` keeps the node's reasons in the exit rather than letting the journal
      // defect erase them.
      return yield* node.run(input).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            const endedAt = yield* nowIso
            const success = Exit.isSuccess(exit)
              ? renderable(yield* encodeBestEffort(node.success, exit.value))
              : Option.none<unknown>()

            yield* appendRow(
              journal,
              ranEndRow({
                run: runInfo,
                node: node.name,
                attempt,
                input: encodedInput,
                timestamp: endedAt,
                exit,
                success
              })
            )
          }).pipe(Effect.catchCause(joiningCause(exit)))
        )
      )
    })

  // The marker is deliberately non-enumerable: a node derived by spreading a made node
  // (`make({ ...base, name, run: fresh })`) must NOT inherit it, or `make` would see the copied
  // marker, skip the wrap, and produce exactly the silently-unjournalled node this constructor
  // exists to prevent. Spread copies enumerable own properties only.
  const wrapped = { ...node, run }
  Object.defineProperty(wrapped, JournaledMarker, { value: true })
  return wrapped
}
