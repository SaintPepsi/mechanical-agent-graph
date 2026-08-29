import { TICKET_TOKEN } from "mag/skills/design/tokens"

/**
 * The plan standard's definition, as data, `recon.ts`'s shape: one variant (`PLAN_PARAMS`), no
 * front-matter, never installed to disk. `compilePlan` is a pure renderer, `(params) => string`;
 * the `plan` node compiles its own copy at dispatch and splices the result into the prompt.
 *
 * What the standard governs is the plan's content: what a plan states and the rules a task is cut
 * under. Where the plan is filed and what runs it are the calling node's concerns.
 *
 * Acceptance criteria are quoted, never cited by id alone: the plan is the builder's whole
 * contract and the builder never reads the ticket, so an id here would name what its reader cannot
 * resolve.
 */

/** One variant's decisions: what a plan states, in render order, and the rules its tasks obey. */
export interface PlanParams {
  readonly sections: readonly string[]
  readonly rules: readonly string[]
}

/** Single home for the plan's destination, `DISCOVER_DESTINATION`'s precedent: the node's write instruction and its path composer both read this. */
export const PLAN_DESTINATION = `docs/graph/${TICKET_TOKEN}/plan.md`

/**
 * The standard's only variant. `sections` are the plan's parts in render order, so ordering is
 * enforced by data rather than by an instruction telling the session to sort.
 */
export const PLAN_PARAMS: PlanParams = {
  sections: [
    "Goal: one sentence stating what the plan builds, and the acceptance criteria it proves, each quoted in full beside its id.",
    "Resolution table: one row per symbol the design names: reuse (exists, path), repurpose (exists, the change it needs), create (new file, exact path, one-line responsibility) or extract (inline today at path:lines, moved to a shared home, plus one replace row per existing site).",
    "Tasks: one per created, changed or extracted symbol, in build order, each stating the files it creates or changes with exact paths, the failing test it starts from with the command that runs that one test, the smallest implementation that makes it pass, and the commit.",
    "Criteria map: every acceptance criterion quoted in full beside its id, the task that proves it, and the one-line edit to the shipped module that would make that task's test fail."
  ],
  rules: [
    "Write for an engineer with zero context for this codebase: every path exact, every command runnable as written, every step one action.",
    "A condition a task detects names the signal the design designates for it, never a fact about how the data happens to be shaped; when the design names no signal, adding one is its own task.",
    "Check the recycle scan before any create row: a name it finds in the repo is prior art to resolve, and rebuilding what exists is a plan defect.",
    "An extract leaves no straggler: every existing inline site of the same logic gets its own replace task in this plan.",
    "Before saving, sweep the tasks once for contradictions: a condition one task detects whose inputs another task changes is resolved here, not left for the build.",
    "The plan is your only write."
  ]
}

/** Assembles the standard: two labelled lists, `compileRecon`'s shape. Terse deliberately: prompts are model-authored and only terse instructions survive a model change. */
export const compilePlan = (params: PlanParams): string =>
  [
    "The plan states:",
    ...params.sections.map((section) => `- ${section}`),
    "",
    "Rules:",
    ...params.rules.map((rule) => `- ${rule}`)
  ].join("\n")
