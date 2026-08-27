/** The terseness standard, as data plus a pure renderer: one operative home for what "terse" means. */

/** One variant's decisions: the rules a rewrite must follow, and what it may touch. */
export interface TersenessParams {
  readonly rules: readonly string[]
  readonly scope: readonly string[]
}

/** No front-matter: this variant is spliced straight into a session's prompt, never installed or discovered. */
export const EVALUATOR_PARAMS: TersenessParams = {
  rules: [
    "Every prompt is a terse one-liner: one instruction, one line, scope stated exactly.",
    "Compress each instruction to its load-bearing facts; merge sentences that carry one instruction into one line.",
    "Never drop a fact to shorten a line.",
    "Leave already-terse prompts unchanged."
  ],
  scope: [
    "Prompt text only: the literal words a model session will be sent, wherever they sit in the diff.",
    "In a design document, a quoted prompt is in scope; the prose around it is not.",
    "Leave argued prose, quoted ticket text, and comments untouched."
  ]
}

/** Pure: params in, one string out. No parsing, no I/O, no dispatch-time facts. */
export const compilePromptTerseness = (params: TersenessParams): string =>
  "Rewrite every verbose prompt in this diff as a terse one-liner.\n\n" +
  "Rules:\n\n" +
  params.rules.map((rule) => `- ${rule}`).join("\n") +
  "\n\nScope:\n\n" +
  params.scope.map((line) => `- ${line}`).join("\n")
