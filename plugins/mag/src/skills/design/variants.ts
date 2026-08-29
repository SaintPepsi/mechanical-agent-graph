import { posix } from "node:path"
import { approachesRubric } from "mag/skills/design/approaches-rubric"
import { autonomy } from "mag/skills/design/autonomy"
import type { Concern } from "mag/skills/design/concern"
import type { Variant } from "mag/skills/design/compose"
import { clarifyingQuestions } from "mag/skills/design/clarifying-questions"
import { conventionRulings } from "mag/skills/design/convention-rulings"
import { designDocTemplate, TEMPLATE_OPEN_SECTIONS, TEMPLATE_TAIL_SECTIONS } from "mag/skills/design/design-doc-template"
import { dialogueNorms } from "mag/skills/design/dialogue-norms"
import { envisionGeneric } from "mag/skills/design/envision-generic"
import { exploreContext } from "mag/skills/design/explore-context"
import { hardGate } from "mag/skills/design/hard-gate"
import { improvements } from "mag/skills/design/improvements"
import { interpretationRulings } from "mag/skills/design/interpretation-rulings"
import { lane } from "mag/skills/design/lane"
import { noTooSimple } from "mag/skills/design/no-too-simple"
import { principlesStack } from "mag/skills/design/principles-stack"
import { productDecisions } from "mag/skills/design/product-decisions"
import { referenceSweep } from "mag/skills/design/reference-sweep"
import { seamsOwnership } from "mag/skills/design/seams-ownership"
import { shellDrawn } from "mag/skills/design/shell-drawn"
import { SKILLS_TOKEN } from "mag/skills/design/tokens"
import { writeAndConfirm } from "mag/skills/design/write-and-confirm"

/** The ordered lists below are the only place a variant's shape is authored. */

/** The installed skill's own directory, relative to the skills root: what the headless variant's
 * re-rooted citations resolve against once `<SKILLS>` is filled at dispatch. */
const SKILL_DIR = "brainstorming"

/**
 * The design node's dispatch: the 13 core concerns, in the order the ticket names them, citations
 * re-rooted under `<SKILLS>/brainstorming`. `templateSections` is authored separately (`Variant`'s
 * own doc comment): Problem/Constraints open the fence, the approaches/shell/sweep concerns record
 * what was decided, the technical sections and Principles Applied follow, and the two rulings
 * concerns take the slot `## The Process`'s retirement freed and close the fence: every choice is
 * a ruling with a basis, so nothing sits after them.
 *
 * `envisioning` slices in after `reference-sweep` and before `product-decisions` — the shell
 * is drawn (`seams-ownership`), the codebase is swept (`reference-sweep`), then this slot's concerns
 * run before decisions are recorded. `[]` (no probes run, or none matched) reproduces the original
 * fixed thirteen exactly, which is `HEADLESS_DESIGN` below. The same slot carries
 * `[shellDrawn]` for `BRAINSTORM_DESIGN`: a design pass whose own session already drew the shell
 * into the design doc, blind, so the slot's job there is completing the design around it rather
 * than drawing one.
 */
export const headlessDesign = (envisioning: readonly Concern<"any">[]): Variant => ({
  citationRoot: posix.join(SKILLS_TOKEN, SKILL_DIR),
  concerns: [
    exploreContext,
    principlesStack,
    noTooSimple,
    approachesRubric,
    seamsOwnership,
    referenceSweep,
    ...envisioning,
    productDecisions,
    designDocTemplate,
    writeAndConfirm,
    autonomy,
    interpretationRulings,
    conventionRulings,
    improvements
  ],
  templateSections: [
    ...TEMPLATE_OPEN_SECTIONS,
    ...approachesRubric.templateSections!,
    ...seamsOwnership.templateSections!,
    ...referenceSweep.templateSections!,
    // The envisioning slot's own template sections, same position as the slot's concerns
    // themselves (right after reference-sweep, above). `[]` for every variant today (none of the
    // four envision-*.ts modules nor `shellDrawn` carries one), kept so a slot concern that needs a
    // section lands it here rather than in the composer.
    ...envisioning.flatMap((concern) => concern.templateSections ?? []),
    ...TEMPLATE_TAIL_SECTIONS,
    ...principlesStack.templateSections!,
    ...interpretationRulings.templateSections!,
    ...conventionRulings.templateSections!
  ]
})

export const HEADLESS_DESIGN: Variant = headlessDesign([])

/**
 * `brainstorm`'s own dispatch: the shell is already drawn, by the same session's blind first pass
 * (`envision-shell`), so this variant carries `shellDrawn` instead of a matched stack's envisioning
 * module in the same slot (`headlessDesign`'s own doc comment above). No `verdicts`, no probes:
 * `brainstorm` always gets the same variant, which is what makes `assemble-brainstorm-prompt`'s
 * input `{}`.
 */
export const BRAINSTORM_DESIGN: Variant = headlessDesign([shellDrawn])

/**
 * The installed skill's own variant, `Variant<"interactive">` — a human is in the room, so
 * `hardGate`/`clarifyingQuestions`/`dialogueNorms` are listed (a compile error in `headlessDesign`'s
 * `Variant<"headless">`) and `autonomy` is not (the mirror compile error, now that `autonomy` is
 * `Concern<"headless">`). Citations stay relative to the skill's own directory (`citationRoot: null`),
 * the same reasoning `headlessDesign`'s re-rooting exists to undo once `<SKILLS>` is filled at
 * dispatch — this document is never dispatched, it's read from its own directory.
 *
 * `envisionGeneric` occupies the envisioning slot, not `shellDrawn`: `shellDrawn`'s premise, "the
 * shell already stands in the design doc", is `brainstorm/graph-node.ts`'s own dispatch guarantee,
 * never a standalone `/brainstorming` session's, since nothing draws a shell before a human runs
 * this skill directly, so this variant draws its own shell instead of citing one that was never
 * produced, the same fallback a headless dispatch gets when no probe matches. `lane` is listed only
 * here, `envisionGeneric`'s own precedent (a concern listed in exactly one variant, reachable by the
 * orphan scan through it).
 */
export const INSTALLED_DESIGN: Variant<"interactive"> = {
  citationRoot: null,
  concerns: [
    lane,
    hardGate,
    noTooSimple,
    exploreContext,
    principlesStack,
    clarifyingQuestions,
    approachesRubric,
    seamsOwnership,
    referenceSweep,
    envisionGeneric,
    productDecisions,
    designDocTemplate,
    dialogueNorms,
    writeAndConfirm,
    interpretationRulings,
    conventionRulings,
    improvements
  ],
  // `envisionGeneric` contributes no sections of its own, so the empty-envisioning-slot fence is
  // this variant's too.
  templateSections: HEADLESS_DESIGN.templateSections
}
