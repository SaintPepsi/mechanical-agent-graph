import { Schema } from "effect"
import { verdictSchema } from "mag/runtime/claude/verdict-schema"

/**
 * The reviewer charter every review session runs under, one source for `review-plan` and
 * `review-diff`: the baseline is the ticket, the target is what the node names, and the rules and
 * the output channels are word for word the same, so the two reviews are the same reviewer at two
 * altitudes. The `acs` target joins here when a review-acs node lands; until then the charter knows
 * two targets and no attachments slot.
 *
 * Two channels, one gate: `blocking` is the only list a node fails on. Notes are recorded in the
 * findings file and never gate, so a reviewer has somewhere to put a style remark that is not a
 * send-back. There is no questions channel: an autonomous run has nobody to answer one, so a
 * reviewer judges instead, and an unjudgeable "is X intentional" is a design that failed to rule.
 */
export type ReviewTarget = "plan" | "diff"

/** The artifact a plan-altitude finding says must change: the loop resumes that artifact's own session. */
export const FINDING_TARGETS = ["design", "plan"] as const
export type FindingTarget = (typeof FINDING_TARGETS)[number]

/** The diff target has one artifact, so its blocking findings are lines. */
export const REVIEW_VERDICT = verdictSchema(
  Schema.Struct({
    blocking: Schema.Array(Schema.String),
    notes: Schema.Array(Schema.String)
  })
)

/** An adjudicating pass's ruling on one disputed finding: upheld means the dispute is right and the finding is settled. */
const DISPUTE_RULING = Schema.Struct({ finding: Schema.String, upheld: Schema.Boolean })
export type DisputeRuling = typeof DISPUTE_RULING.Type

/**
 * The plan target has two artifacts, so every blocking finding names the one that must change.
 * `disputed` is filled by an adjudicating pass only, one ruling per finding the dispute names;
 * `optionalKey` so an ordinary pass is shown no key at all rather than a nullable union.
 */
export const PLAN_REVIEW_VERDICT = verdictSchema(
  Schema.Struct({
    blocking: Schema.Array(Schema.Struct({ target: Schema.Literals(FINDING_TARGETS), finding: Schema.String })),
    notes: Schema.Array(Schema.String),
    disputed: Schema.optionalKey(Schema.Array(DISPUTE_RULING))
  })
)

/** One findings line, the target first so a resumed session can pick out its own. */
export const targetedFinding = (target: FindingTarget, finding: string): string => `${target}: ${finding}`

export interface ReviewVerdict {
  readonly blocking: readonly string[]
  readonly notes: readonly string[]
  /** Present on an adjudicating pass's record, so the run's own files say how the dispute went. */
  readonly disputed?: readonly DisputeRuling[]
}

/** What the pass is judging, and the one question it answers about it. */
const TARGET: Record<ReviewTarget, string> = {
  plan: "Target: the plan named above. Question: does the plan, built exactly as written, satisfy every acceptance criterion?",
  diff: "Target: the diff named above. Question: does the code as written do what the ticket requires? Finish with one fresh-eyes skim of the whole branch for what the diff view hides: dead files, stale docs, commits that do not read as one change."
}

/**
 * The plan target's two extra hunts. The design is the plan's input and nothing else's: the plan
 * carries whatever seams and principles it applies, in its own words, so both audits judge the
 * plan's own statement of them rather than a design file the reviewer never reads. A plan that
 * applies a seam or a principle without stating it is a plan finding on that ground alone.
 */
const PLAN_AUDITS: readonly string[] = [
  "",
  "Structure audit: the plan states the seams it commits to, each with an exact path, and a task builds every one there. A seam the plan never states, one collapsed into another file, or an extract resolved as a copy, is blocking; so is a created module whose responsibility re-implements logic that already exists elsewhere, unless the plan quotes a principle that licenses the duplication.",
  "Principles audit: the plan states the principles it applies and cites where each comes from. Check it honours every rule it claims, that a deviation quotes a real escape clause from the file it names, and that a plan naming no principles at all is blocking on that ground alone.",
  "Prior-art hunt: for every symbol, module or capability the plan introduces, derive search terms from its own nouns (name variants across kebab, camel and snake case, filenames, concepts) and search the repo. Prior art covering it is blocking, cited path:line."
]

