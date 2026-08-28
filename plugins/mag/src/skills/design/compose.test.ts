import { readdirSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { clarifyingQuestions } from "mag/skills/design/clarifying-questions"
import { composeDesignPrompt, COMPOSED_PROMPT_BUDGET, MAX_ARG_STRLEN, promptBytes } from "mag/skills/design/compose"
import type { Audience } from "mag/skills/design/concern"
import { dialogueNorms } from "mag/skills/design/dialogue-norms"
import { STACKS } from "mag/skills/design/envisioning"
import { hardGate } from "mag/skills/design/hard-gate"
import { BRAINSTORM_DESIGN, HEADLESS_DESIGN, headlessDesign, INSTALLED_DESIGN } from "mag/skills/design/variants"

/** Modules in this directory that define no `Concern`: types, the composer, the ordered lists
 * themselves, and the dispatch-time token constants. Excluded from the disk scan below, the same way
 * `preamble` (a real concern, just never variant-listed) is excluded by id rather than by file. */
const NON_CONCERN_FILES = new Set(["concern.ts", "compose.ts", "variants.ts", "tokens.ts"])

/** `preamble` renders unconditionally in both layouts; it is not one of the 13 core concerns and is
 * never listed in a `Variant`, by design, not by omission. `envision-svelte`/`-effect`/`-graph-core`
 * are the same shape of exception — `headlessDesign` splices them in conditionally (by stack match),
 * so `headlessDesign([])`/`HEADLESS_DESIGN` never lists them, and this orphan scan would otherwise
 * flag every one as authored-but-unreachable. `envision-generic` left this set once `INSTALLED_DESIGN`
 * started listing it directly: it's reachable through a real `Variant` now, the same way
 * `reconciliation` already was. */
const UNLISTED_IDS = new Set([
  "preamble",
  "envision-svelte",
  "envision-effect",
  "envision-graph-core"
])

/** Duck-types a module's export as a `Concern`: has an `id` and an `audience`, the two fields every
 * concern carries regardless of which regions it contributes to. */
const isConcern = (value: unknown): value is { readonly id: string; readonly audience: Audience } =>
  value !== null && typeof value === "object" && "id" in value && "audience" in value

/** The 13 core ids, in their authored order. */
const CORE_IDS = [
  "explore-context",
  "principles-stack",
  "no-too-simple",
  "approaches-rubric",
  "seams-ownership",
  "reference-sweep",
  "product-decisions",
  "design-doc-template",
  "write-and-confirm",
  "autonomy",
  "interpretation-rulings",
  "convention-rulings",
  "improvements"
]

describe("one concern, one module", () => {
  test("the 13 core ids are present in HEADLESS_DESIGN, each exactly once", () => {
    const ids = HEADLESS_DESIGN.concerns.map((concern) => concern.id)
    expect(ids).toEqual(CORE_IDS)
    expect(new Set(ids).size).toBe(CORE_IDS.length)
  })

  const installedIds = INSTALLED_DESIGN.concerns.map((concern) => concern.id)
  const headlessIds = [...HEADLESS_DESIGN.concerns, ...BRAINSTORM_DESIGN.concerns].map((concern) => concern.id)

  test("the 3 interactive ids are present in INSTALLED_DESIGN and in neither headless variant", () => {
    for (const id of ["hard-gate", "clarifying-questions", "dialogue-norms"]) {
      expect(installedIds).toContain(id)
      expect(headlessIds).not.toContain(id)
    }
  })

  test("autonomy is in both headless variants and not in INSTALLED_DESIGN — the mirror gate relies on this", () => {
    expect(HEADLESS_DESIGN.concerns.map((concern) => concern.id)).toContain("autonomy")
    expect(BRAINSTORM_DESIGN.concerns.map((concern) => concern.id)).toContain("autonomy")
    expect(installedIds).not.toContain("autonomy")
  })

  test("every Concern exported anywhere under skills/design is reachable — a module cannot be authored into orphanhood", async () => {
    // BRAINSTORM_DESIGN and INSTALLED_DESIGN are each reachable variants too — `reconciliation` and
    // `lane` are each listed in exactly one variant — omitting either union member here would flag a
    // real, wired concern as an orphan.
    const reachableIds = new Set(
      [...HEADLESS_DESIGN.concerns, ...BRAINSTORM_DESIGN.concerns, ...INSTALLED_DESIGN.concerns].map((concern) =>
        concern.id
      )
    )
    const files = readdirSync(import.meta.dir)
      .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !NON_CONCERN_FILES.has(name))
    expect(files.length).toBeGreaterThan(0)

    const foundIds: string[] = []
    for (const file of files) {
      const module: Record<string, unknown> = await import(`mag/skills/design/${file.slice(0, -3)}`)
      for (const exported of Object.values(module)) {
        if (isConcern(exported)) foundIds.push(exported.id)
      }
    }
    expect(foundIds.length).toBeGreaterThan(0)

    const orphans = foundIds.filter((id) => !reachableIds.has(id) && !UNLISTED_IDS.has(id))
    expect(orphans).toEqual([])
  })

  test("every concern in HEADLESS_DESIGN carries audience \"any\" or \"headless\", never \"interactive\" — the bidirectional type gate relies on this", () => {
    for (const concern of HEADLESS_DESIGN.concerns) expect(concern.audience).not.toBe("interactive")
  })
})

