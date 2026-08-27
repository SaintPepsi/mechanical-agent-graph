import { Data } from "effect"

/**
 * The declared suite exited non-zero. Carries the exit code and a size-capped tail of the run's
 * output — the tail because a suite's last lines are where the failing test and the summary live,
 * and capped because a journal row is not the place for a full test log. `reportPath` names
 * the same command/exitCode/tail written to disk, so a caller with a repair path to offer (a session
 * to resume) can hand that session a file rather than re-typing the tail into a prompt.
 */
export class VerificationFailed extends Data.TaggedError("VERIFICATION_FAILED")<{
  readonly command: string
  readonly exitCode: number
  readonly outputTail: string
  readonly reportPath: string
}> {}

/**
 * `writeArtifact`'s own `PlatformError` on the report write, caught and named, `build/errors.ts`'s
 * `BuildSummaryWriteFailed` precedent. The run stops rather than repairing a session against a path
 * nothing wrote.
 */
export class VerificationReportWriteFailed extends Data.TaggedError("VERIFICATION_REPORT_WRITE_FAILED")<{
  readonly runRoot: string
  readonly detail: string
}> {}

/**
 * `build/errors.ts`'s `BuildRunRootMissing` precedent, applied here for the same reason: a node
 * reached outside `runScopedLayers` is a wiring bug, not something a write-then-fail-later path
 * should paper over. Without this guard a red suite with no `runRoot` reaches `writeArtifact` and
 * fails `VerificationReportWriteFailed`, dropping the command/exitCode/outputTail `VerificationFailed`
 * exists to carry for a diagnostic `skills/develop-ticket-graph/SKILL.md`'s `VERIFICATION_FAILED`
 * bullet tells a human to read.
 */
export class VerificationRunRootMissing extends Data.TaggedError("VERIFICATION_RUN_ROOT_MISSING")<{}> {}
