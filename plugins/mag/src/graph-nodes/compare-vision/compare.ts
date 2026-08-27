import { Schema } from "effect"
import type { Shape } from "mag/runtime/vision-shape"

/**
 * The one comparison, applied after `readShape` has already lifted both sides to the same
 * `Shape`. Pure, one consumer, this folder (PRINCIPLES.md's "shared reader, a generic error" test
 * names `vision-shape.ts` as the shared half; this half stays local because nothing else compares
 * two shapes).
 */

/** The three element kinds `Shape` carries, singular: each one's plural is its own `Shape` field. */
const ELEMENTS = ["node", "edge", "condition"] as const

/**
 * Three element kinds crossed with two directions — data, not six branches, and {@link ELEMENTS} is
 * the one source both this list and {@link compare} read.
 */
export const FINDING_KINDS = ELEMENTS.flatMap(
  (element) => [`${element}-absent-from-code`, `${element}-absent-from-vision`] as const
)

export type FindingKind = (typeof FINDING_KINDS)[number]

export interface Finding {
  readonly kind: FindingKind
  readonly name: string
}

/**
 * The `Schema.Literals` shape both `compare-vision/graph-node.ts` and
 * `graphs/code-to-vision-review/graph.ts` declare their `findings` field as — a plain module export,
 * not `graph-node.ts`'s own: that file's node-export conformance rule counts object exports and
 * expects exactly one (`conformance/rules.ts`'s `node-export` rule), and a `Schema.Struct` is an
 * object.
 */
export const FindingSchema = Schema.Struct({ kind: Schema.Literals(FINDING_KINDS), name: Schema.String })

/** Every key in `have` that `lack` never declared — the one primitive both directions of both element kinds share. */
const absentFrom = (have: readonly string[], lack: readonly string[]): readonly string[] => {
  const present = new Set(lack)
  return have.filter((key) => !present.has(key))
}

/**
 * `declared` is the shipped vision's shape, `derived` the blind re-derivation's. A key present in
 * `declared` but not `derived` means the code no longer does what the vision says (`*-absent-from-code`);
 * present in `derived` but not `declared` means the code does something the vision never declared
 * (`*-absent-from-vision`). Direction is kept, never collapsed to a rename match: a renamed node
 * therefore surfaces twice, once absent and once unexpected, which is true and is what the reader
 * needs to see.
 *
 * Two identical shapes produce `[]` — every one of the six differences is empty when both
 * sides agree, so no branch here can invent a finding out of agreement.
 */
export const compare = (declared: Shape, derived: Shape): readonly Finding[] =>
  ELEMENTS.flatMap((element): readonly Finding[] => {
    const field = `${element}s` as const
    return [
      ...absentFrom(declared[field], derived[field]).map((name): Finding => ({
        kind: `${element}-absent-from-code`,
        name
      })),
      ...absentFrom(derived[field], declared[field]).map((name): Finding => ({
        kind: `${element}-absent-from-vision`,
        name
      }))
    ]
  })

/**
 * The findings document's text (`analyse-reviews/report.ts`'s `renderReport` precedent: the first
 * line states the fact a reader needs, a clean pass still gets a file). Grouped by kind so a reader
 * scanning a large divergence sees each element kind's two directions together.
 */
export const renderReport = (visionPath: string, derivedVisionPath: string, findings: readonly Finding[]): string =>
  [
    `Compared ${visionPath} against ${derivedVisionPath}`,
    "",
    findings.length === 0 ? "No divergence — the code draws exactly what the vision declares." : "## Findings",
    ...findings.map((finding) => `- ${finding.kind}: ${finding.name}`)
  ].join("\n")
