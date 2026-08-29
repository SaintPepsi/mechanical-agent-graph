import type { ChecklistStep, Concern } from "mag/skills/design/concern"
import { DISCOVER_DESTINATION } from "mag/skills/recon"
import { DESIGN_DESTINATION } from "mag/skills/design/write-and-confirm"
import { TICKET_TOKEN } from "mag/skills/design/tokens"

/**
 * The pipeline's own spine (`graphs/design-graph/graph.ts`), Envision ∥ Discover → Brainstorm, as
 * data a human-facing document can render without retyping it. `node` is the rename anchor:
 * `graphs/design-graph/lane.test.ts` asserts it against the live design-graph node's own `name`,
 * so a node rename reddens this module rather than the installed skill silently drifting from the
 * pipeline again. `node` is data only, never rendered: the installed skill's reader is outside
 * this repo and can resolve none of those strings, and cold-start meaning forbids naming an
 * identifier the reader can't resolve. Every `artifact` is imported from the destination's own
 * single home, never restated, so a human following the lane lands its artifacts exactly where the
 * pipeline lands them.
 */
export interface LaneStep {
  readonly node: string
  readonly title: string
  readonly artifact: string
  readonly summary: string
}

/** One stage per row: a stage's steps open together, so the first row is the parallel pair a reader
 * may enter from either side and the second is the join. Envision and Brainstorm share one artifact:
 * the shell is the design doc's first section, drawn before the recon is read, and the design is
 * completed around it in place. */
export const DESIGN_LANE: readonly (readonly LaneStep[])[] = [
  [
    {
      node: "envision-shell",
      title: "Envision",
      artifact: DESIGN_DESTINATION,
      summary: "draw the ideal shape of the built thing, one shell per matched stack, blind to what exists today, as the design doc's Envisioned Shell section and nothing else yet"
    },
    {
      node: "discover",
      title: "Discover",
      artifact: DISCOVER_DESTINATION,
      summary: "recon what the codebase already has, cited by path, never assumed"
    }
  ],
  [
    {
      node: "brainstorm",
      title: "Brainstorm",
      artifact: DESIGN_DESTINATION,
      summary: "complete the design doc around its shell, over discover's recon and this checklist"
    }
  ]
]

/** No `node` parenthetical: that string names nothing an installed skill's reader, outside this
 * repo, can resolve; the plain title plus what the step does is the whole rendered fact. */
const renderStep = (step: LaneStep): string => `**${step.title}** — ${step.summary} → \`${step.artifact}\``

/** `<TICKET>` reaches this document unfilled: a headless dispatch fills it before an agent ever sees
 * the prompt (`brainstorm/graph-node.ts`'s own `.replaceAll`); the installed file has no dispatch
 * step at all, so the reader is the caller. This is the earliest section a reader reaches after the
 * checklist that has already shown the token (`lane` is first in `INSTALLED_DESIGN.concerns`), so it
 * defines it here rather than leaving it to guess. */
const TOKEN_NOTE =
  `\`${TICKET_TOKEN}\` above and below is this session's ticket id; use a short kebab-case slug instead when ` +
  `none exists, the same slug everywhere it appears.\n\n`

/** Two checklist steps, read straight off `DESIGN_LANE`'s own first stage rather than a second copy of
 * its prose: the lane list names the design doc's shell section and `discover.md` as destinations, so
 * this session's own checklist has to be what writes them, or the names are just trivia a reader can't
 * act on. Only the parallel pair, not the join: the design doc is already the checklist's own "Write
 * design doc" step (`write-and-confirm.ts`), so restating it a third time here would be the fact
 * duplicated, not learned. */
const laneStep = (step: LaneStep): ChecklistStep => ({
  label: () => step.title,
  tail: `${step.summary} → \`${step.artifact}\``
})

/** Listed only in `INSTALLED_DESIGN` (`variants.ts`), first, so its two steps land as the checklist's
 * opening pair and its section reads as the overview right below it. The body is plain, repo-agnostic
 * prose: no pipeline node name, no "outside the pipeline" framing, since a standalone session has no
 * pipeline to run outside of, and every reader of an installed skill is outside this repo by
 * construction. Only stage two (`Brainstorm`) renders as a line here: stage one's rows are `steps`
 * above, verbatim, and `partition.test.ts`'s coverage proof requires every concern's fragment to
 * appear exactly once, so restating them a second time in this section would double-count rather
 * than describe; the intro sentence covers what they draw, in prose. */
export const lane: Concern<"any"> = {
  id: "lane",
  audience: "any",
  steps: [laneStep(DESIGN_LANE[0][0]), laneStep(DESIGN_LANE[0][1])],
  section: {
    heading: "## The Design Lane",
    body: () =>
      `This design follows one spine, **Envision ∥ Discover → Brainstorm**: draw the ideal shape of the ` +
      `built thing blind to what exists, as the design doc's first section, recon the codebase for what ` +
      `already covers this ground, then complete the design around the shell. Envision and Discover ` +
      `(checklist items 1 and 2) open together; enter from either side. Brainstorm joins them:\n\n${renderStep(DESIGN_LANE[1][0])}\n\n${TOKEN_NOTE}`
  }
}