const RULES = (target: ReviewTarget): readonly string[] => [
  "",
  "Rules:",
  "1. Report only. Read, and run read-only commands; every fix flows from the verdict, never from an edit of yours.",
  "2. Cite every finding with a repo-relative path or path:line, and report only what you verified by reading the target or running a read-only command.",
  `3. Hunt what no tool can tell the author: a missed or misread acceptance criterion, a wrong or risky approach, an unhandled input, state or failure mode, a hidden assumption the ticket or code does not guarantee, a data-integrity or security gap.${
    target === "diff" ? " Duplicated logic across sibling files is a note naming the sites and the helper that would absorb them." : ""
  }`,
  "4. Leave mechanics to the toolchain: exact symbol names, imports, formatting, typecheck predictions, which test file breaks. Spend the pass on what the compiler, linter and test runner cannot see.",
  "5. A finding states the defect and its evidence, never a fix or a mechanism: the author owns the remedy, and a suggested one draws the answer onto the suggestion instead of the defect."
]

const OUTPUT = (target: ReviewTarget): readonly string[] => [
  "",
  "Output, two lists, each finding on one line (path:line, summary, why):",
  `- blocking: shipped as-is, an acceptance criterion is unmet or behaviour is wrong; cite the criterion or concrete evidence.${
    target === "plan"
      ? " For a plan: the approach cannot satisfy a criterion, a task as written would produce wrong behaviour, or a required task is missing. Tag each blocking finding with the artifact that must change: design when the design decided wrongly or left it undecided, plan when the design is right and the plan departs from it."
      : ""
  }`,
  "- notes: everything else: cosmetic, style, documented deferrals, optional improvements, anything the toolchain will catch.",
  "No questions. Nobody answers one in this run. Where the record settles \"is X intentional\", it is settled; where it does not, judge it yourself: take the ideal reading, the best one where none is clearly ideal, the pragmatic one where you cannot tell; blocking if the omission breaks a criterion, a note otherwise, stating the reading you took."
]

/** A first pass hunts the whole target; a re-review judges the delta against the prior findings and stops there. */
const framing = (priorFindingsPath: string | undefined): string =>
  priorFindingsPath === undefined
    ? "You are an adversarial reviewer. Find where the target fails to meet the ticket. Read only what this brief names and judge only against the baseline."
    : `You are an adversarial reviewer on a re-review. A prior pass raised blocking findings, recorded at ${priorFindingsPath}, and the session that owns each finding's artifact was resumed over it. Judge whether each prior blocking finding is fixed and whether the change introduced a new blocker. A finding the first pass did not make is not raised now unless it is blocking. Settled items stay settled.`

/**
 * The charter's lines, ready to splice after the node's own target lines. Pure: the node names the
 * ticket and the target by path above this block, so the text refers to "the ticket named above"
 * rather than carrying a path of its own.
 */
export const compileReviewBrief = (target: ReviewTarget, priorFindingsPath?: string): readonly string[] => [
  framing(priorFindingsPath),
  "",
  "Baseline: the ticket named above, its acceptance criteria verbatim. Verify the target against those words as written. The target does not get to define what done means.",
  "",
  TARGET[target],
  ...(target === "plan" ? PLAN_AUDITS : []),
  ...RULES(target),
  ...OUTPUT(target)
]

/** One bullet list, or the sentence that says the list is empty, so a record never shows a bare heading. */
const list = (items: readonly string[], empty: string): string =>
  items.length > 0 ? items.map((item) => `- ${item}`).join("\n") : empty

/**
 * The findings record, one file per pass. The first line names the sha the pass judged, the shape
 * `gather-reviews` matches on; blocking comes first because it is the only channel a consumer routes on.
 * The dispute section appears only on an adjudicating pass, so every other record keeps its shape.
 */
export const renderFindings = (headSha: string, verdict: ReviewVerdict): string =>
  [
    `Reviewed at ${headSha}`,
    "",
    list(verdict.blocking, "No blocking findings."),
    "",
    "Notes:",
    list(verdict.notes, "None."),
    ...(verdict.disputed === undefined || verdict.disputed.length === 0
      ? []
      : ["", "Dispute:", list(verdict.disputed.map(({ finding, upheld }) => `${upheld ? "upheld" : "rejected"}: ${finding}`), "")])
  ].join("\n")
