/**
 * The words the composite's loop hands to a `build` dispatch through its own `addendum` field:
 * `build` stays verification-ignorant, splicing whatever it's given verbatim, so the loop that
 * knows *why* the words exist owns them. Kept in a sibling module so `graph-node.ts` stays about
 * the loop as it grows, the same shape as `review-diff/principles.ts`, a sibling module in a node
 * folder.
 */

/**
 * A repair pass's own addendum: the loop resumes the session that produced a red head and
 * hands it the report `verification` already wrote, rather than re-typing the suite's tail into a
 * prompt. `build` is never told which suite ran or why, only where to read what failed.
 */
export const verificationAddendum = (reportPath: string): string =>
  [
    `Verification failed on this pass's head. Read the report at ${reportPath} and fix what it`,
    "names, then finish."
  ].join("\n")
