import { interpretationRulings } from "mag/skills/design/interpretation-rulings"

/**
 * The section is located by the heading the compiled skill's own template put there, never by a
 * markdown parse: the design record is this pipeline's artifact contract (`design-doc-template.ts`),
 * so its heading is a string the pipeline authored and can search for verbatim.
 */
const SECTION = interpretationRulings.templateSections![0]!
const HEADING = SECTION.heading

/** The template's own lines under the heading: a section carrying only these has ruled on nothing. */
const PLACEHOLDER = new Set(SECTION.body.split("\n").map((line) => line.trim()).filter((line) => line !== ""))

/** A section ends at the next heading of its own level or above; deeper headings belong to it. */
const closes = (line: string): boolean => /^#{1,2}\s/.test(line)

/**
 * The Interpretation Rulings section's body, or `undefined` when the design ruled on nothing: the
 * heading is absent, or everything under it is blank or the template's own placeholder text.
 */
export const interpretationRulingsSection = (design: string): string | undefined => {
  const lines = design.split("\n")
  const start = lines.findIndex((line) => line.trim() === HEADING)
  if (start === -1) return undefined
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(closes)
  const body = end === -1 ? rest : rest.slice(0, end)
  const ruled = body.some((line) => line.trim() !== "" && !PLACEHOLDER.has(line.trim()))
  return ruled ? body.join("\n").trim() : undefined
}
