import { Effect, FileSystem, Schema } from "effect"
import {
  VerifyEscapesMutationFailed,
  VerifyEscapesProbeWriteFailed,
  VerifyEscapesRestoreFailed,
  VerifyEscapesRunRootMissing,
  VerifyEscapesSuiteRed
} from "mag/graph-nodes/verify-escapes/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell, type ShellResult } from "mag/runtime/shell"
import { Claim, Escape } from "mag/runtime/suite-escape"

/** `verification`'s own cap: the failing test names and the summary, never the whole log. */
const TAIL_CAP = 4000

/** What a probe run is compared on. `stderr` is left out: a runner's warnings vary with nothing the mutation changed. */
const observed = (result: ShellResult): string => `${result.exitCode}\n${result.stdout}`

/** How many times `find` occurs; a claim is only unambiguous at exactly one. */
const occurrences = (text: string, find: string): number => (find === "" ? 0 : text.split(find).length - 1)

/**
 * Proves or discards each claim mechanically. A claim survives only when all three hold: its
 * `find` occurs exactly once in its file, the suite stays green with the replacement applied, and
 * its probe's output differs between the original and the mutated tree. Anything else is
 * discarded, silently, because the claim was never more than a model's word and a discard is the
 * correct answer to an unproven one. A false positive is structurally impossible here: every
 * escape returned was applied, run and observed by this process.
 *
 * The tree is restored from the bytes read before the mutation, inside a finalizer, so an
 * interrupt mid-claim still puts the file back; the restore is then read back and compared, and a
 * mismatch is {@link VerifyEscapesRestoreFailed} rather than a tree left mutated. Claims run one
 * at a time, since two mutations at once would prove neither.
 *
 * The suite is run once on the untouched tree first: a red suite before any mutation would make
 * every claim look refuted, so it is refused as an unfit input instead.
 */
export const verifyEscapes = make({
  name: "verify-escapes",
  description: "Apply each claimed mutation, keep only those the suite misses and a probe observes, restore the tree.",
  input: Schema.Struct({
    claims: Schema.Array(Claim),
    /** The whole suite, one shell line run through `sh -c`, `verification`'s own convention. */
    command: Schema.String
  }),
  success: Schema.Struct({ escapes: Schema.Array(Escape), tried: Schema.Int }),
  run: (input) =>
    Effect.gen(function* () {
      const runInfo = yield* RunInfo
      if (runInfo.runRoot === "") return yield* Effect.fail(new VerifyEscapesRunRootMissing())
      const cwd = workdir(runInfo)
      const shell = yield* Shell
      const fs = yield* FileSystem.FileSystem

      const suite = () => shell.run(["sh", "-c", input.command], { cwd })
      const baseline = yield* suite()
      if (baseline.exitCode !== 0) {
        return yield* Effect.fail(
          new VerifyEscapesSuiteRed({
            command: input.command,
            exitCode: baseline.exitCode,
            outputTail: `${baseline.stdout}\n${baseline.stderr}`.trim().slice(-TAIL_CAP)
          })
        )
      }

      const escapes: Array<Escape> = []
      for (const claim of input.claims) {
        const absolute = cwd === undefined ? claim.path : `${cwd}/${claim.path}`
        // An unreadable path is the claim's error, not the node's: discarded like any other unproven claim.
        const original = yield* fs.readFileString(absolute).pipe(Effect.catch(() => Effect.succeed(undefined)))
        if (original === undefined || occurrences(original, claim.find) !== 1) continue

        const probePath = yield* writeArtifact(fs, runInfo.runRoot, "probe", claim.probeSource, "sh").pipe(
          Effect.catch((error) => Effect.fail(new VerifyEscapesProbeWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) })))
        )
        const probe = () => shell.run(["sh", probePath], { cwd })
        const before = observed(yield* probe())

        const survived = yield* Effect.acquireUseRelease(
          fs.writeFileString(absolute, original.replace(claim.find, () => claim.replace)).pipe(
            Effect.catch((error) => Effect.fail(new VerifyEscapesMutationFailed({ path: claim.path, detail: String(error) })))
          ),
          () =>
            Effect.gen(function* () {
              const mutated = yield* suite()
              if (mutated.exitCode !== 0) return false
              return observed(yield* probe()) !== before
            }),
          () =>
            Effect.gen(function* () {
              yield* fs.writeFileString(absolute, original).pipe(
                Effect.catch((error) => Effect.fail(new VerifyEscapesRestoreFailed({ path: claim.path, detail: String(error) })))
              )
              const restored = yield* fs.readFileString(absolute).pipe(
                Effect.catch((error) => Effect.fail(new VerifyEscapesRestoreFailed({ path: claim.path, detail: String(error) })))
              )
              if (restored !== original) {
                return yield* Effect.fail(new VerifyEscapesRestoreFailed({ path: claim.path, detail: "read back differs from the original bytes" }))
              }
            })
        )
        if (survived) {
          escapes.push({ path: claim.path, find: claim.find, replace: claim.replace, probeSource: claim.probeSource })
        }
      }
      return { escapes, tried: input.claims.length }
    }).pipe(Effect.provide(platform))
})
