import { citation, type ChecklistStep, type CitationRoot, type Concern } from "mag/skills/design/concern"

/** Notation-neutral: the tail names no stack, so a headless prompt teaches only the notation its
 *  matched probe called for. Carried for every audience, headless included: the shell is drawn
 *  whether or not a human is in the room. */
export const STEP: ChecklistStep = {
  label: () => "Envision the shell",
  tail: `draw the chosen approach as a shell: the ideal shape of the built thing (see "The Envisioned Shell" below)`
}

/** Notation-neutral — whatever drew the shell, the seams table closes it the same way. The
 *  component-markup rules live in `envision-svelte.ts`, not here: a non-svelte prompt carrying
 *  "literal markup naming every visual region as a component tag" is what the per-stack envisioning
 *  split exists to prevent. */
const SEAMS_TABLE =
  `Alongside the shell, fill the **Seams & Ownership** table: each named part with an owner — server / shared package / app (adapt the owner set to the repo's real layers). Shared-vs-local is a design-time call, never deferred to the plan.\n\n`

/** The framing every variant's prompt gets, once, whichever stack (if any) matched. Rendered
 *  unconditionally by this concern's own section, so no envisioning module may restate it in its own
 *  body: a module that did would render this sentence's opening clause twice in a matched prompt.
 *  That is why the envisioning modules open with their own stack-specific framing instead
 *  ("Effect's notation: ...", "Svelte's notation: ..."). Does not
 *  point at "the envisioning module (below)" by name: `HEADLESS_DESIGN` carries none there at all,
 *  and this sentence must stay true whether the slot below draws a shell or (`envisionGeneric`)
 *  just names a notation to draw it in. */
const HEADLESS_INTRO =
  `Before presenting the design, draw the desired outcome as a shell: the ideal shape of the built thing, blind to the current mess, in whichever notation the matched stack calls for.\n\n`

/** Notation-neutral: the design/plan boundary holds unconditionally, regardless of which notation
 *  (if any) drew the shell above it — `HEADLESS_DESIGN`'s own suite (`compose.test.ts`) expects this
 *  citation even with zero envisioning modules spliced in. */
export const PLAN_BOUNDARY_BULLET = (root: CitationRoot): string =>
  `- **No file paths, no resolution verbs.** The design names *what exists* and *who owns it*; the plan (the sibling \`${
    citation(root, "../writing-plans/SKILL.md")
  }\`) resolves every symbol against the codebase (reuse / repurpose / create / extract) and has final say on *where it lives*. Stating a fact in the ownership table ("already lives in the shared package") is a design call and fine; assigning a resolution verb or a path is the plan's job.\n`

/** The join between the per-notation visions: whichever notation drew the shell, the seams table
 * closes it the same way. Carried for every audience, headless
 * included. Its section's final paragraph (the sweep trigger) is `reference-sweep`'s, not this
 * concern's: it names a different obligation and review-diff gates on it independently. */
export const seamsOwnership: Concern<"any"> = {
  id: "seams-ownership",
  audience: "any",
  steps: [STEP],
  section: {
    heading: "## The Envisioned Shell",
    body: (root) => HEADLESS_INTRO + PLAN_BOUNDARY_BULLET(root) + "\n" + SEAMS_TABLE
  },
  templateSections: [
    {
      heading: "## Envisioned Shell",
      body:
        "<!-- the feature drawn in the matched stack's own notation;\n     tags/factories/rails may not exist yet; NO file paths -->"
    },
    {
      heading: "## Seams & Ownership",
      body: "| Seam | Responsibility | Owner (server / shared package / app) |\n| --- | --- | --- |"
    }
  ]
}