/** BRAINSTORM_DESIGN carries reconciliation and its template section, and carries no envisioning
 * module. `brainstorm`'s own dispatch draws no shell — the visions are already committed — so its
 * variant occupies the envisioning slot with `reconciliation` instead of a matched stack's module. */
describe("BRAINSTORM_DESIGN", () => {
  test("carries the 13 core ids plus reconciliation, and none of the four envisioning modules", () => {
    const ids = BRAINSTORM_DESIGN.concerns.map((concern) => concern.id)
    expect(ids).toEqual([...CORE_IDS.slice(0, 6), "reconciliation", ...CORE_IDS.slice(6)])
    for (const envisioningId of ["envision-svelte", "envision-effect", "envision-graph-core", "envision-generic"]) {
      expect(ids).not.toContain(envisioningId)
    }
  })

  test("carries reconciliation's own template section, \"Vision Reconciliation\"", () => {
    const headings = BRAINSTORM_DESIGN.templateSections.map((section) => section.heading)
    expect(headings).toContain("## Vision Reconciliation")
  })

  test("composeDesignPrompt(BRAINSTORM_DESIGN) carries reconciliation's own rule and the reconciliation heading, not any envisioning module's body", () => {
    const compiled = composeDesignPrompt(BRAINSTORM_DESIGN)
    expect(compiled).toContain("## Vision Reconciliation")
    expect(compiled).toContain("Each notation's vision document is the shell")
  })
})

describe("HEADLESS_DESIGN.templateSections — an authored order, pinned", () => {
  test("matches its own doc comment's order: Problem/Constraints open it, the rulings sections close it", () => {
    const headings = HEADLESS_DESIGN.templateSections.map((section) => section.heading)
    expect(headings).toEqual([
      "## Problem",
      "## Constraints",
      "## Approaches Considered",
      "## Chosen Approach",
      "## Envisioned Shell",
      "## Seams & Ownership",
      "## Reference Sweep",
      "## Architecture",
      "## Data Model",
      "## Error Handling",
      "## Testing Strategy",
      "## Principles Applied",
      "## Interpretation Rulings",
      "## Convention Rulings"
    ])
  })

  test("carries no Open Questions section: an autonomous design decides, so the template has no slot for a hedge", () => {
    for (const variant of [HEADLESS_DESIGN, BRAINSTORM_DESIGN, INSTALLED_DESIGN]) {
      expect(variant.templateSections.map((section) => section.heading)).not.toContain("## Open Questions")
      expect(composeDesignPrompt(variant)).not.toContain("Open Questions")
    }
  })

  test("is exactly the template sections HEADLESS_DESIGN's own concerns own — no more, no fewer, so the authored order can't drift from the concern list", () => {
    const owned = HEADLESS_DESIGN.concerns.flatMap((concern) => concern.templateSections ?? [])
    expect(HEADLESS_DESIGN.templateSections.map((section) => section.heading).sort()).toEqual(
      owned.map((section) => section.heading).sort()
    )
  })
})

