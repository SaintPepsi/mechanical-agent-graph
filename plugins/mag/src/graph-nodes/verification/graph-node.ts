import { Effect, FileSystem, Schema } from "effect"
import {
  VerificationFailed,
  VerificationReportWriteFailed,
  VerificationRunRootMissing
} from "mag/graph-nodes/verification/errors"
import { writeArtifact } from "mag/runtime/artifact"
import { make } from "mag/runtime/graph-node.definition"
import { platform } from "mag/runtime/platform"
import { RunInfo, workdir } from "mag/runtime/run-info"
import { Shell } from "mag/runtime/shell"

/** Enough for the failing test names and the summary block; a full log belongs in the suite's own output, not a journal row. */
const TAIL_CAP = 4000

const tailOf = (stdout: string, stderr: string): string =>
  `${stdout}\n${stderr}`.trim().slice(-TAIL_CAP)

/**
 * Runs the repository's declared verification suite. The command is one shell line by nature
 * (`bun run typecheck && bun run test`), so the node runs it through `sh -c`, the way `worktree-add`
 * runs its setup command — `Shell` itself stays interpolation-free, and the choice of a shell is
 * this node's, made visibly. Where the command comes from is the caller's decision: the graph file
 * carries it as per-repository policy.
 *
 * `Shell` reports a non-zero exit as a result, not a failure (`runtime/shell.ts`), so the mapping
 * onto {@link VerificationFailed} happens here, where exit codes stop being data and start meaning
 * "the suite is red".
 *
 * `headSha` names the tree this call verifies; it is never read here.
 * `journaled` (`runtime/journal/journaled.ts`) computes a row's replay identity
 * from `input` alone, before `run` is ever entered — a `{ command }`-only input made every call
 * with the same command journal-identical regardless of which tree it ran against. Inside a
 * send-back loop (`build-under-review`) that let a resumed run replay a stale verification row
 * over a freshly built, unverified tree. The fix has to live in the input the journal matches on,
 * so the caller measures its own tree state (`build`'s baseline-measuring precedent,
 * `graph-nodes/build/graph-node.ts`) and passes it through — an unfit call with no sha to offer is
 * a caller that does not know what it is verifying, and that must fail to typecheck, not be
 * allowed to omit the field.
 *
 * A red suite writes its own evidence to `<runRoot>/verification-<n>.txt` before failing, so
 * a caller with a session to resume can point it at a file instead of re-typing the tail into a
 * prompt. Input and success stay untouched: `develop-graph`'s standalone call and `resolve-conflicts`
 * need no edit for a failure path they already propagate unchanged. `runRoot` is guarded the same
 * way `build`/`simplify`/`design` guard it, so a wiring bug fails `VERIFICATION_RUN_ROOT_MISSING`
 * instead of losing the exit code and tail to a `writeArtifact` call that can't land anywhere.
 */
export const verification = make({
  name: "verification",
  description: "Run the repository's declared verification suite and report the result.",
  input: Schema.Struct({ command: Schema.String, headSha: Schema.String }),
  success: Schema.Struct({ command: Schema.String }),
  run: (input) =>
    Effect.gen(function* () {
      const shell = yield* Shell
      const runInfo = yield* RunInfo
      // Before the suite runs at all, not just before the write, build/simplify/design precedent.
      if (runInfo.runRoot === "") return yield* Effect.fail(new VerificationRunRootMissing())

      const result = yield* shell.run(["sh", "-c", input.command], { cwd: workdir(runInfo) })
      if (result.exitCode !== 0) {
        const outputTail = tailOf(result.stdout, result.stderr)
        const fs = yield* FileSystem.FileSystem
        const reportPath = yield* writeArtifact(
          fs,
          runInfo.runRoot,
          "verification",
          [`Command: ${input.command}`, `Exit code: ${result.exitCode}`, "", outputTail].join("\n"),
          "txt"
        ).pipe(
          Effect.catch((error) =>
            Effect.fail(new VerificationReportWriteFailed({ runRoot: runInfo.runRoot, detail: String(error) }))
          )
        )
        return yield* Effect.fail(
          new VerificationFailed({
            command: input.command,
            exitCode: result.exitCode,
            outputTail,
            reportPath
          })
        )
      }

      return { command: input.command }
    }).pipe(Effect.provide(platform))
})
