import { posix } from "node:path"

/**
 * One concern of the design prompt, and nothing else. Every module beside this one exports exactly
 * one `Concern`. Its prose exists nowhere else in the codebase. A concern never knows which variant
 * it is in; `compose.ts`'s `composeDesignPrompt` is the only thing that assembles a list of concerns
 * into a document. `variants.ts`'s ordered lists are the only place a variant's shape is authored,
 * `installed.ts` included — there is no second assembler.
 */

/** Where a concern's text may appear. `interactive` and `headless` are the type-level gate,
 * bidirectional: `Variant<A>.concerns` accepts only `Concern<A | "any">`, so listing an interactive
 * concern in a headless variant, or `autonomy` in the interactive one, is a compile error at the
 * list. The one place every variant passes through. Not a runtime filter. */
export type Audience = "any" | "interactive" | "headless"

/** Citations resolve against a root, once `<SKILLS>` is filled at dispatch, or stay relative to the
 * installed skill's own directory. */
export type CitationRoot = string | null

/** Resolves one citation against a root. `null` returns the citation as written in the installed
 * skill, relative to its own directory; a root re-roots it the same way `posix.join` always has.
 * Shared by every concern whose text cites another skill file. Not itself a concern, kept beside the
 * type it resolves. */
export const citation = (root: CitationRoot, relative: string): string => (root === null ? relative : posix.join(root, relative))

/** An envisioning module's prose is its `plugins/mag/docs/envision/*.envision.md` file (a Bun text import), the
 * maintainer-editable single source — the module carries no copy of the discipline, it splices the
 * document into the composed prompt, so the content travels with the prompt and a design session in
 * a target repo never needs this repository's paths. The doc's own `# title` line belongs to the
 * doc, not to the composed prompt's heading hierarchy, so the splice starts after it. */
export const envisionDocBody = (doc: string): string => `${doc.replace(/^# .*\n+/, "").trim()}\n\n`

/** The concern's own block of the composed prompt. An empty `heading` means the text continues the
 * previous concern's heading rather than opening its own (e.g. `reference-sweep`'s paragraph, which
 * sits under `seams-ownership`'s `## The Envisioned Shell`). */
export interface Section {
  readonly heading: string
  readonly body: (root: CitationRoot) => string
}

/** One `##` block of the design-doc template, owned by the concern that owns what it records. */
export interface TemplateSection {
  readonly heading: string
  readonly body: string
}

/** A checklist step, renumbered at render so a dropped concern leaves no gap. `label` takes `root`
 * because one step (`principles-stack`'s) cites a file the same way its section does. A concern whose
 * step a test names directly (`partition.test.ts`'s owned-fragment lists) exports it as a named
 * `STEP` too, so the test reaches it without an unsafe index into an optional array. */
export interface ChecklistStep {
  readonly label: (root: CitationRoot) => string
  readonly tail: string
}

/**
 * A concern is its id plus whichever of the three regions it contributes to. `steps` is plural
 * because a concern can own more than one checklist entry: `write-and-confirm` owns three sequential
 * ones (write, confirm, return), and one file per concern fixes the count, so a plural field is what
 * lets one file hold three steps instead of splitting the concern to satisfy a singular type.
 */
export interface Concern<A extends Audience> {
  readonly id: string
  readonly audience: A
  readonly steps?: readonly ChecklistStep[]
  readonly section?: Section
  readonly templateSections?: readonly TemplateSection[]
}
