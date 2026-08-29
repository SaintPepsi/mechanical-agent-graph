import { describe, expect, test } from "bun:test"
import { CHECKLIST_HEADER, composeDesignPrompt, renderSection, TEMPLATE_FRAME, type Variant } from "mag/skills/design/compose"
import { STEP as clarifyingStep } from "mag/skills/design/clarifying-questions"
import type { Audience } from "mag/skills/design/concern"
import { dialogueNorms } from "mag/skills/design/dialogue-norms"
import { envisionSvelte } from "mag/skills/design/envision-svelte"
import { preamble } from "mag/skills/design/preamble"
import { PLAN_BOUNDARY_BULLET } from "mag/skills/design/seams-ownership"
import { DESIGN_DESTINATION } from "mag/skills/design/write-and-confirm"
import { headlessDesign, HEADLESS_DESIGN, INSTALLED_DESIGN } from "mag/skills/design/variants"

/**
 * The partition is asserted complete for both composed variants — `HEADLESS_DESIGN` (a pipeline
 * dispatch) and `INSTALLED_DESIGN` (the installed skill, which renders from the same composed
 * concerns rather than a second, bespoke layout). Every string either variant composes is
 * attributable to a named owner: one of the concerns the variant lists, or the explicit `GLUE` list
 * below (the frame the concerns render into — `## Checklist`'s heading, the template's fence).
 * `DESIGN_DESTINATION` proves the assertion actually depends on real exports, not copied literals.
 */

/** The frame every variant's concerns render into: no concern owns these lines.
 * Shared by both variants now that neither carries a second, bespoke layout. */
const GLUE: readonly string[] = [CHECKLIST_HEADER, TEMPLATE_FRAME.header, TEMPLATE_FRAME.fenceOpen, TEMPLATE_FRAME.fenceClose]

/**
 * Strips each fragment out of `document` and asserts nothing but composer-owned checklist numbering
 * is left. `split(fragment).join("")` removes every occurrence in one pass, so anything but exactly
 * one occurrence's worth of length removed means the fragment is either missing (0: two modules
 * defining the same prose already consumed it, or it was never there), duplicated (a multiple of
 * `fragment.length`: two modules do define the same prose), or was swallowed as a substring of an
 * earlier fragment already removed (0, same as missing) — the three ways "exactly one concern's
 * fragments" can silently fail that stripping alone cannot distinguish from real coverage.
 */
const expectFullyClaimed = (document: string, fragments: readonly string[]): void => {
  let remainder = document
  for (const fragment of fragments) {
    const before = remainder.length
    remainder = remainder.split(fragment).join("")
    const removed = before - remainder.length
    if (removed !== fragment.length) {
      throw new Error(
        `expected to remove exactly one occurrence (${fragment.length} chars) of fragment starting ` +
          `"${fragment.slice(0, 40)}", removed ${removed} chars instead`
      )
    }
  }
  // Checklist numbering ("1. ", "2. ", ...) is `compose.ts`'s `renderChecklist`, composer-owned
  // rendering rather than any concern's prose. Same treatment as `CHECKLIST_HEADER`.
  const leftoverLines = remainder.replace(/^\d+\.\s*$/gm, "").split("\n").map((line) => line.trim()).filter((line) =>
    line.length > 0
  )
  expect(leftoverLines).toEqual([])
}

/**
 * One entry per concern's contiguous block, read off the variant rather than retyped once per
 * variant: a step is its checklist line minus the composer-owned number, a section renders through
 * the same `renderSection` the composer calls, and the fenced template's blocks come from the
 * variant's own authored `templateSections` (the set every concern's `templateSections` feeds).
 * Reading the concerns off the variant is what makes this a coverage proof rather than a transcript:
 * a concern the composer silently dropped still contributes its fragment here, and stripping it
 * removes nothing. `preamble` leads because the composer renders it unconditionally, outside
 * `concerns`.
 */
const ownedFragments = (variant: Variant<Audience>): readonly string[] => {
  const root = variant.citationRoot
  return [
    renderSection(root, preamble.section),
    ...variant.concerns.flatMap((concern) => [
      ...(concern.steps ?? []).map((step) => `**${step.label(root)}** — ${step.tail}`),
      ...(concern.section === undefined ? [] : [renderSection(root, concern.section)])
    ]),
    ...variant.templateSections.flatMap((section) => [section.heading, section.body])
  ]
}

describe("the headless composition is asserted complete", () => {
  test("every fragment HEADLESS_DESIGN renders is claimed exactly once", () => {
    expectFullyClaimed(composeDesignPrompt(HEADLESS_DESIGN), [...ownedFragments(HEADLESS_DESIGN), ...GLUE])
  })
})

/**
 * The installed variant's own coverage proof: the concerns differ (the interactive three plus `lane`
 * in, `autonomy` out, `envisionGeneric` occupies the envisioning slot, not `shellDrawn`, whose
 * shell-already-drawn premise a standalone session never satisfies), and
 * citations resolve against the skill's own directory (`citationRoot: null`) rather than
 * `<SKILLS>/brainstorming`.
 */
const INSTALLED_ROOT = INSTALLED_DESIGN.citationRoot
const INSTALLED_PROMPT = composeDesignPrompt(INSTALLED_DESIGN)

describe("the installed composition is asserted complete", () => {
  test("every fragment INSTALLED_DESIGN renders is claimed exactly once", () => {
    expectFullyClaimed(INSTALLED_PROMPT, [...ownedFragments(INSTALLED_DESIGN), ...GLUE])
  })

  test("dialogue-norms and clarifying-questions render by name, not just their bullets", () => {
    expect(INSTALLED_PROMPT).toContain(dialogueNorms.steps![0]!.label(INSTALLED_ROOT))
    expect(INSTALLED_PROMPT).toContain(clarifyingStep.label(INSTALLED_ROOT))
  })

  test("DESIGN_DESTINATION is a real export the checklist actually renders — the installed skill's default is deterministic now", () => {
    expect(INSTALLED_PROMPT).toContain(DESIGN_DESTINATION)
    expect(DESIGN_DESTINATION).toContain("<TICKET>")
  })
})

/**
 * `seams-ownership` renders `PLAN_BOUNDARY_BULLET` and the shared "before presenting the design..."
 * framing clause unconditionally, so `envisionSvelte` must not restate either. Counted directly
 * rather than through `expectFullyClaimed`'s whole-block strips: those pass as long as each
 * concern's *entire* rendered block appears exactly once, which does not by itself rule out a
 * smaller shared phrase appearing inside two different concerns' blocks.
 */
describe("seams-ownership / envision-svelte do not duplicate shared framing when svelte matches", () => {
  const svelteMatched = composeDesignPrompt(headlessDesign([envisionSvelte]))
  const occurrences = (haystack: string, needle: string): number => haystack.split(needle).length - 1

  test("PLAN_BOUNDARY_BULLET's text renders exactly once", () => {
    expect(occurrences(svelteMatched, PLAN_BOUNDARY_BULLET(HEADLESS_DESIGN.citationRoot))).toBe(1)
  })

  test("the shared 'draw the desired outcome as' framing clause renders exactly once", () => {
    expect(occurrences(svelteMatched, "draw the desired outcome as")).toBe(1)
  })
})
