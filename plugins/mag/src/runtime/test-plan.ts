import { Schema } from "effect"

/**
 * The plan the TDD lane's nodes hand along: `test-plan` writes it, `write-red` and `implement`
 * read it, `red-green` and `tdd-build` route on it. One shape five nodes agree on, so it lives
 * here rather than in any one of them (`runtime/suite-escape.ts`'s reasoning).
 *
 * `bugItCatches` is non-empty by schema: a test nobody can name a bug for is not planned, and
 * that discipline is unconstructable to skip rather than a sentence a session is asked to honour.
 */
export const PlanEntry = Schema.Struct({
  /** The behaviour and its condition, never the function's name. */
  name: Schema.String,
  behaviour: Schema.String,
  /** The one-line wrong implementation this test goes red on. */
  bugItCatches: Schema.NonEmptyString,
  /** What the code promises not to do that this test pins: input left unchanged, a repeated call safe, no case folded. */
  negativeSpace: Schema.Array(Schema.String)
})
export type PlanEntry = typeof PlanEntry.Type

export const TestPlan = Schema.Array(PlanEntry)
export type TestPlan = typeof TestPlan.Type

/** The plan as prompt lines: one block per entry, the fields a session needs to write the test. */
export const renderPlan = (plan: TestPlan): string =>
  plan
    .map((entry, index) =>
      [
        `${index + 1}. ${entry.name}`,
        `   behaviour: ${entry.behaviour}`,
        `   bug it catches: ${entry.bugItCatches}`,
        ...(entry.negativeSpace.length === 0 ? [] : [`   negative space: ${entry.negativeSpace.join("; ")}`])
      ].join("\n")
    )
    .join("\n")
