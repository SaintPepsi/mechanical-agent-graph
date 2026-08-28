import { describe, expect, test } from "bun:test"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { Effect, Result, Schema } from "effect"
import { DesignRulingsUnreadable, DesignRulingsWriteFailed } from "mag/graph-nodes/design-rulings/errors"
import { inputExamples, successExamples } from "mag/graph-nodes/design-rulings/examples"
import { designRulings } from "mag/graph-nodes/design-rulings/graph-node"
import { interpretationRulingsSection } from "mag/graph-nodes/design-rulings/section"
import { isSchemaHandle } from "mag/runtime/graph-node.shape"
import { RunInfo, type RunInfoService } from "mag/runtime/run-info"
import { testRunInfo, withRunRoot as withNodeRunRoot } from "mag/test/node-fixture"

const INPUT = inputExamples[0]!

/** The template's own section, as a design that ruled on nothing carries it. */
const PLACEHOLDER_SECTION = [
  "## Interpretation Rulings",
  "",
  "Present when an AC's wording allows more than one reading. One row per ruling: the AC id, the chosen reading, and its basis: a ticket line, a rulings file, the code as it stands, or the existing behaviour kept.",
  "",
  "| AC | Reading | Basis |",
  "| --- | --- | --- |"
].join("\n")

const RULED_SECTION = [
  "## Interpretation Rulings",
  "",
  "| AC | Reading | Basis |",
  "| --- | --- | --- |",
  "| AC.02 | The cap counts send-backs, not passes | ticket line 14 |",
  "",
  "### Note",
  "",
  "The cap of 2 is the existing behaviour, kept."
].join("\n")

const design = (section: string): string => `# Cap — Design\n\n## Problem\n\nx\n\n${section}\n\n## Convention Rulings\n\nNone.\n`

const runWith = <A, E>(effect: Effect.Effect<A, E, never>, run: RunInfoService) =>
  Effect.runPromise(Effect.result(effect.pipe(Effect.provideService(RunInfo, run))))

const withRunRoot = <T>(fn: (runRoot: string, run: RunInfoService) => Promise<T>) => withNodeRunRoot("design-rulings", fn)

describe("interpretationRulingsSection", () => {
  test("a design with no such heading rules on nothing", () => {
    expect(interpretationRulingsSection("# Design\n\n## Problem\n\nx\n")).toBeUndefined()
  })

  test("the template's own placeholder under the heading rules on nothing", () => {
    expect(interpretationRulingsSection(design(PLACEHOLDER_SECTION))).toBeUndefined()
    expect(interpretationRulingsSection(design("## Interpretation Rulings\n\n"))).toBeUndefined()
  })

  test("a ruled section is returned whole, deeper headings included, up to the next section of its own level", () => {
    expect(interpretationRulingsSection(design(RULED_SECTION))).toBe(RULED_SECTION.split("\n").slice(2).join("\n"))
  })

  test("prose rulings count too: the check is on content under the heading, not on table rows", () => {
    expect(interpretationRulingsSection(design("## Interpretation Rulings\n\nAC.01 is read as the narrow case, per the ticket's example."))).toBe(
      "AC.01 is read as the narrow case, per the ticket's example."
    )
  })
})

describe("design-rulings", () => {
  test("the fixtures decode against its own schemas", () => {
    if (!isSchemaHandle(designRulings.input)) throw new Error("designRulings.input is not a Schema")
    for (const example of inputExamples) Schema.decodeUnknownSync(designRulings.input)(example)
    if (!isSchemaHandle(designRulings.success)) throw new Error("designRulings.success is not a Schema")
    for (const example of successExamples) Schema.decodeUnknownSync(designRulings.success)(example)
  })

  test("a ruled design lands a comment body in the run root naming the PR and carrying the section", () =>
    withRunRoot(async (runRoot, run) => {
      const designPath = join(runRoot, "design.md")
      writeFileSync(designPath, design(RULED_SECTION))
      const result = await runWith(designRulings.run({ ...INPUT, designPath }), run)

      expect(Result.isSuccess(result)).toBe(true)
      if (!Result.isSuccess(result)) return
      expect(result.success).toStrictEqual({ rulingsPath: `${runRoot}/design-rulings-1.md` })
      const body = readFileSync(`${runRoot}/design-rulings-1.md`, "utf8")
      expect(body.split("\n")[0]).toContain(`Interpretation rulings from the design behind ${INPUT.prUrl}, for ${INPUT.ticket}.`)
      expect(body).toContain("| AC.02 | The cap counts send-backs, not passes | ticket line 14 |")
      expect(body).toContain("The cap of 2 is the existing behaviour, kept.")
      expect(body).not.toContain("## Convention Rulings")
    }))

  test("a design that ruled on nothing yields no path and writes nothing", () =>
    withRunRoot(async (runRoot, run) => {
      const designPath = join(runRoot, "design.md")
      writeFileSync(designPath, design(PLACEHOLDER_SECTION))
      const result = await runWith(designRulings.run({ ...INPUT, designPath }), run)

      expect(Result.isSuccess(result) && result.success).toStrictEqual({})
      expect(readFileSync(designPath, "utf8")).toBe(design(PLACEHOLDER_SECTION))
    }))

  test("a missing design record is DesignRulingsUnreadable", () =>
    withRunRoot(async (runRoot, run) => {
      const result = await runWith(designRulings.run({ ...INPUT, designPath: join(runRoot, "absent.md") }), run)
      expect(Result.isFailure(result) && result.failure instanceof DesignRulingsUnreadable).toBe(true)
    }))

  test("an empty run root is DesignRulingsWriteFailed before any read", async () => {
    const result = await runWith(designRulings.run(INPUT), testRunInfo({ runRoot: "" }))
    expect(Result.isFailure(result) && result.failure instanceof DesignRulingsWriteFailed).toBe(true)
  })
})
