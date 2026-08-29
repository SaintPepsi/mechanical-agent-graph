/**
 * The subtraction standard's definition, as data, not as a `.md` template — `src/skills/
 * CLAUDE.md`'s pattern, simplified from `installed.ts`'s: this standard has exactly one
 * variant (`SIMPLIFY_PARAMS`), no front-matter, and is never installed to disk, so none of
 * `installed.ts`'s `INSTALLED_SKILLS`/front-matter machinery applies here. `compileSubtraction` is a
 * pure renderer, `(params) => string`, no I/O; the `simplify` node compiles its own copy inside its
 * own runtime, at dispatch, and splices the result straight into the agent's prompt.
 */

/** One variant's decisions: what a reduction may do, and what it may never touch. */
export interface SubtractionParams {
  readonly reductions: readonly string[]
  readonly limits: readonly string[]
}

/**
 * The gate's only variant. Five categories, as `reductions`; `limits` is what keeps this a
 * subtraction pass rather than a rewrite.
 */
export const SIMPLIFY_PARAMS: SubtractionParams = {
  reductions: [
    "Reuse over duplication: replace a copy with a call to the implementation that already exists.",
    "Dead branches removed: delete code no path can reach.",
    "Needless indirection collapsed: inline a wrapper that adds no behaviour of its own.",
    "Comments that don't earn their place deleted: state why, never what, or go.",
    "Prompt text compressed to terse one-liners: one instruction, one line, scope stated exactly, never a fact dropped to shorten a line."
  ],
  limits: [
    "Behaviour-preserving only. A change that alters behaviour is a bug, not a simplification.",
    "Touch nothing outside the diff's own range.",
    "A comment excusing a duplicate is itself a finding, not an excuse for keeping it."
  ]
}

/**
 * Assembles the standard: two labelled lists, nothing else. Terse deliberately: prompts are
 * model-authored and model-specific, and only terse, concise instructions survive a model change.
 */
export const compileSubtraction = (params: SubtractionParams): string =>
  [
    "Apply only:",
    ...params.reductions.map((reduction) => `- ${reduction}`),
    "",
    "Never:",
    ...params.limits.map((limit) => `- ${limit}`)
  ].join("\n")
