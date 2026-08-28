import { Data, Effect, FileSystem } from "effect"
import { writeArtifact } from "mag/runtime/artifact"
import { platform } from "mag/runtime/platform"
import { RunInfo } from "mag/runtime/run-info"

/**
 * `<PREFIX>-<n>` to `n`, taken as the ticket id's trailing `-`-separated segment. Total, no guard:
 * by the time a ticket id reaches this seam it has already survived that exact same derivation once,
 * at `fetch-ticket`, which fails `TicketNotAddressable` for an id it can't map to a number before
 * `design` spends a token — a second check here would be a guard for a failure mode no run can
 * exhibit, which PRINCIPLES.md rules out: no guards for failures never experienced.
 */
export const issueNumber = (ticket: string): string => ticket.slice(ticket.lastIndexOf("-") + 1)

/** The description read or the body write failed: `writeArtifact`'s `PlatformError`, wrapped the way every other artifact writer wraps its own. */
export class PrBodyComposeFailed extends Data.TaggedError("PR_BODY_COMPOSE_FAILED")<{
  readonly descriptionPath: string
  readonly runRoot: string
  readonly detail: string
}> {}

/**
 * PR body: the writing session's description (read from `write-pr-body`'s own artifact), then
 * `Closes #<n>` alone for the tracker's parse, then the run id, written to `<runRoot>/pr-body-N.md`
 * and returned as that path. The description is never a value here: `create-pr` hands the file to
 * `gh pr create --body-file`, so the journal records two paths and no prose.
 */
export const prBody = (facts: { readonly descriptionPath: string }): Effect.Effect<string, PrBodyComposeFailed> =>
  Effect.gen(function* () {
    const runInfo = yield* RunInfo
    const fs = yield* FileSystem.FileSystem
    const n = issueNumber(runInfo.ticket)
    return yield* fs.readFileString(facts.descriptionPath).pipe(
      Effect.flatMap((description) =>
        writeArtifact(fs, runInfo.runRoot, "pr-body", `${description}\n\nCloses #${n}\n\nrun: ${runInfo.runId}`)
      ),
      Effect.mapError((error) =>
        new PrBodyComposeFailed({ descriptionPath: facts.descriptionPath, runRoot: runInfo.runRoot, detail: String(error) })
      )
    )
  }).pipe(Effect.provide(platform))
