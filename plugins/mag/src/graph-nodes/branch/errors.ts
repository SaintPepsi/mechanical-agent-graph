import { Data } from "effect"

/**
 * The branch already existed and checking it out failed. Kept distinct from creation failing:
 * this side means the checkout itself broke (a dirty tree, a post-checkout hook exiting non-zero
 * — `git checkout` exits with its hook's own status), and the honest outcome is
 * to stop, never to fall through to the branch-creating form.
 */
export class BranchCheckoutFailed extends Data.TaggedError("BRANCH_CHECKOUT_FAILED")<{
  readonly branch: string
  readonly exitCode: number
  readonly stderr: string
}> {}

/** The branch did not exist and creating it from the base failed — typically a base ref that does not resolve. */
export class BranchCreateFailed extends Data.TaggedError("BRANCH_CREATE_FAILED")<{
  readonly branch: string
  readonly base: string
  readonly exitCode: number
  readonly stderr: string
}> {}
