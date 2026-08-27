/**
 * The words the composite's loop hands to a `build` dispatch through its own `addendum` field:
 * `build` stays design- and verification-ignorant, splicing whatever it's given verbatim, so the
 * loop that knows *why* the words exist owns them. Kept in a sibling module so `graph-node.ts`
 * stays about the loop as it grows, the same shape as `review-diff/principles.ts`, a sibling
 * module in a node folder.
 */

/** The first pass's own addendum, when a design record exists to work from: the design
 *  travels as a path, never as prose. `designPath` hangs from `recordsRoot`, which equals the build
 *  session's own cwd under `records: "committed"` but is a separate temp directory for a foreign
 *  target under the default `run-root` policy (`run-layers.ts`) — so the path can point outside the
 *  tree the session works in. Probed, not assumed (`PRINCIPLES.md`, Cold-start meaning): a session may
 *  `Read` an absolute path in a different git tree the same way it may `Write` one. */
export const designAddendum = (designPath: string): string =>
  [
    `A design session already thought this ticket through. Read the design at ${designPath} before`,
    "building, and build from it rather than re-deriving one, depart from it only where the",
    "repository proves it wrong, and say so in your summary when you do."
  ].join("\n")

/** The first pass's addendum when a reviewed plan exists: the plan is the task list, the design the record of why. Both travel as paths. */
export const planAddendum = (planPath: string, designPath: string): string =>
  [
    `A design session thought this ticket through and a plan session cut it into tasks, both reviewed. Work`,
    `through the plan at ${planPath} one task at a time, committing each; the design at ${designPath}`,
    "records why, read it when a task's reason is unclear. Depart from the plan only where the",
    "repository proves it wrong, and say so in your summary when you do."
  ].join("\n")

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
