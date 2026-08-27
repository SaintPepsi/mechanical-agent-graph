import graphMermaidNotation from "mag/docs/envision/graph-mermaid-notation.md" with { type: "text" }
import { envisionDocBody } from "mag/skills/design/concern"

export interface DeriveVisionParams {
  readonly graphRoot: string
  readonly destination: string
}

/**
 * The blind-derivation dispatch's whole prompt, `mermaid.ts`'s opposite number. The subject is
 * the code at `graphRoot` alone (the session's own working directory is the whole staged copy, so
 * imports still resolve, but what it must draw is the one graph at this path). Splices the notation
 * grammar alone (`graph-mermaid-notation.md`) and never the envisioning discipline document: that
 * document's own instruction is "draw the ideal... the current implementation is banned from the
 * frame" (`graph-mermaid-vision.envision.md`), the literal opposite of what a derivation is asked
 * to do.
 */
export const compileDeriveVision = (params: DeriveVisionParams): string =>
  `Draw the railway the code at \`${params.graphRoot}\` walks, from that code alone, never what it ` +
  `should do.\n\n` +
  envisionDocBody(graphMermaidNotation) +
  `Write the drawing to \`${params.destination}\`.`
