import { Schema } from "effect"

/**
 * The shape two sibling nodes both depend on — `gather-reviews` builds a `ReviewWindow`,
 * `analyse-reviews` reads one back. Runtime-owned because `import-surface`
 * (`graph-node.shape.ts`'s `ALLOW_RULES`) makes a sibling's private file unreachable from another
 * node by construction, and Central Type Ownership's own threshold ("used by two or more files")
 * independently points here.
 */

/**
 * Which rows count as a review pass at all, and what they count as: outcome `ok` is a clean pass,
 * tag `REVIEW_BLOCKED` is a send-back, tag `REVIEW_DISPUTE_REJECTED` is the adjudicating pass that
 * still blocked. Every other outcome/tag pair (`REVIEW_HEAD_MOVED`, a git failure, a die) burned no
 * judgment and dilutes the window, so it is neither counted nor listed — `gather-reviews`'s own
 * `reviewPasses` is the table this type names.
 */
export const VERDICTS = ["clean", "blocked", "dispute-rejected"] as const
export type Verdict = (typeof VERDICTS)[number]

/** The four ways a send-back is attributed — a closed set, so a fifth is a row, not a branch. */
export const ATTRIBUTIONS = ["review-untargeted", "build-loose", "design-gap", "legitimate-catch"] as const
export type Attribution = (typeof ATTRIBUTIONS)[number]

/**
 * One review-diff pass, indexed from its own journal rows and (for `findingsPath`) the run's own
 * `review-diff-*.md` artifacts. `findingsPath`/`buildSummaryPath`/`designPath`/`disputePath` are
 * `NullOr` rather than optional keys: a real absence (a disputed pass has no matching build success
 * row to read `buildSummaryPath` from) is a fact this schema states, not a key this schema drops.
 */
export const ReviewPassSchema = Schema.Struct({
  /** `<ticket>/<runId>#<pass>` — unique across every run this machine has ever recorded. */
  id: Schema.String,
  projectKey: Schema.String,
  ticket: Schema.String,
  graph: Schema.String,
  runId: Schema.String,
  runRoot: Schema.String,
  /** The `review-diff` node's own journal `attempt` for this run — 1-based, per node, per run. */
  pass: Schema.Int,
  verdict: Schema.Literals(VERDICTS),
  /** The journal end row's own tag — absent on a clean pass, which journals no tag at all. */
  tag: Schema.optionalKey(Schema.String),
  headSha: Schema.String,
  startedAt: Schema.String,
  endedAt: Schema.String,
  reviewModel: Schema.optionalKey(Schema.String),
  reviewAgent: Schema.optionalKey(Schema.String),
  findingsPath: Schema.NullOr(Schema.String),
  buildSummaryPath: Schema.NullOr(Schema.String),
  designPath: Schema.NullOr(Schema.String),
  disputePath: Schema.NullOr(Schema.String),
  /** A blocked pass's own session ids never reach the journal: `[]` on every non-clean pass. */
  sessions: Schema.Array(Schema.String)
})
export type ReviewPass = typeof ReviewPassSchema.Type

export const REVIEW_WINDOW_SCHEMA = "graph/review-window@1" as const

export const ReviewWindowSchema = Schema.Struct({
  schema: Schema.Literal(REVIEW_WINDOW_SCHEMA),
  size: Schema.Int,
  since: Schema.String,
  through: Schema.String,
  transcriptsRoot: Schema.String,
  passes: Schema.Array(ReviewPassSchema)
})
export type ReviewWindow = typeof ReviewWindowSchema.Type
