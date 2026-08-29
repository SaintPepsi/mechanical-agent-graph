import { readFileSync } from "node:fs"
import { describe, expect, test } from "bun:test"
import { autonomy } from "mag/skills/design/autonomy"
import { composeDesignPrompt } from "mag/skills/design/compose"
import type { CitationRoot } from "mag/skills/design/concern"
import { INSTALLED_DESIGN } from "mag/skills/design/variants"
import { INSTALLED_SKILLS, installedPath, renderInstalled, SKILLS_ROOT } from "mag/skills/installed"
import { DISCOVER_STANDARD } from "mag/skills/recon"

/**
 * The drift gate: proves every installed row hasn't drifted from what a fresh render produces.
 * Lives here beside the manifest it walks (`INSTALLED_SKILLS`), since `compile-skill` is the only
 * thing that writes bytes to disk and this is what backs that guarantee.
 */
describe("every installed row matches a fresh render", () => {
  for (const skill of INSTALLED_SKILLS) {
    test(`${skill.name}/SKILL.md on disk matches renderInstalled(skill)`, () => {
      const onDisk = readFileSync(installedPath(SKILLS_ROOT, skill.name), "utf8")
      expect(onDisk).toBe(renderInstalled(skill))
    })
  }
})

describe("the installed discover skill renders the step's own standard", () => {
  const discover = INSTALLED_SKILLS.find((skill) => skill.name === "discover")!

  test("the row's body opens with DISCOVER_STANDARD whole, the maintainer's phase text verbatim", () => {
    expect(discover.body().startsWith(DISCOVER_STANDARD)).toBe(true)
    expect(discover.body()).toContain("No problem-solving. Just learning.")
  })

  test("a perturbed standard drifts the installed bytes off disk", () => {
    const perturbedSkill = { ...discover, body: () => discover.body().replace(DISCOVER_STANDARD, `${DISCOVER_STANDARD} †PERTURBED†`) }
    expect(renderInstalled(perturbedSkill)).not.toBe(readFileSync(installedPath(SKILLS_ROOT, "discover"), "utf8"))
  })
})

const brainstorming = INSTALLED_SKILLS.find((skill) => skill.name === "brainstorming")!
const onDisk = readFileSync(installedPath(SKILLS_ROOT, "brainstorming"), "utf8")

describe("the installed skill renders from concern modules via composeDesignPrompt", () => {
  test("the row's body is exactly composeDesignPrompt(INSTALLED_DESIGN) — no second, byte-pinned layout", () => {
    expect(brainstorming.body()).toBe(composeDesignPrompt(INSTALLED_DESIGN))
  })

  // Per concern, not one sample: a concern the composer silently
  // dropped would leave `composeDesignPrompt` unchanged, so each of `INSTALLED_DESIGN`'s concerns gets
  // its own perturbation-and-compare, not just the one that happened to be picked. Only `steps`/`section` are perturbed: `templateSections` render from `Variant`'s own
  // field, never read back off `concern.templateSections` (`compose.ts`'s `renderTemplate`), so
  // perturbing it here would silently perturb nothing.
  const PERTURB_SUFFIX = " †PERTURBED†"
  const perturbConcern = (concern: (typeof INSTALLED_DESIGN.concerns)[number]) => {
    const steps = concern.steps
    const section = concern.section
    if (steps === undefined && section === undefined) {
      throw new Error(`concern "${concern.id}" contributes neither steps nor a section — nothing to perturb`)
    }
    return {
      ...concern,
      ...(steps === undefined ? {} : { steps: steps.map((step) => ({ ...step, tail: `${step.tail}${PERTURB_SUFFIX}` })) }),
      ...(section === undefined ? {} : {
        section: { heading: section.heading, body: (root: CitationRoot) => `${section.body(root)}${PERTURB_SUFFIX}\n` }
      })
    }
  }

  describe("the check is proven to bite, per concern", () => {
    for (const concern of INSTALLED_DESIGN.concerns) {
      test(`perturbing "${concern.id}" alone drifts the installed bytes off disk`, () => {
        const perturbed = {
          ...INSTALLED_DESIGN,
          concerns: INSTALLED_DESIGN.concerns.map((c) => (c.id === concern.id ? perturbConcern(c) : c))
        }
        // renderInstalled(perturbedSkill), not composeDesignPrompt(perturbed) alone: the latter
        // is body-only, so it always differs from `onDisk`'s front-matter +
        // body — every one of these 17 assertions passed vacuously, even with the concern deleted
        // outright. Comparing the full rendered artifact is what makes the perturbation the thing
        // that has to move the needle.
        const perturbedSkill = { ...brainstorming, body: () => composeDesignPrompt(perturbed) }
        expect(renderInstalled(perturbedSkill)).not.toBe(onDisk)
      })
    }
  })

  test("opens with the front-matter block naming the skill", () => {
    expect(onDisk.startsWith("---\nname: brainstorming\n")).toBe(true)
  })

  test("carries no <SKILLS> token, and keeps citations relative to its own directory", () => {
    expect(onDisk).not.toContain("<SKILLS>")
    expect(onDisk).toContain("`./principles/index.md`")
    expect(onDisk).toContain("`../writing-plans/SKILL.md`")
  })

  // Neither token is filled in the installed copy. `<TICKET>` has a substituting caller only in a
  // headless dispatch (`design/tokens.ts`); `<notation>` has none anywhere — it stands for whichever
  // matched stack the reader is on. So the document has to define both itself.
  test("<TICKET> and <notation> are self-defined in the document, not left for the reader to guess", () => {
    expect(onDisk).toContain("<TICKET>")
    expect(onDisk).toContain("this session's ticket id")
    expect(onDisk).toContain("short kebab-case slug")
    expect(onDisk).toContain("<notation>")
    expect(onDisk).toContain("matched stack's vision")
  })

  // The session writes the design doc; the node checks, copies and (by policy) commits it, so the
  // installed skill never tells the model to run git.
  test("the confirm step tells the session not to run git", () => {
    expect(onDisk).toContain("**Confirm the design doc**")
    expect(onDisk).toContain("do not run git")
    expect(onDisk).not.toContain("`git add`")
  })

  test("carries hard-gate's approval text, an interactive-only concern", () => {
    expect(onDisk).toContain("<HARD-GATE>")
    expect(onDisk).toContain("the user has approved it")
  })

  test("carries none of autonomy's headless text — a human is in the room for the installed skill", () => {
    const lines = autonomy.section!.body(null).split("\n").filter((line) => line.trim().length > 0)
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(onDisk).not.toContain(line)
    expect(onDisk).not.toContain("## Autonomy")
  })
})
