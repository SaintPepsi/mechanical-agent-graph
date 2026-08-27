import { TICKET_TOKEN } from "mag/skills/design/tokens"

/**
 * The recon standard's definition, as data, not as a `.md` template — `src/skills/CLAUDE.md`'s
 * pattern, the same shape as `subtraction.ts`: this standard has exactly one variant
 * (`RECON_PARAMS`), no front-matter, and is never installed to disk. `compileRecon` is a pure
 * renderer, `(params) => string`, no I/O; the `discover` node compiles its own copy inside its own
 * runtime, at dispatch, and splices the result into the agent's prompt.
 *
 * What matters for recon content discipline is the findings and citation rules below: what a note
 * must report and how it must cite its claims. Where the note gets filed and how the pipeline
 * sequences it are concerns for the calling node, not for this standard.
 */

/** One variant's decisions: what a recon note must report, and the rules it reports under. */
export interface ReconParams {
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
 * The gate's only variant. `findings` are the note's sections in render order — reuse map first,
 * so ordering is enforced by data rather than by an instruction telling the session to sort
 * (Data Drives Behavior).
 */
export const RECON_PARAMS: ReconParams = {
  findings: [
    "Reuse map: which existing modules, components, or services already cover parts of this ticket, cited by name and path, versus what is genuinely new.",
    "Search method: derive search terms from the ticket's own nouns and their case variants (kebab/camel/snake/Pascal) and synonyms, never from export syntax.",
    "Relevant files: where the behaviour this ticket touches lives today — entry points, the modules it changes, where similar features already sit.",
    "Types and data shapes: the types, interfaces, schemas, enums, or config the change will read or extend, with their current definitions.",
    "Patterns and conventions: how the codebase already does this kind of thing, including the house micro-conventions a change will echo (log-tag/prefix style, error-message shape, comment idiom).",
    "Integration points: what calls into, or is called by, the area being changed; the consumers a change would ripple to.",
    "Constraints: existing contracts, validation rules, or behaviour that must not break.",
    "Open unknowns: questions the code alone could not resolve."
  ],
  rules: [
    "Cite every claim with a repo-relative path or path:line, and report only what you verified in the code, never what you assume is there.",
    "Every \"genuinely new\" claim in the reuse map names the searches that came up empty for it, and where they were run.",
    "Read no generated index and write none: the map is computed fresh, per ticket, by search.",
    "A contradiction between two documents is an open unknown quoting both, never silently resolved by picking one.",
    "The note is your only write."
  ]
}

/**
 * Assembles the standard: two labelled lists, nothing else — the same shape as
 * `compileSubtraction`. Terse deliberately: prompts are model-authored and model-specific, only
 * terse instructions survive a model change.
 */
export const compileRecon = (params: ReconParams): string =>
  [
    "Report:",
    ...params.findings.map((finding) => `- ${finding}`),
    "",
    "Rules:",
    ...params.rules.map((rule) => `- ${rule}`)
  ].join("\n")
