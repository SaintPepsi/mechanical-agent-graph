import { Data } from "effect"

/**
 * The session ended but `design.md` it was told to write is absent, empty after trim, or
 * byte-identical to its pre-dispatch snapshot — the same "trust nothing, verify the file" rule
 * `discover`'s `DiscoverNoteMissing` and `envision-notation`'s `NotationVisionMissing` already
 * apply. `sessions` travels with it because the spend already happened by this point.
 */
export class DesignMissing extends Data.TaggedError("DESIGN_MISSING")<{
  readonly path: string
  readonly sessions: readonly string[]
}> {}

/**
 * A failed git read, nothing spent: the first pass's `git ls-files` for the rulings files,
 * `commitPath`'s git-failure constructor (`git add` failed), and the final `git rev-parse HEAD`
 * that stamps `headSha`, today's `design/errors.ts`'s `DesignGitFailed` shape, reused at every call
 * site. Under `records: "committed"` that `rev-parse` reads the HEAD the commit just made; under
 * the default `run-root`, nothing here commits, so it reads the tree's HEAD as it already stood.
 * `commitPath`'s own `onGitFailure` constructor needs the identical three-field shape for the
 * identical reason (a failed git read, nothing spent), so it reuses the same tag rather than mint a
 * second one carrying no new information.
 */
export class BrainstormGitFailed extends Data.TaggedError("BRAINSTORM_GIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/**
 * `commitPath`'s commit-failure constructor: `git commit` failed after a real design session
 * already produced `design.md`.
 * `commitPath`'s own contract requires one distinct from {@link BrainstormGitFailed} (`sessions` and
 * `stdout` ride only here), so this follows `NotationVisionCommitFailed`/`DiscoverCommitFailed`'s
 * naming convention rather than leave the call unconstructable.
 */
export class BrainstormCommitFailed extends Data.TaggedError("BRAINSTORM_COMMIT_FAILED")<{
  readonly argv: string
  readonly exitCode: number
  readonly stderr: string
  readonly stdout: string
  readonly sessions: readonly string[]
}> {}

/** `resume` was given with no `findingsPath`: a resumed pass carries only the send-back, so there is nothing to say to the session. `build/errors.ts`'s `BuildResumeEmpty`. */
export class BrainstormResumeEmpty extends Data.TaggedError("BRAINSTORM_RESUME_EMPTY")<{}> {}

/**
 * The mechanical copy of `design.md` into the run root failed — the run dir couldn't be made, or
 * the copy couldn't be written, after a real session already produced it. `design/errors.ts`'s
 * `DesignCopyFailed` precedent, generalised by `records.ts`'s `record`.
 */
export class BrainstormCopyFailed extends Data.TaggedError("BRAINSTORM_COPY_FAILED")<{
  readonly path: string
  readonly detail: string
  readonly sessions: readonly string[]
}> {}
