import { Schema } from "effect"

/**
 * The currency of the adversarial review lane: a mutation that escaped a test suite. Shared
 * machinery rather than any one node's own because five nodes pass the same value along
 * (`break` claims it, `verify-escapes` proves it, `judge-severity` rates it, `adversarial-review`
 * and `tdd-build` route on it), and a shape five nodes agree on is a boundary no single node can
 * own alone. Not `runtime/escape.ts`, which is string quoting for scaffolded source.
 *
 * A claim is untrusted: a model's assertion that one find/replace on one file changes observable
 * behaviour while the suite stays green. `probeSource` is a POSIX `sh` script, run from the
 * repository root, whose output must differ before and after the replacement; a shell script
 * rather than a runner-specific file, so the claim decides how to invoke the code and the verifier
 * stays codebase-agnostic. An escape is a claim the verifier confirmed, the rationale dropped so the
 * severity judge rates the mutation blind to the breaker's own framing. A rated escape adds the
 * judged category and the severity the table below derives from it.
 */
export const Claim = Schema.Struct({
  /** Repo-relative path of the one source file the replacement applies to. */
  path: Schema.String,
  /** Must occur exactly once in the file; a claim whose find is absent or ambiguous is discarded. */
  find: Schema.String,
  replace: Schema.String,
  probeSource: Schema.String,
  rationale: Schema.String
})
export type Claim = typeof Claim.Type

export const Escape = Schema.Struct({
  path: Schema.String,
  find: Schema.String,
  replace: Schema.String,
  probeSource: Schema.String
})
export type Escape = typeof Escape.Type

/**
 * Severity is a lookup on the category, never a number the model emits: a judge picks one word
 * from a closed list and the table decides how bad that is, so a persuasive rationale cannot argue
 * a mutation up or down the scale. Three is the worst class; zero is nothing a gate acts on.
 *
 * | category   | severity | what escaped                                                        |
 * | ---------- | -------- | ------------------------------------------------------------------- |
 * | data-loss  | 3        | data is dropped, overwritten or corrupted                           |
 * | isolation  | 3        | one caller, tenant or key can see or change another's state         |
 * | durability | 3        | a write that should persist does not, or is not awaited             |
 * | quota      | 2        | a limit, budget or count is enforced wrongly                        |
 * | boundary   | 1        | an edge value (off by one, empty, a limit) is handled wrongly       |
 * | cosmetic   | 0        | output shape or wording changes with no behavioural consequence     |
 */
export const ESCAPE_CATEGORIES = ["data-loss", "isolation", "durability", "quota", "boundary", "cosmetic"] as const
export type EscapeCategory = (typeof ESCAPE_CATEGORIES)[number]

export const SEVERITY_BY_CATEGORY: Readonly<Record<EscapeCategory, number>> = {
  "data-loss": 3,
  isolation: 3,
  durability: 3,
  quota: 2,
  boundary: 1,
  cosmetic: 0
}

export const severityOf = (category: EscapeCategory): number => SEVERITY_BY_CATEGORY[category]

export const RatedEscape = Schema.Struct({
  ...Escape.fields,
  category: Schema.Literals(ESCAPE_CATEGORIES),
  severity: Schema.Int
})
export type RatedEscape = typeof RatedEscape.Type

/** The worst rating in a set, `0` for none: what a gate compares against its threshold. */
export const maxSeverity = (rated: ReadonlyArray<RatedEscape>): number =>
  rated.reduce((worst, escape) => Math.max(worst, escape.severity), 0)
