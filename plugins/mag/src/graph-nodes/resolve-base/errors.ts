import { Data } from "effect"

/**
 * `git rev-parse --verify -q refs/heads/<base>` exited non-zero — the base does not exist
 * in this checkout. Checked first and alone (no remote call yet): a typo'd base fails on the cheap
 * local probe before a network call is ever made.
 */
export class BaseRefMissing extends Data.TaggedError("BASE_REF_MISSING")<{
  readonly base: string
}> {}

/**
 * `git ls-remote --exit-code --heads <remote> <base>` exited 2 — the remote was reached and
 * answered, but it has no such branch. A parent branch that resolves locally but was never pushed
 * cannot be a PR's `--base`, so this fails before `design` or `build` spend anything.
 */
export class BaseRemoteMissing extends Data.TaggedError("BASE_REMOTE_MISSING")<{
  readonly base: string
  readonly remote: string
}> {}

/**
 * The same `ls-remote` exited non-zero for any other reason (128 unreachable, and anything
 * else) — probed directly: exit `2` is "no such branch", every other
 * non-zero is a reachability problem. Kept distinct from {@link BaseRemoteMissing} so an offline
 * machine is never reported as a bad base.
 */
export class BaseRemoteUnavailable extends Data.TaggedError("BASE_REMOTE_UNAVAILABLE")<{
  readonly remote: string
  readonly exitCode: number
  readonly stderr: string
}> {}