const compiled = composeDesignPrompt(HEADLESS_DESIGN)

describe("headless carries no dead references into concerns it shares with INSTALLED_DESIGN", () => {
  test("no-too-simple's headless tail doesn't contradict autonomy's 'no approval is coming'", () => {
    expect(compiled).not.toContain("MUST present it and get approval")
    expect(compiled).toContain("but it is not optional")
  })

  test("seams-ownership's headless body doesn't point at the cut clarifying-questions step", () => {
    expect(compiled).not.toContain("Go back to clarifying questions")
  })
})

describe("disconfirming — headless variants carry no interactive text", () => {
  test("none of hard-gate's rendered lines appear in the headless prompt", () => {
    const lines = hardGate.section!.body(null).split("\n").filter((line) => line.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(compiled).not.toContain(line)
  })

  test("none of clarifying-questions' rendered step appears in the headless prompt", () => {
    const step = clarifyingQuestions.steps![0]!
    expect(compiled).not.toContain(step.label(null))
    expect(compiled).not.toContain("Ask questions one at a time")
    expect(compiled).not.toContain("Multiple-choice preferred")
  })

  test("none of dialogue-norms' rendered step or bullets appears in the headless prompt", () => {
    const step = dialogueNorms.steps![0]!
    expect(compiled).not.toContain(step.label(null))
    expect(compiled).not.toContain("Ask after each section whether it looks right")
    expect(compiled).not.toContain("Be ready to revise")
  })

  test("<HARD-GATE> disappearing while a fragment of its sentence survives elsewhere would be the failure this test guards against — line-level, not a keyword", () => {
    expect(compiled).not.toContain("<HARD-GATE>")
    expect(compiled).not.toContain("the user has approved it")
  })

  test("carries the concerns that take the vacated slots: autonomy, interpretation rulings, convention rulings", () => {
    expect(compiled).toContain("## Autonomy")
    expect(compiled).toContain("## Interpretation Rulings")
    expect(compiled).toContain("## Convention Rulings")
  })
})

describe("the composed prompt has headroom under the execve cap", () => {
  test("HEADLESS_DESIGN is exactly headlessDesign([]) — no envisioning module, the fixed thirteen", () => {
    expect(HEADLESS_DESIGN).toEqual(headlessDesign([]))
  })

  test("COMPOSED_PROMPT_BUDGET is a fraction of MAX_ARG_STRLEN, not an unrelated number", () => {
    expect(MAX_ARG_STRLEN).toBe(128 * 1024)
    expect(COMPOSED_PROMPT_BUDGET).toBeLessThan(MAX_ARG_STRLEN)
    expect(MAX_ARG_STRLEN % COMPOSED_PROMPT_BUDGET).toBe(0)
  })

  // No live caller composes `headlessDesign(STACKS.map(...))` anymore — verdicts-to-modules
  // envisioning moved to `compileEnvisionNotation`, one notation at a time, entirely outside
  // `headlessDesign`. The slot's real occupant now is `reconciliation` (`BRAINSTORM_DESIGN`), so the
  // worst-case budget check retargets to it.
  test("BRAINSTORM_DESIGN composes under budget — the real worst case now", () => {
    expect(promptBytes(composeDesignPrompt(BRAINSTORM_DESIGN))).toBeLessThan(COMPOSED_PROMPT_BUDGET)
  })

  test("the template heading set is identical however the envisioning splice varies — the fence's shape never depends on which stack matched", () => {
    const headingsOf = (concerns: Parameters<typeof headlessDesign>[0]) =>
      headlessDesign(concerns).templateSections.map((section) => section.heading)
    const none = headingsOf([])
    for (const stack of STACKS) expect(headingsOf([stack.concern])).toEqual(none)
    expect(headingsOf(STACKS.map((stack) => stack.concern))).toEqual(none)
  })
})
