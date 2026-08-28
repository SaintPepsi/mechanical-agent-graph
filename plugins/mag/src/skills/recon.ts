import { TICKET_TOKEN } from "mag/skills/design/tokens"

/**
 * The recon standard's definition, as data, not as a `.md` template — `src/skills/CLAUDE.md`'s
 * pattern, the same shape as `subtraction.ts`: this standard has exactly one variant
 * (`RECON_PARAMS`). `compileRecon` is a pure renderer, `(params) => string`, no I/O; the `discover`
 * node compiles its own copy inside its own runtime, at dispatch, and splices the result into the
 * agent's prompt, and the installed `discover` skill (`installed.ts`) renders the same text under
 * an interactive opening, so the step and the skill cannot drift from each other.
 *
 * What matters for recon content discipline is the learning question, the findings and the
 * citation rules below: what a note must report and how it must cite its claims. Where the note
 * gets filed and how the pipeline sequences it are concerns for the calling node, not for this
 * standard.
 */

/** One variant's decisions: the question a note answers, what it must report, and the rules it reports under. */
export interface ReconParams {
  readonly question: string
  readonly findings: readonly string[]
  readonly rules: readonly string[]
}

/**
 * Single home for the discover node's destination: the write instruction the node splices into the
 * prompt (`discover/graph-node.ts`'s `promptFor`) and the node's own path composer both read this,
 * so they cannot disagree — `write-and-confirm.ts`'s `DESIGN_DESTINATION` precedent. `TICKET_TOKEN` is
 * imported rather than restated, the way `write-pr-body` already imports it.
 */
export const DISCOVER_DESTINATION = `docs/graph/${TICKET_TOKEN}/discover.md`

/**
 * The gate's only variant. The note answers one task-agnostic learning question, the maintainer's
 * original discover phase: learn how the thing works today, and report what exists. `findings` are
 * the note's sections in render order — reuse map first, so ordering is enforced by data rather
 * than by an instruction telling the session to sort (Data Drives Behavior). Each entry is a path
 * and one line; the size rule below is what keeps a note readable whole by the design session.
 */
export const RECON_PARAMS: ReconParams = {
  question:
    "Reframe the ticket as one learning question of the form \"How does X currently work today?\" and write it as the note's first line. Answer it by reading the code. Report what exists; the design decides what changes.",
  findings: [
    "Reuse map: which existing modules, components, or services already cover parts of this ticket, cited by name and path, versus what is genuinely new.",
    "Relevant files: where the behaviour this ticket touches lives today, one line per file: entry points, the modules it changes, where similar behaviour already sits, and the consumers a change would ripple to, each line carrying the house micro-convention a change there will echo (log-tag style, error-message shape, comment idiom) where it matters.",
    "Constraints: existing contracts, validation rules, or behaviour that must not break.",
    "Open unknowns: questions the code alone could not resolve."
  ],
  rules: [
    "Derive search terms from the ticket's own nouns and their case variants (kebab/camel/snake/Pascal) and synonyms, never from export syntax.",
    "Cite every claim with a repo-relative path or path:line, and report only what you verified in the code, never what you assume is there.",
    "Every \"genuinely new\" claim in the reuse map names the searches that came up empty for it, and where they were run.",
    "Read no generated index and write none: the map is computed fresh, per ticket, by search.",
    "A contradiction between two documents is an open unknown quoting both, never silently resolved by picking one.",
    "Keep the note to what the next reader needs to find each file: a path and one line per entry; the reader opens the file for the rest.",
    "The note is your only write."
  ]
}

/**
 * Assembles the standard: the question, then two labelled lists — the same shape as
 * `compileSubtraction` under one opening line. Terse deliberately: prompts are model-authored and
 * model-specific, only terse instructions survive a model change.
 */
export const compileRecon = (params: ReconParams): string =>
  [
    params.question,
    "",
    "Report:",
    ...params.findings.map((finding) => `- ${finding}`),
    "",
    "Rules:",
    ...params.rules.map((rule) => `- ${rule}`)
  ].join("\n")
