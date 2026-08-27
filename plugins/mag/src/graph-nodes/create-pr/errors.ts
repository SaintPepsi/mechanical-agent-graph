import { Data } from "effect"

/**
 * The host is not one this node knows how to open a request on. `host` arrives as a launch input
 * (this repository declares `HOST` in `graphs/develop-graph/graph.ts`), and only three arms exist:
 * `github.com`, any hostname carrying `gitlab`, and `bitbucket.org`. Every other host — CodeCommit
 * included — lands here as a named failure rather than a silent fallthrough.
 */
export class UnsupportedHost extends Data.TaggedError("CREATE_PR_UNSUPPORTED_HOST")<{
  readonly host: string
}> {}

/**
 * The host CLI ran and failed — an auth problem, a missing repo, a network error. Distinct from
 * {@link UnsupportedHost}: the host is supported, the call against it broke. `stderr` carries the
 * CLI's own message; a parse failure of the CLI's output reports itself there with `exitCode` 0.
 */
export class CreatePrFailed extends Data.TaggedError("CREATE_PR_FAILED")<{
  readonly host: string
  readonly exitCode: number
  readonly stderr: string
}> {}
